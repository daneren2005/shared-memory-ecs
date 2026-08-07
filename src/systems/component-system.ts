import type BaseWorld from '../world';
import type BaseEntity from '../entity';
import type { BaseComponent, ComponentDefinitionMap, ComponentMap, RegisteredComponentRegistry } from '../component-definition';
import type { ComponentTypedArray } from '../memory-component';
import System, { type SystemConfig } from './system';
import type ComponentWorkerMessage from './workers/component-worker-message';
import ComponentWebWorker from './workers/component-web-worker';

const MAIN_QUERY_NAME = '___main';

// Runs an update function over the raw shared-memory blocks of its matched entities. Uses getWorker() when
// Web Workers + SharedArrayBuffer exist, else falls back to ComponentWebWorker on the main thread. No game
// concepts; games inject per-run data via addDataToWorld.
export default abstract class ComponentSystem<
	C extends ComponentMap,
	T extends EntityUpdateComponents<C>,
	W extends ComponentSystemWorld = ComponentSystemWorld,
> extends System<C> {
	entities: Map<number, BaseEntity<C>> = new Map();
	options: ComponentSystemConfig<C, T, W>;

	worker: Worker | ComponentWebWorker<C, T, W>;
	isWorkerThread: boolean;

	private loaded = false;
	private loadingPromise: { promise: Promise<void>, resolve: (value: void | PromiseLike<void>) => void } | null = null;
	private isRunning = false;
	private queryEntities: { [key: string]: Map<number, BaseEntity<C>> } = {};
	// Membership changes since the last run(), flushed each run as a delta so a steady-state run sends empty
	// arrays rather than re-transmitting every eid. The worker applies these to its own list (see applyQueryDelta).
	private queryDeltas: { [key: string]: MembershipDelta<C> } = {};

	addDataToWorld?(world: W): void;

	constructor(world: BaseWorld<ComponentDefinitionMap, C>, options: ComponentSystemConfig<C, T, W>) {
		super(world, options);
		this.options = options;
		Object.keys(this.options.queries ?? {}).forEach(queryName => {
			this.queryEntities[queryName] = new Map();
		});

		world.on('entity-added', (entity: BaseEntity<C>) => {
			this.checkAddEntity(entity);
		});
		world.on('entity-removed', (entity: BaseEntity<C>) => {
			this.removeEntity(entity);
		});

		world.entities.forEach(entity => {
			this.checkAddEntity(entity);
		});

		if(!options.forceMainThread && typeof globalThis.Worker !== 'undefined' && typeof globalThis.SharedArrayBuffer !== 'undefined') {
			this.worker = options.getWorker();
			this.isWorkerThread = true;
		} else {
			this.worker = new ComponentWebWorker(options.updateFunction);
			this.isWorkerThread = false;
		}

		this.initWorker();
	}

	private initWorker() {
		this.worker.onmessage = (e: MessageEvent) => {
			let message = e.data as ComponentWorkerMessage;
			if(message.type === 'loaded') {
				this.loaded = true;
				if(this.loadingPromise) {
					this.loadingPromise.resolve();
					this.loadingPromise = null;
				}
			} else if(message.type === 'run-complete') {
				this.isRunning = false;
				this.world.emit(`system-${this.name}-worker-finished`, message.runTime);

				// Before the per-entity events: an entity killed this run is still in the world here, since `death`
				// is dispatched below and removes it.
				for(const event of Object.keys(message.systemEvents)) {
					this.emit(event, message.systemEvents[event]);
				}

				message.events.forEach(event => {
					// Look up on the world, not the query cache, so events for sub-query-only entities still route.
					const entity = this.world.getEntityByEid(event.entityId);
					if(!entity) {
						console.warn(`${this.name}-event ${event.event}: Could not find entity with id ${event.entityId}`);
						return;
					}

					entity.emit(event.event, ...event.args);
				});

				// After deaths, so an entity created this run isn't immediately removed.
				message.created.forEach(config => {
					this.world.loadEntity(config);
				});

				this.world.emit(`system-${this.name}-worker-events-finished`, message.runTime);
			}
		};

		const message: ComponentWorkerMessage = {
			type: 'init',
		};

		this.worker.postMessage(message);
	}

	init(): Promise<void> | void {
		if(this.loaded) {
			return;
		} else if(this.loadingPromise) {
			return this.loadingPromise.promise;
		}

		let { promise, resolve } = Promise.withResolvers<void>();
		this.loadingPromise = {
			promise,
			resolve,
		};
		return promise;
	}

	update(elapsedTime: number): boolean {
		if(this.isRunning) {
			this.currentDelta += elapsedTime;

			return false;
		} else {
			return super.update(elapsedTime);
		}
	}
	run(elapsedTime: number): void {
		const world = {
			gameTime: this.world.gameTime,
			elapsedTime,
		} as W;
		this.addDataToWorld?.(world);

		this.isRunning = true;
		let entities = this.buildQueryDelta(MAIN_QUERY_NAME, this.options);
		let queries: { [key: string]: QueryDelta<T> } = {};
		Object.entries(this.options.queries ?? {}).forEach(([queryKey, query]) => {
			queries[queryKey] = this.buildQueryDelta(queryKey, query);
		});
		let message: ComponentWorkerMessage<W> = {
			type: 'run',
			world,
			entities,
			queries,
		};
		this.worker.postMessage(message);
	}

	private buildQueryDelta(queryName: string, query: ComponentSystemQuery<C>): QueryDelta<T> {
		const delta = this.getQueryDelta(queryName);
		const added: Array<UpdateEntityConfigObject<T>> = [];
		delta.added.forEach(entity => {
			added.push({
				entityId: entity.eid,
				components: this.buildComponents(entity, query),
			});
		});
		const removed = Array.from(delta.removed);
		this.queryDeltas[queryName] = { added: new Set(), removed: new Set() };

		return { added, removed };
	}
	private buildComponents(entity: BaseEntity<C>, query: ComponentSystemQuery<C>): T {
		const components = {} as T;
		const registry = this.world.registry as RegisteredComponentRegistry<C>;
		[
			...query.required,
			...query.optional ?? [],
		].forEach(componentName => {
			const component = entity.components[componentName];
			const memoryComponent = registry[componentName].memoryComponent;
			if(component && memoryComponent) {
				components[componentName] = memoryComponent.getBlock(component.index) as T[typeof componentName];
			}
		});

		return components;
	}

	isEntityInSystem(entity: BaseEntity<C>) {
		return this.entities.has(entity.eid);
	}
	private matchesQuery(entity: BaseEntity<C>, query: ComponentSystemQuery<C>): boolean {
		if(entity.components.entity.dead) {
			return false;
		}

		if(query.required.find(component => !entity.components[component])) {
			return false;
		}
		if(query.not?.find(component => !!entity.components[component])) {
			return false;
		}
		if(query.filter && !query.filter(entity)) {
			return false;
		}

		return true;
	}
	private getQueryDelta(queryName: string): MembershipDelta<C> {
		let delta = this.queryDeltas[queryName];
		if(!delta) {
			delta = this.queryDeltas[queryName] = { added: new Set(), removed: new Set() };
		}

		return delta;
	}
	// A pending removal this same frame is cancelled, so the net effect is a re-send rather than remove+add churn.
	private markAdded(delta: MembershipDelta<C>, entity: BaseEntity<C>) {
		delta.removed.delete(entity.eid);
		delta.added.add(entity);
	}
	private markRemoved(delta: MembershipDelta<C>, entity: BaseEntity<C>) {
		if(delta.added.delete(entity)) {
			return;
		}

		delta.removed.add(entity.eid);
	}
	private updateEntityList(queryName: string, list: Map<number, BaseEntity<C>>, entity: BaseEntity<C>, shouldInclude: boolean) {
		const delta = this.getQueryDelta(queryName);
		if(shouldInclude) {
			list.set(entity.eid, entity);
			this.markAdded(delta, entity);
		} else if(list.delete(entity.eid)) {
			this.markRemoved(delta, entity);
		}
	}

	checkAddEntity(entity: BaseEntity<C>): boolean {
		const shouldAddToMain = this.matchesQuery(entity, this.options);
		this.updateEntityList(MAIN_QUERY_NAME, this.entities, entity, shouldAddToMain);

		Object.entries(this.options.queries ?? {}).forEach(([queryName, query]) => {
			const queryList = this.queryEntities[queryName] ?? (this.queryEntities[queryName] = new Map());
			this.updateEntityList(queryName, queryList, entity, this.matchesQuery(entity, query));
		});

		return shouldAddToMain;
	}
	removeEntity(entity: BaseEntity<C>) {
		this.updateEntityList(MAIN_QUERY_NAME, this.entities, entity, false);
		Object.entries(this.queryEntities).forEach(([queryName, list]) => {
			this.updateEntityList(queryName, list, entity, false);
		});
	}

	shouldRun(): boolean {
		return this.entities.size > 0;
	}

	destroy() {
		super.destroy();

		if('terminate' in this.worker) {
			this.worker.terminate();
		}
	}
}

