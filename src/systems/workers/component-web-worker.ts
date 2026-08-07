import WebWorker from './web-worker';
import { applyQueryDelta } from './apply-query-delta';
import type ComponentWorkerMessage from './component-worker-message';
import type { EntityEvent, SystemEvents } from './component-worker-message';
import type { ComponentMap } from '../../component-definition';
import type { ComponentSystemCallbacks, ComponentSystemWorld, EntityQueryComponents, EntityUpdateComponents, EntityUpdateFunction, QueryDelta, UpdateEntityConfigObject } from '../component-system';

// Main-thread fallback that runs the update function synchronously, mirroring the real worker's behavior.
export default class ComponentWebWorker<C extends ComponentMap, T extends EntityUpdateComponents<C>, W extends ComponentSystemWorld = ComponentSystemWorld> extends WebWorker {
	private updateFunction: EntityUpdateFunction<C, T, W>;
	private entities: Array<UpdateEntityConfigObject<T>> = [];
	private queryEntities: { [key: string]: Array<UpdateEntityConfigObject<T>> } = {};

	constructor(updateFunction: EntityUpdateFunction<C, T, W>) {
		super();
		this.updateFunction = updateFunction;
	}

	postMessage(message: ComponentWorkerMessage<W>): void {
		if(message.type === 'init') {
			this.onMessageTyped({
				type: 'loaded',
			});
		} else if(message.type === 'run') {
			// Timed like the real worker so a forceMainThread system reports a real run cost, not zero.
			const start = performance.now();
			let entityEvents: Array<EntityEvent> = [];
			let systemEvents: SystemEvents = {};
			let createdEntities: Array<Record<string, unknown>> = [];

			this.entities = applyQueryDelta(this.entities, message.entities as QueryDelta<T>);

			let queries: EntityQueryComponents<C> = {};
			Object.entries(message.queries).forEach(([queryKey, delta]) => {
				const list = applyQueryDelta(this.queryEntities[queryKey] ?? [], delta as QueryDelta<T>);
				this.queryEntities[queryKey] = list;
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
			if(this.updateFunction.preRun) {
				this.updateFunction.preRun(message.world, this.entities, queries, callbacks);
			}
			this.entities.forEach(entity => {
				this.updateFunction(message.world, entity.entityId, entity.components, queries, callbacks);
			});

			if(this.updateFunction.entityRemoved) {
				for(let entityId of message.entities.removed) {
					this.updateFunction.entityRemoved(message.world, entityId, callbacks);
				}
			}

			const runTime = performance.now() - start;

			this.onMessageTyped({
				type: 'run-complete',
				runTime,
				events: entityEvents,
				systemEvents,
				created: createdEntities,
			});
		}
	}

	onMessageTyped(message: ComponentWorkerMessage<W>) {
		this.onmessage({
			data: message,
		});
	}
}
