import type MemoryHeap from '@daneren2005/shared-memory-objects/memory-heap';
import type { GrowBufferData } from '@daneren2005/shared-memory-objects/memory-heap';
import type BaseWorld from '../world';
import type BaseEntity from '../entity';
import type { BaseComponent, ComponentDefinitionMap, ComponentMap } from '../component-definition';
import type { ComponentTypedArray } from '../memory-component';
import System, { type SystemConfig } from './system';
import type EntitySystemWorkerMessage from './workers/entity-system-worker-message';
import EntitySystemWebWorker from './workers/entity-system-web-worker';

const MAIN_QUERY_NAME = '___main';

// Runs an update function over the raw shared-memory blocks of its matched entities. Uses getWorker() when
// Web Workers + SharedArrayBuffer exist, else falls back to EntitySystemWebWorker on the main thread. No game
// concepts; games inject per-run data via addDataToWorld.
export default abstract class EntityWorkerSystem<
	C extends ComponentMap,
	T extends EntityUpdateComponents<C>,
	W extends EntityWorkerSystemWorld = EntityWorkerSystemWorld,
	D = unknown,
> extends System<C> {
	entities: Map<number, BaseEntity<C>> = new Map();
	options: EntityWorkerSystemConfig<C, T, W, D>;

	worker: Worker | EntitySystemWebWorker<C, T, W, D>;
	isWorkerThread: boolean;

	private initialized = false;
	private initPromise: Resolvable | null = null;
	private loadingPromise: Resolvable | null = null;
	private runCompletePromise: Resolvable | null = null;
	private isRunning = false;
	// Bumped by clear(); checked on each event to make certain we are dealing with the correct world
	private generation = 0;
	protected queryEntities: { [key: string]: Map<number, BaseEntity<C>> } = {};
	// Membership changes since the last run(), flushed each run as a delta so a steady-state run sends empty
	// arrays rather than re-transmitting every eid. The worker applies these to its own list (see applyQueryDelta).
	private queryDeltas: { [key: string]: MembershipDelta<C> } = {};

	addDataToWorld?(world: W): void;

	constructor(world: BaseWorld<ComponentDefinitionMap, C>, options: EntityWorkerSystemConfig<C, T, W, D>) {
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
			// Forward heap growth so the worker's reconstructed heap can resolve pointers into new buffers.
			world.on('grow-buffer', (buffer: GrowBufferData) => {
				this.worker.postMessage({ type: 'grow-buffer', buffer });
			});
		} else {
			this.worker = new EntitySystemWebWorker(options.updateFunction, world, !!options.createsEntities, !!options.addsComponents);
			this.isWorkerThread = false;
		}

		this.initWorker();
	}

	private initWorker() {
		this.worker.onmessage = (e: MessageEvent) => {
			let message = e.data as EntitySystemWorkerMessage;
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
			} else if(message.type === 'grow-buffer-from-worker') {
				// A buffer this worker grew while allocating: adopt into the main heap and fan out to sibling workers.
				this.world.addGrownBuffer(message.buffer);
			} else if(message.type === 'run-complete') {
				// A reply from a run that started before a clear(): the world it ran over is gone, so drop it whole.
				if(message.generation !== this.generation) {
					return;
				}

				this.isRunning = false;
				this.world.emit(`system-${this.name}-worker-finished`, message.runTime);

				// User-code errors caught inside the run: log + emit on the main thread, one per failure.
				message.errors.forEach(({ error, entityId, phase }) => {
					this.onError(error, { entityId, phase });
				});

				// Structural changes are applied only after the worker has finished iterating its snapshot. Attaching emits
				// the same entity events as a main-thread mutation, which rechecks every affected system/query and queues
				// refreshed component bundles for their next run.
				(message.componentChanges ?? []).forEach(change => {
					const entity = this.world.getEntityByEid(change.entityId);
					if(change.type === 'add') {
						const definition = this.world.registry[change.component.name as keyof C];
						if(!entity || !definition || change.component.name === 'entity') {
							definition?.memoryComponent.delete(change.component.index);
							return;
						}

						const componentName = change.component.name as keyof C;
						entity.removeComponent(componentName);
						entity.attachComponent(componentName, change.component.index, true);
					} else if(entity && change.componentName !== 'entity') {
						entity.removeComponent(change.componentName);
					}
				});

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

				// After deaths, so an entity created this run isn't immediately removed. Adopts the blocks the worker
				// already allocated + wrote, rather than re-creating them.
				message.created.forEach(descriptor => {
					this.world.adoptEntity(descriptor);
				});

				this.world.emit(`system-${this.name}-worker-events-finished`, message.runTime);
				this.world.notifySystemRunCompleted(this);

				if(this.runCompletePromise) {
					this.runCompletePromise.resolve();
					this.runCompletePromise = null;
				}
			}
		};

		const message: EntitySystemWorkerMessage<W, D> = {
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

		const message: EntitySystemWorkerMessage<W, D> = {
			type: 'load',
			data: this.options.getInitData?.(),
			// Only a real worker needs the buffers to rebuild a heap, plus the pools + eid counter to allocate off-thread.
			heap: this.isWorkerThread ? this.world.heap.getSharedMemory() : undefined,
			sharedMemory: this.isWorkerThread ? this.world.getSharedComponentMemory() : undefined,
			// Factory templates only go to workers that create entities.
			factoryConfigs: this.isWorkerThread && this.options.createsEntities ? this.world.factory.configs : undefined,
			factoryClasses: this.isWorkerThread && this.options.createsEntities ? this.world.factory.getWorkerClasses() : undefined,
			addsComponents: !!this.options.addsComponents,
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

		const message: EntitySystemWorkerMessage = { type: 'reset' };
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
		let message: EntitySystemWorkerMessage<W> = {
			type: 'run',
			generation: this.generation,
			world,
			entities,
			queries,
		};
		this.worker.postMessage(message);
	}

	private buildQueryDelta(queryName: string, query: EntityWorkerSystemQuery<C>): QueryDelta<T> {
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
	private buildComponents(entity: BaseEntity<C>, query: EntityWorkerSystemQuery<C>): T {
		const components = {} as T;
		[
			...query.required,
			...query.optional ?? [],
		].forEach(componentName => {
			// Reuse the view cached on the accessor at attach: getBlock allocates a fresh subarray every call and an
			// entity joins many systems, so re-looking it up here per system was a measurable spawn-time cost.
			const block = entity.components[componentName]?.block;
			if(block) {
				components[componentName] = block as T[typeof componentName];
			}
		});

		return components;
	}

	isEntityInSystem(entity: BaseEntity<C>) {
		return this.entities.has(entity.eid);
	}
	protected matchesQuery(entity: BaseEntity<C>, query: EntityWorkerSystemQuery<C>): boolean {
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
	protected updateEntityList(queryName: string, list: Map<number, BaseEntity<C>>, entity: BaseEntity<C>, shouldInclude: boolean) {
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
type EntityUpdateFunctionImpl<C extends ComponentMap, T extends EntityUpdateComponents<C>, W extends EntityWorkerSystemWorld = EntityWorkerSystemWorld> = (
	world: W,
	entityId: number,
	components: T,
	queries: EntityQueryComponents<C>,
	callbacks: EntityWorkerSystemCallbacks<C>,
) => void;
export type EntityUpdateFunction<
	C extends ComponentMap,
	T extends EntityUpdateComponents<C>,
	W extends EntityWorkerSystemWorld = EntityWorkerSystemWorld,
	D = unknown,
> = EntityUpdateFunctionImpl<C, T, W> & {
	preRun?: EntityUpdatePreRunFunction<C, T, W>
	entityRemoved?: EntityRemovedFunction<C, W>
	init?: EntityUpdateInitFunction<W, D>
};
export type EntityUpdateInitFunction<W extends EntityWorkerSystemWorld = EntityWorkerSystemWorld, D = unknown> = (data: D | undefined) => Partial<W> | void;
export type EntityUpdatePreRunFunction<C extends ComponentMap, T extends EntityUpdateComponents<C>, W extends EntityWorkerSystemWorld = EntityWorkerSystemWorld> = (
	world: W,
	entities: Array<UpdateEntityConfigObject<T>>,
	queries: EntityQueryComponents<C>,
	callbacks: EntityWorkerSystemCallbacks<C>,
) => void;
export type EntityRemovedFunction<C extends ComponentMap = ComponentMap, W extends EntityWorkerSystemWorld = EntityWorkerSystemWorld> = (
	world: W,
	entityId: number,
	callbacks: EntityWorkerSystemCallbacks<C>,
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

// Low-level off-thread allocation primitives, injected onto the worker `world` each run. `allocateEid` mints a
// heap-unique id; `allocateComponentBlock` pushes a block into a component's shared pool and returns its index.
// These are the foundation a future worker-side createEntity builds on (allocate + write blocks, then report the
// eid/indexes back for the main thread to adopt).
export interface WorkerAllocator {
	allocateEid(): number
	allocateComponentBlock(name: string, values: Array<number>): number
}

export interface EntityWorkerSystemWorld {
	gameTime: number
	elapsedTime: number
	getString(pointer: number): string
	// The reconstructed heap (real worker) or the shared main-thread heap (fallback), injected each run so an
	// update function can rebuild heap-backed structures (a SharedMap/SharedList) from a pointer in a component
	// block. Undefined only before the first run.
	heap?: MemoryHeap
	allocate?: WorkerAllocator
	// Injected each run on a system registered with createsEntities: builds a WorkerCreatedEntity descriptor from a
	// factory config (merges the type's template, allocates + writes each component's block). Drives createEntityWorker.
	buildEntityDescriptor?(config: WorkerCreateEntityConfig): WorkerCreatedEntity
	// Injected for systems with addsComponents. Allocates/writes a block off-thread; the main thread attaches it
	// after run completion so no running update observes a changing component set.
	buildComponentDescriptor?(name: string, config: Record<string, unknown>): WorkerCreatedComponent
}
// What a game passes to createEntityWorker: a factory-style config - the entity `type` plus any overrides layered
// over that type's factory template. The worker merges template + overrides, then allocates + writes each triggered
// component's block off-thread via the component's toBlock(config). The "entity" component is built on the main
// thread when the descriptor is adopted, since interning the type is main-thread-only.
export type WorkerCreateEntityConfig = { type: string, class?: never } & { [key: string]: unknown };
// The result reported back on run-complete: the minted id plus, per game component, the pool index the worker
// allocated. world.adoptEntity turns this into a real BaseEntity.
export interface WorkerCreatedEntity {
	eid: number
	type: string
	class?: string
	isStatic?: boolean
	components: { [name: string]: number }
}

export interface WorkerCreatedComponent {
	name: string
	index: number
}

export type WorkerComponentChange =
	| { type: 'add', entityId: number, component: WorkerCreatedComponent }
	| { type: 'remove', entityId: number, componentName: string };

export interface EntityWorkerSystemCallbacks<C extends ComponentMap = ComponentMap> {
	entityComponentChanged<K extends keyof C, P extends keyof C[K]>(entityId: number, componentName: K, prop: P, value: C[K][P]): void
	// Args are structured-cloned, so plain values only.
	emitEntityEvent(entityId: number, event: string, ...args: Array<unknown>): void
	// Emitted **on the system** with all its ids in one array. The allocation-free path for something that
	// happens to most entities every run; carries no args (values are already in shared memory).
	emitSystemEvent(event: string, entityId: number): void
	entityDied(entityId: number): void
	createEntity(entity: WorkerCreatedEntity): void
	addComponent(entityId: number, component: WorkerCreatedComponent): void
	removeComponent<K extends keyof C>(entityId: number, componentName: K): void
}

export interface EntityWorkerSystemQuery<C extends ComponentMap = ComponentMap> {
	required: Array<keyof C>
	optional?: Array<keyof C>
	not?: Array<keyof C>
	filter?: (entity: BaseEntity<C>) => boolean
}

export interface EntityWorkerSystemConfig<
	C extends ComponentMap,
	T extends EntityUpdateComponents<C>,
	W extends EntityWorkerSystemWorld = EntityWorkerSystemWorld,
	D = unknown,
> extends SystemConfig, EntityWorkerSystemQuery<C> {
	updateFunction: EntityUpdateFunction<C, T, W, D>
	getWorker: () => Worker
	forceMainThread?: boolean
	getInitData?: () => D
	// Opt in to worker-side entity creation (createEntityWorker). When set, factory templates and serializable class
	// allowlists are shipped to this system's worker; the worker entry must also pass the component registry to
	// createEntitySystemWorker so it has each component's toBlock(). Only systems that create entities need either.
	createsEntities?: boolean
	// Opt in to worker-side component allocation through addComponentWorker. The worker entry must also pass the
	// component registry to createEntitySystemWorker so the worker has each component's toBlock().
	addsComponents?: boolean

	queries?: { [key: string]: EntityWorkerSystemQuery<C> }
}

export type { BaseComponent };
