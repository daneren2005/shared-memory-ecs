import MemoryHeap from '@daneren2005/shared-memory-objects/memory-heap';
import type ComponentWorkerMessage from './component-worker-message';
import type { EntityEvent, SystemEvents } from './component-worker-message';
import ConstantStringCache from '../../constant-string-cache';
import type { ComponentMap } from '../../component-definition';
import type { ComponentSystemCallbacks, ComponentSystemWorld, EntityQueryComponents, EntityUpdateComponents, EntityUpdateFunction, QueryDelta, UpdateEntityConfigObject } from '../component-system';
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
>(scope: ComponentWorkerScope, updateFunction: EntityUpdateFunction<C, T, W, D>) {
	// Persistent lists, carried across runs and mutated by each run's delta (see applyQueryDelta).
	let entities: Array<UpdateEntityConfigObject<T>> = [];
	const queryEntities: { [key: string]: Array<UpdateEntityConfigObject<T>> } = {};
	// What updateFunction.init returned: persistent state (e.g. a seeded RNG) merged onto `world` each run.
	let worldExtension: Partial<W> | undefined;
	let heap: MemoryHeap | undefined;
	let stringCache: ConstantStringCache | undefined;
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
			}
			worldExtension = updateFunction.init?.(message.data) ?? undefined;
			postMessageTyped(scope, {
				type: 'loaded',
			});
		} else if(message.type === 'grow-buffer') {
			heap?.addSharedBuffer(message.buffer);
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
			const start = performance.now();
			let entityEvents: Array<EntityEvent> = [];
			let systemEvents: SystemEvents = {};
			let createdEntities: Array<Record<string, unknown>> = [];

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
				createEntity(config: Record<string, unknown>) {
					createdEntities.push(config);
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
