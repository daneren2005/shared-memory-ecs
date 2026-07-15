import type ComponentWorkerMessage from './component-worker-message';
import type { ComponentMap } from '../../component-definition';
import type { ComponentSystemCallbacks, ComponentSystemWorld, EntityUpdateComponents, EntityUpdateFunction, UpdateEntityConfigObject } from '../component-system';

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
	const cachedEntityComponent: { [key: number]: T } = {};
	const cachedQueriesComponent: { [key: string]: { [key: number]: T } } = {};

	scope.onmessage = function(e) {
		const message = e.data as ComponentWorkerMessage<W>;

		if(message.type === 'init') {
			postMessageTyped(scope, {
				type: 'loaded',
			});
		} else if(message.type === 'run') {
			const start = performance.now();
			let entityEvents: Array<{ entityId: number, event: string, args: Array<any> }> = [];
			let createdEntities: Array<Record<string, unknown>> = [];

			let queries: { [key: string]: Array<{ entityId: number, components: T }> } = {};
			Object.entries(message.queries).forEach(([queryKey, entities]) => {
				let cachedQueryComponent = cachedQueriesComponent[queryKey];
				if(!cachedQueryComponent) {
					cachedQueryComponent = cachedQueriesComponent[queryKey] = {};
				}

				queries[queryKey] = entities.map(entity => {
					let components, entityId;
					if(typeof entity === 'number') {
						components = cachedQueryComponent[entity];
						entityId = entity;
					} else {
						cachedQueryComponent[entity.entityId] = components = entity.components as T;
						entityId = entity.entityId;
					}

					return {
						entityId,
						components,
					};
				});
			});

			let entities: Array<UpdateEntityConfigObject<T>> = [];
			for(let entity of message.entities) {
				let components, entityId;
				if(typeof entity === 'number') {
					components = cachedEntityComponent[entity];
					entityId = entity;
				} else {
					cachedEntityComponent[entity.entityId] = components = entity.components as T;
					entityId = entity.entityId;
				}

				entities.push({
					entityId,
					components,
				});
			}

			let callbacks: ComponentSystemCallbacks<C> = {
				entityComponentChanged<K extends keyof C, P extends keyof C[K]>(entityId: number, componentName: K, prop: P, value: C[K][P]) {
					entityEvents.push({
						entityId,
						event: 'component-property-updated',
						args: [componentName, prop, value],
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

			message.removed.forEach(entityId => {
				delete cachedEntityComponent[entityId];
				Object.values(cachedQueriesComponent).forEach(query => {
					delete query[entityId];
				});

				if(updateFunction.entityRemoved) {
					updateFunction.entityRemoved(message.world, entityId, callbacks);
				}
			});
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