export type EntityUpdateComponents<C extends ComponentMap = ComponentMap> = { [K in keyof C]?: ComponentTypedArray };
export type EntityQueryComponents<C extends ComponentMap = ComponentMap> = { [key: string]: Array<{ entityId: number, components: EntityUpdateComponents<C> }> };
type EntityUpdateFunctionImpl<C extends ComponentMap, T extends EntityUpdateComponents<C>, W extends ComponentSystemWorld = ComponentSystemWorld> = (
	world: W,
	entityId: number,
	components: T,
	queries: EntityQueryComponents<C>,
	callbacks: ComponentSystemCallbacks<C>,
) => void;
export type EntityUpdateFunction<C extends ComponentMap, T extends EntityUpdateComponents<C>, W extends ComponentSystemWorld = ComponentSystemWorld> = EntityUpdateFunctionImpl<C, T, W> & {
	preRun?: EntityUpdatePreRunFunction<C, T, W>
	entityRemoved?: EntityRemovedFunction<C, W>
};
export type EntityUpdatePreRunFunction<C extends ComponentMap, T extends EntityUpdateComponents<C>, W extends ComponentSystemWorld = ComponentSystemWorld> = (
	world: W,
	entities: Array<UpdateEntityConfigObject<T>>,
	queries: EntityQueryComponents<C>,
	callbacks: ComponentSystemCallbacks<C>,
) => void;
export type EntityRemovedFunction<C extends ComponentMap = ComponentMap, W extends ComponentSystemWorld = ComponentSystemWorld> = (
	world: W,
	entityId: number,
	callbacks: ComponentSystemCallbacks<C>,
) => void;
export type UpdateEntityConfig<T extends EntityUpdateComponents = EntityUpdateComponents> = number | UpdateEntityConfigObject<T>;
export type UpdateEntityConfigObject<T extends EntityUpdateComponents> = {
	entityId: number
	components: T
};

