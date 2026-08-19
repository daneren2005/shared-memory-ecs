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
	D = unknown,
> extends System<C> {
	entities: Map<number, BaseEntity<C>> = new Map();
	options: ComponentSystemConfig<C, T, W, D>;

	worker: Worker | ComponentWebWorker<C, T, W, D>;
	isWorkerThread: boolean;

	private initialized = false;
	private initPromise: Resolvable | null = null;
	private loadingPromise: Resolvable | null = null;
	private runCompletePromise: Resolvable | null = null;
	private isRunning = false;
	// Bumped by clear(); checked on each event to make certain we are dealing with the correct world
	private generation = 0;
	private queryEntities: { [key: string]: Map<number, BaseEntity<C>> } = {};
	// Membership changes since the last run(), flushed each run as a delta so a steady-state run sends empty
	// arrays rather than re-transmitting every eid. The worker applies these to its own list (see applyQueryDelta).
	private queryDeltas: { [key: string]: MembershipDelta<C> } = {};

	addDataToWorld?(world: W): void;

	constructor(world: BaseWorld<ComponentDefinitionMap, C>, options: ComponentSystemConfig<C, T, W, D>) {
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
			if(message.type === 'init-complete') {
				this.initialized = true;
				if(this.initPromise) {
					this.initPromise.resolve();
					this.initPromise = null;
				}
			} else if(message.type === 'loaded') {
				if(this.loadingPromise) {
					this.loadingPromise.resolve();
					this.loadingPromise = null;
				}
			} else if(message.type === 'run-complete') {
				// A reply from a run that started before a clear(): the world it ran over is gone, so drop it whole.
				if(message.generation !== this.generation) {
					return;
				}

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
				this.world.notifySystemRunCompleted(this);

				if(this.runCompletePromise) {
					this.runCompletePromise.resolve();
					this.runCompletePromise = null;
				}
			}
		};

		const message: ComponentWorkerMessage<W, D> = {
			type: 'init',
		};

		this.worker.postMessage(message);
	}

	init(): Promise<void> | void {
		if(this.initialized) {
			return;
		} else if(this.initPromise) {
			return this.initPromise.promise;
		}

		let { promise, resolve } = Promise.withResolvers<void>();
		this.initPromise = {
			promise,
			resolve,
		};
		return promise;
	}

	// Sends the init data over and runs the update function's own init in the worker
	finishLoading(): Promise<void> {
		let { promise, resolve } = Promise.withResolvers<void>();
		// Assigned before posting: the main-thread fallback replies synchronously from inside postMessage.
		this.loadingPromise = {
			promise,
			resolve,
		};

		const message: ComponentWorkerMessage<W, D> = {
			type: 'load',
			data: this.options.getInitData?.(),
		};
		this.worker.postMessage(message);

		return promise;
	}

	// Un-initializes the system so its world can be reused
	clear() {
		super.clear();

		if(this.isRunning) {
			if(!this.runCompletePromise) {
				const { promise, resolve } = Promise.withResolvers<void>();
				this.runCompletePromise = { promise, resolve };
			}
		}
		this.isRunning = false;
		this.generation++;

		this.entities.clear();
		Object.values(this.queryEntities).forEach(list => list.clear());
		this.queryDeltas = {};

		const message: ComponentWorkerMessage = { type: 'reset' };
		this.worker.postMessage(message);
	}

	update(elapsedTime: number): boolean {
		if(this.isRunning) {
			this.currentDelta += elapsedTime;

			return false;
		} else {
			return super.update(elapsedTime);
		}
	}
	// A run finishes off-thread, not when update() returns; completedRuns is bumped on the worker's run-complete.
	protected onRunFinished() {}
	isCurrentlyRunning(): boolean {
		return this.isRunning;
	}
	waitForRunToComplete(): void | Promise<void> {
		if(!this.isRunning) {
			return;
		}
		if(!this.runCompletePromise) {
			const { promise, resolve } = Promise.withResolvers<void>();
			this.runCompletePromise = { promise, resolve };
		}
		return this.runCompletePromise.promise;
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
			generation: this.generation,
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

	// Re-evaluates every entity's membership against the current queries. Needed when a `filter` closes over mutable
	// state (e.g. a scope keyed on which group is active) and that state changes with no entity event to react to
	recheckMembership() {
		this.world.entities.forEach(entity => {
			this.checkAddEntity(entity);
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

interface Resolvable {
	promise: Promise<void>
	resolve: (value: void | PromiseLike<void>) => void
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
export type EntityUpdateFunction<
	C extends ComponentMap,
	T extends EntityUpdateComponents<C>,
	W extends ComponentSystemWorld = ComponentSystemWorld,
	D = unknown,
> = EntityUpdateFunctionImpl<C, T, W> & {
	preRun?: EntityUpdatePreRunFunction<C, T, W>
	entityRemoved?: EntityRemovedFunction<C, W>
	init?: EntityUpdateInitFunction<W, D>
};
export type EntityUpdateInitFunction<W extends ComponentSystemWorld = ComponentSystemWorld, D = unknown> = (data: D | undefined) => Partial<W> | void;
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
	D = unknown,
> extends SystemConfig, ComponentSystemQuery<C> {
	updateFunction: EntityUpdateFunction<C, T, W, D>
	getWorker: () => Worker
	forceMainThread?: boolean
	getInitData?: () => D

	queries?: { [key: string]: ComponentSystemQuery<C> }
}

export type { BaseComponent };
