import MemoryHeap from '@daneren2005/shared-memory-objects/memory-heap';
import type AllocatedMemory from '@daneren2005/shared-memory-objects/allocated-memory';
import type ComponentWorkerMessage from './component-worker-message';
import type { EntityEvent, SystemEvents } from './component-worker-message';
import ConstantStringCache from '../../constant-string-cache';
import MemoryComponent from '../../memory-component';
import type { ComponentDefinitionMap, ComponentMap } from '../../component-definition';
import type {
	ComponentSystemCallbacks, ComponentSystemWorld, EntityQueryComponents, EntityUpdateComponents,
	EntityUpdateFunction, QueryDelta, UpdateEntityConfigObject, WorkerCreatedEntity,
} from '../component-system';
import { buildWorkerEntity, type FactoryConfigs } from '../../actions/build-worker-entity';
import { applyQueryDelta } from './apply-query-delta';

// The slice of the worker global scope createComponentWorker touches. Passing `self` explicitly (rather than
// using the global) lets runners like @vitest/web-worker, which inject `self` as a module local, drive it.
export interface ComponentWorkerScope {
	onmessage: ((e: MessageEvent) => void) | null
	postMessage(message: ComponentWorkerMessage): void
}

export default function createComponentWorker<
	C extends ComponentMap,
	T extends EntityUpdateComponents<C>,
	W extends ComponentSystemWorld = ComponentSystemWorld,
	D = unknown,
>(scope: ComponentWorkerScope, updateFunction: EntityUpdateFunction<C, T, W, D>, definitions?: ComponentDefinitionMap) {
	// Persistent lists, carried across runs and mutated by each run's delta (see applyQueryDelta).
	let entities: Array<UpdateEntityConfigObject<T>> = [];
	const queryEntities: { [key: string]: Array<UpdateEntityConfigObject<T>> } = {};
	// What updateFunction.init returned: persistent state (e.g. a seeded RNG) merged onto `world` each run.
	let worldExtension: Partial<W> | undefined;
	let heap: MemoryHeap | undefined;
	let stringCache: ConstantStringCache | undefined;
	// Reconstructed pool handles over the world's shared state, plus the factory templates - for off-thread entity
	// allocation. `definitions` (passed by the game's worker entry) supplies each component's toBlock/loadProperties.
	let pools: { [name: string]: MemoryComponent } = {};
	let eidCounter: AllocatedMemory | undefined;
	let factoryConfigs: FactoryConfigs | undefined;
	const getString = (pointer: number): string => stringCache?.getString(pointer) ?? '';

	scope.onmessage = function(e) {
		const message = e.data as ComponentWorkerMessage<W, D>;

		if(message.type === 'init') {
			postMessageTyped(scope, {
				type: 'init-complete',
			});
		} else if(message.type === 'load') {
			if(message.heap) {
				heap = new MemoryHeap(message.heap);
				stringCache = new ConstantStringCache(heap);
				// Report any buffer this worker grows (while allocating off-thread) back to the main thread, which adopts
				// it and fans it out to sibling workers.
				heap.addOnGrowBufferHandlers(buffer => postMessageTyped(scope, { type: 'grow-buffer-from-worker', buffer }));
			}
			if(heap && message.sharedMemory) {
				pools = {};
				for(const name of Object.keys(message.sharedMemory.components)) {
					pools[name] = MemoryComponent.fromSharedMemory(heap, message.sharedMemory.components[name]);
				}
				eidCounter = heap.getSharedAlloc(message.sharedMemory.eidCounter);
			}
			factoryConfigs = message.factoryConfigs;
			worldExtension = updateFunction.init?.(message.data) ?? undefined;
			postMessageTyped(scope, {
				type: 'loaded',
			});
		} else if(message.type === 'grow-buffer') {
			// Never replace a buffer this worker already holds: the main thread fans a worker-grown buffer back out to
			// every worker (including the one that grew it), and overwriting our own live MemoryBuffer would discard its
			// allocation bookkeeping. The SharedArrayBuffer at that position is already the same one.
			if(heap && heap.buffers[message.buffer.bufferPosition] === undefined) {
				heap.addSharedBuffer(message.buffer);
			}
		} else if(message.type === 'reset') {
			// Drop the persistent lists so a reused world starts empty; worldExtension is refreshed by the next load.
			entities = [];
			for(const key of Object.keys(queryEntities)) {
				delete queryEntities[key];
			}
			worldExtension = undefined;
		} else if(message.type === 'run') {
			if(worldExtension) {
				Object.assign(message.world, worldExtension);
			}
			message.world.getString = getString;
			const allocator = {
				allocateEid: () => eidCounter ? Atomics.add(eidCounter.data, 0, 1) + 1 : 0,
				allocateComponentBlock: (name: string, values: Array<number>) => pools[name].create(values),
			};
			message.world.allocate = allocator;
			// Only a system registered with createsEntities (factoryConfigs shipped) whose worker entry passed the
			// component definitions can create entities from a config.
			if(factoryConfigs && definitions) {
				message.world.buildEntityDescriptor = config => buildWorkerEntity(config, factoryConfigs!, definitions, allocator);
			}
			const start = performance.now();
			let entityEvents: Array<EntityEvent> = [];
			let systemEvents: SystemEvents = {};
			let createdEntities: Array<WorkerCreatedEntity> = [];

			entities = applyQueryDelta(entities, message.entities as QueryDelta<T>);

			let queries: EntityQueryComponents<C> = {};
			Object.entries(message.queries).forEach(([queryKey, delta]) => {
				const list = applyQueryDelta(queryEntities[queryKey] ?? [], delta as QueryDelta<T>);
				queryEntities[queryKey] = list;
				queries[queryKey] = list;
			});

			let callbacks: ComponentSystemCallbacks<C> = {
				entityComponentChanged<K extends keyof C, P extends keyof C[K]>(entityId: number, componentName: K, prop: P, value: C[K][P]) {
					entityEvents.push({
						entityId,
						event: 'component-property-updated',
						args: [componentName, prop, value],
					});
				},
				emitEntityEvent(entityId: number, event: string, ...args: Array<unknown>) {
					entityEvents.push({
						entityId,
						event,
						args,
					});
				},
				emitSystemEvent(event: string, entityId: number) {
					(systemEvents[event] ?? (systemEvents[event] = [])).push(entityId);
				},
				entityDied(entityId: number) {
					entityEvents.push({
						entityId,
						event: 'death',
						args: [],
					});
				},
				createEntity(entity: WorkerCreatedEntity) {
					createdEntities.push(entity);
				},
			};
			if(updateFunction.preRun) {
				updateFunction.preRun(message.world, entities, queries, callbacks);
			}

			entities.forEach(entity => {
				updateFunction(message.world, entity.entityId, entity.components, queries, callbacks);
			});

			if(updateFunction.entityRemoved) {
				message.entities.removed.forEach(entityId => {
					updateFunction.entityRemoved!(message.world, entityId, callbacks);
				});
			}
			const runTime = performance.now() - start;

			postMessageTyped(scope, {
				type: 'run-complete',
				generation: message.generation,
				runTime,
				events: entityEvents,
				systemEvents,
				created: createdEntities,
			});
		}
	};
}

function postMessageTyped(scope: ComponentWorkerScope, message: ComponentWorkerMessage) {
	scope.postMessage(message);
}
