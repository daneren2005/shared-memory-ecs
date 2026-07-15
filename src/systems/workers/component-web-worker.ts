import WebWorker from './web-worker';
import type ComponentWorkerMessage from './component-worker-message';
import type { ComponentMap } from '../../component-definition';
import type { ComponentSystemCallbacks, EntityQueryComponents, EntityUpdateComponents, EntityUpdateFunction, UpdateEntityConfigObject } from '../component-system';

// Main-thread fallback that runs the update function synchronously when real Web Workers /
// SharedArrayBuffer are unavailable.  Because it runs in-process it can pass the components straight
// through without caching them by entity id.
export default class ComponentWebWorker<C extends ComponentMap, T extends EntityUpdateComponents<C>> extends WebWorker {
	private updateFunction: EntityUpdateFunction<C, T>;

	constructor(updateFunction: EntityUpdateFunction<C, T>) {
		super();
		this.updateFunction = updateFunction;
	}

	postMessage(message: ComponentWorkerMessage): void {
		if(message.type === 'init') {
			this.onMessageTyped({
				type: 'loaded',
			});
		} else if(message.type === 'run') {
			let entityEvents: Array<{ entityId: number, event: string, args: Array<any> }> = [];
			let createdEntities: Array<Record<string, unknown>> = [];

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
			if(this.updateFunction.preRun) {
				this.updateFunction.preRun(message.world, message.entities as Array<UpdateEntityConfigObject<T>>, message.queries as EntityQueryComponents<C>, callbacks);
			}
			message.entities.forEach(entity => {
				// Should not be called
				if(typeof entity === 'number') {
					return;
				}

				this.updateFunction(message.world, entity.entityId, entity.components as T, message.queries as EntityQueryComponents<C>, callbacks);
			});

			if(this.updateFunction.entityRemoved) {
				for(let entityId of message.removed) {
					this.updateFunction.entityRemoved(message.world, entityId, callbacks);
				}
			}

			this.onMessageTyped({
				type: 'run-complete',
				runTime: 0,
				events: entityEvents,
				created: createdEntities,
			});
		}
	}

	onMessageTyped(message: ComponentWorkerMessage) {
		this.onmessage({
			data: message,
		});
	}
}
