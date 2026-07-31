import type ComponentWorkerMessage from './component-worker-message';
import type { EntityEvent } from './component-worker-message';
import type { ComponentMap } from '../../component-definition';
import type { ComponentSystemCallbacks, ComponentSystemWorld, EntityQueryComponents, EntityUpdateComponents, EntityUpdateFunction, QueryDelta, UpdateEntityConfigObject } from '../component-system';
import { applyQueryDelta } from './apply-query-delta';

// The slice of the Web Worker global scope createComponentWorker actually touches.  Worker files pass the
// real `self` (e.g. `createComponentWorker(self, fn)`); passing it explicitly also lets test runners that
// inject `self` as a module local rather than a true global - like @vitest/web-worker - drive the worker.
export interface ComponentWorkerScope {
	onmessage: ((e: MessageEvent) => void) | null
	postMessage(message: ComponentWorkerMessage): void
}

// Entry point a game's worker file calls with its update function.  It wires up `scope.onmessage`,
// caches component blocks by entity id (so subsequent runs only need the id), and posts results back.
export default function createComponentWorker<
	C extends ComponentMap,
	T extends EntityUpdateComponents<C>,
	W extends ComponentSystemWorld = ComponentSystemWorld,
>(scope: ComponentWorkerScope, updateFunction: EntityUpdateFunction<C, T, W>) {
	// The worker's persistent iteration lists.  The main thread now sends only membership changes, so these are
	// carried across runs and mutated by the deltas each run brings (see applyQueryDelta).
	let entities: Array<UpdateEntityConfigObject<T>> = [];
	const queryEntities: { [key: string]: Array<UpdateEntityConfigObject<T>> } = {};

	scope.onmessage = function(e) {
		const message = e.data as ComponentWorkerMessage<W>;

		if(message.type === 'init') {
			postMessageTyped(scope, {
				type: 'loaded',
			});
		} else if(message.type === 'run') {
			const start = performance.now();
			let entityEvents: Array<EntityEvent> = [];
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

			// applyQueryDelta already dropped the removed entities from the persistent lists above; the hook just
			// lets the update function react to entities that left the system's main query.
			if(updateFunction.entityRemoved) {
				message.entities.removed.forEach(entityId => {
					updateFunction.entityRemoved!(message.world, entityId, callbacks);
				});
			}
			const runTime = performance.now() - start;

			postMessageTyped(scope, {
				type: 'run-complete',
				runTime,
				events: entityEvents,
				created: createdEntities,
			});
		}
	};
}

function postMessageTyped(scope: ComponentWorkerScope, message: ComponentWorkerMessage) {
	scope.postMessage(message);
}