export interface QueryDelta<T extends EntityUpdateComponents = EntityUpdateComponents> {
	added: Array<UpdateEntityConfigObject<T>>
	removed: Array<number>
}
// Sets so queuing can check for an already-queued or opposite change without scanning a growing array.
interface MembershipDelta<C extends ComponentMap> {
	added: Set<BaseEntity<C>>
	removed: Set<number>
}

export interface ComponentSystemWorld {
	gameTime: number
	elapsedTime: number
}
export type CreateEntityConfig = Record<string, unknown>;

export interface ComponentSystemCallbacks<C extends ComponentMap = ComponentMap> {
	entityComponentChanged<K extends keyof C, P extends keyof C[K]>(entityId: number, componentName: K, prop: P, value: C[K][P]): void
	// Args are structured-cloned, so plain values only.
	emitEntityEvent(entityId: number, event: string, ...args: Array<unknown>): void
	// Emitted **on the system** with all its ids in one array. The allocation-free path for something that
	// happens to most entities every run; carries no args (values are already in shared memory).
	emitSystemEvent(event: string, entityId: number): void
	entityDied(entityId: number): void
	createEntity(config: CreateEntityConfig): void
}

export interface ComponentSystemQuery<C extends ComponentMap = ComponentMap> {
	required: Array<keyof C>
	optional?: Array<keyof C>
	not?: Array<keyof C>
	filter?: (entity: BaseEntity<C>) => boolean
}

export interface ComponentSystemConfig<
	C extends ComponentMap,
	T extends EntityUpdateComponents<C>,
	W extends ComponentSystemWorld = ComponentSystemWorld,
> extends SystemConfig, ComponentSystemQuery<C> {
	updateFunction: EntityUpdateFunction<C, T, W>
	getWorker: () => Worker
	forceMainThread?: boolean

	queries?: { [key: string]: ComponentSystemQuery<C> }
}

export type { BaseComponent };
