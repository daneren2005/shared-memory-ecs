import type BaseWorld from '../world';
import type BaseEntity from '../entity';
import type { BaseComponent, ComponentDefinitionMap, ComponentMap, RegisteredComponentRegistry } from '../component-definition';
import type { ComponentTypedArray } from '../memory-component';
import System, { type SystemConfig } from './system';
import type ComponentWorkerMessage from './workers/component-worker-message';
import ComponentWebWorker from './workers/component-web-worker';

const MAIN_QUERY_NAME = '___main';

// Runs an update function over the raw shared-memory blocks of its matched entities, ideally on a
// separate thread.  When Web Workers + SharedArrayBuffer are available the work happens on `getWorker()`;
// otherwise it falls back to running synchronously on the main thread via ComponentWebWorker.
//
// This is deliberately free of any game concepts (no factions, fog of war, position, etc).  Games
// inject whatever extra per-run data they need through `addDataToWorld`.
export default abstract class ComponentSystem<
	C extends ComponentMap,
	T extends EntityUpdateComponents<C>,
	W extends ComponentSystemWorld = ComponentSystemWorld,
> extends System<C> {
	entities: Array<BaseEntity<C>> = [];
	options: ComponentSystemConfig<C, T, W>;

	worker: Worker | ComponentWebWorker<C, T, W>;
	isWorkerThread: boolean;

	private loaded = false;
	private loadingPromise: { promise: Promise<void>, resolve: (value: void | PromiseLike<void>) => void } | null = null;
	private isRunning = false;
	private queryEntities: { [key: string]: Array<BaseEntity<C>> } = {};
	// Per-query membership changes accumulated since the last run().  Each run() flushes these to the worker as a
	// delta - added entities carry their component blocks, removed carry just their eid - so a steady-state run
	// (unchanged membership) sends empty arrays instead of re-transmitting every entity id every single frame.
	// The worker keeps its own persistent list and applies these deltas to it (see applyQueryDelta).
	private queryDeltas: { [key: string]: MembershipDelta<C> } = {};

	// Optional hook for subclasses to attach extra data to the world object sent to the worker.  Subclasses
	// declare the concrete shape through `W` and fill in its fields here.
	addDataToWorld?(world: W): void;

	constructor(world: BaseWorld<ComponentDefinitionMap, C>, options: ComponentSystemConfig<C, T, W>) {
		super(world, options);
		this.options = options;
		Object.keys(this.options.queries ?? {}).forEach(queryName => {
			this.queryEntities[queryName] = [];
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
				if(this.isWorkerThread) {
					this.world.emit(`system-${this.name}-worker-finished`, message.runTime);
				}

				message.events.forEach(event => {
					// A system can report events (deaths, component changes) for entities it only knows through a
					// sub-query - e.g. a collision system that kills a station it found in a spatial query but that
					// isn't in its main query.  Look the entity up on the world so those still route even when the
					// entity was never part of this system's main query cache.
					const entity = this.world.getEntityByEid(event.entityId);
					if(!entity) {
						console.warn(`Could not find entity with id ${event.entityId}`);
						return;
					}

					entity.emit(event.event, ...event.args);
				});

				// Fulfill any creation requests after deaths, so an entity created this run isn't immediately removed.
				// loadEntity runs the full factory expansion + finishLoading and emits `entity-added`, so every system
				// (including this one) picks the new entity up on the next run.
				message.created.forEach(config => {
					this.world.loadEntity(config);
				});

				if(this.isWorkerThread) {
					this.world.emit(`system-${this.name}-worker-events-finished`, message.runTime);
				}
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
		// Only run worker if the last run completed already
		if(this.isRunning) {
			this.currentDelta += elapsedTime;

			return false;
		} else {
			return super.update(elapsedTime);
		}
	}
	run(elapsedTime: number): void {
		// gameTime + elapsedTime are the only fields the base guarantees; addDataToWorld fills in the rest of `W`,
		// so the literal is built as the base shape and widened to W for that hook to complete.
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

	// Flushes the pending membership changes for a query into the delta the worker applies to its persistent
	// list.  Added entities are resolved to their shared-memory component blocks here (the only per-frame cost
	// left, and only for entities that actually joined/changed); removed entities are sent as bare eids.  The
	// buffers are reset so the next run only carries what changed since this one.
	private buildQueryDelta(queryName: string, query: ComponentSystemQuery<C>): QueryDelta<T> {
		const delta = this.getQueryDelta(queryName);
		const added = delta.added.map(entity => ({
			entityId: entity.eid,
			components: this.buildComponents(entity, query),
		}));
		const removed = delta.removed;
		this.queryDeltas[queryName] = { added: [], removed: [] };

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
		return this.entities.indexOf(entity) !== -1;
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
			delta = this.queryDeltas[queryName] = { added: [], removed: [] };
		}

		return delta;
	}
	// Records that an entity now belongs to a query, so the next run() sends its (possibly changed) component
	// blocks.  An entity queued for removal this same frame is un-queued instead: the worker never learned it
	// left, so the net effect is a re-send of fresh components rather than a remove+add churn.
	private markAdded(delta: MembershipDelta<C>, entity: BaseEntity<C>) {
		const removedIndex = delta.removed.indexOf(entity.eid);
		if(removedIndex !== -1) {
			delta.removed.splice(removedIndex, 1);
		}
		if(delta.added.indexOf(entity) === -1) {
			delta.added.push(entity);
		}
	}
	// Records that an entity left a query.  If it was only queued to be added this same frame (never sent to the
	// worker), we just drop the pending add - the worker never knew about it, so there is nothing to remove.
	private markRemoved(delta: MembershipDelta<C>, entity: BaseEntity<C>) {
		const addedIndex = delta.added.indexOf(entity);
		if(addedIndex !== -1) {
			delta.added.splice(addedIndex, 1);
			return;
		}
		if(delta.removed.indexOf(entity.eid) === -1) {
			delta.removed.push(entity.eid);
		}
	}
	private updateEntityList(queryName: string, list: Array<BaseEntity<C>>, entity: BaseEntity<C>, shouldInclude: boolean) {
		const index = list.indexOf(entity);
		const delta = this.getQueryDelta(queryName);
		if(shouldInclude) {
			if(index === -1) {
				list.push(entity);
			}
			// Always (re)queue the component blocks: the entity either just joined or a relevant component was
			// added/removed, so the blocks the worker holds for it may be stale.
			this.markAdded(delta, entity);
		} else if(index !== -1) {
			list.splice(index, 1);
			this.markRemoved(delta, entity);
		}
	}

	checkAddEntity(entity: BaseEntity<C>): boolean {
		const shouldAddToMain = this.matchesQuery(entity, this.options);
		this.updateEntityList(MAIN_QUERY_NAME, this.entities, entity, shouldAddToMain);

		Object.entries(this.options.queries ?? {}).forEach(([queryName, query]) => {
			const queryList = this.queryEntities[queryName] ?? (this.queryEntities[queryName] = []);
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
		return this.entities.length > 0;
	}

	destroy() {
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
// `T` is required (no default) so every update function must spell out exactly which components it operates on
// and their concrete typed arrays, rather than falling back to the full component list.  `W` is the concrete
// per-run world shape the owning system builds in addDataToWorld; it defaults to the bare ComponentSystemWorld.
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

// The membership changes for a single query since the last run, in the shape sent to the worker: entities that
// joined (or whose component set changed) with their resolved component blocks, and the eids of entities that
// left.  Empty on a steady-state run, which is what keeps the per-frame postMessage small.
export interface QueryDelta<T extends EntityUpdateComponents = EntityUpdateComponents> {
	added: Array<UpdateEntityConfigObject<T>>
	removed: Array<number>
}
// The main thread's pre-serialization form of a QueryDelta: it holds the live entities (so their component
// blocks can be resolved lazily at run time), whereas QueryDelta holds the resolved blocks that cross the wire.
interface MembershipDelta<C extends ComponentMap> {
	added: Array<BaseEntity<C>>
	removed: Array<number>
}

// Base per-run world data.  gameTime + elapsedTime are always present; games attach anything else
// they need via addDataToWorld, declaring the concrete shape through the `W` type parameter that
// ComponentSystem (and its update function) are generic over.
export interface ComponentSystemWorld {
	gameTime: number
	elapsedTime: number
}
// A flat entity config a worker asks the main thread to create.  Kept as a plain record (not the game's `Cfg`)
// because ComponentSystem is generic over `C`, not `Cfg`; the main thread hands it straight to world.loadEntity,
// whose factory expands its `type` against the registered templates.
export type CreateEntityConfig = Record<string, unknown>;

export interface ComponentSystemCallbacks<C extends ComponentMap = ComponentMap> {
	entityComponentChanged<K extends keyof C, P extends keyof C[K]>(entityId: number, componentName: K, prop: P, value: C[K][P]): void
	entityDied(entityId: number): void
	// Requests that the main thread create an entity from `config` once the run completes.  Unlike killing (which
	// flips an existing shared-memory flag in place), creation can't happen in the worker, so it is deferred to the
	// main thread where eid generation, allocation, and factory expansion already live.
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

// Re-exported so BaseComponent is reachable from the systems barrel if needed.
export type { BaseComponent };
