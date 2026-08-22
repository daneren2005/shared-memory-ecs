import WebWorker from './web-worker';
import { applyQueryDelta } from './apply-query-delta';
import type ComponentWorkerMessage from './component-worker-message';
import type { EntityEvent, SystemEvents } from './component-worker-message';
import type BaseWorld from '../../world';
import type { ComponentDefinitionMap, ComponentMap, RegisteredComponentRegistry } from '../../component-definition';
import type {
	ComponentSystemCallbacks, ComponentSystemWorld, EntityQueryComponents, EntityUpdateComponents,
	EntityUpdateFunction, QueryDelta, UpdateEntityConfigObject, WorkerAllocator, WorkerCreatedEntity,
} from '../component-system';
import { buildWorkerEntity, type WorkerCreateRegistry } from '../../actions/build-worker-entity';

// Main-thread fallback that runs the update function synchronously, mirroring the real worker's behavior.
export default class ComponentWebWorker<C extends ComponentMap, T extends EntityUpdateComponents<C>, W extends ComponentSystemWorld = ComponentSystemWorld, D = unknown> extends WebWorker {
	private updateFunction: EntityUpdateFunction<C, T, W, D>;
	private entities: Array<UpdateEntityConfigObject<T>> = [];
	private queryEntities: { [key: string]: Array<UpdateEntityConfigObject<T>> } = {};
	// Mirrors createComponentWorker: updateFunction.init's result, merged onto `world` each run.
	private worldExtension: Partial<W> | undefined;
	// Running on the main thread, this shares the world (its string cache, registry pools, eid counter) directly.
	private world: BaseWorld<ComponentDefinitionMap, C>;
	private allocator: WorkerAllocator;
	private createsEntities: boolean;

	constructor(updateFunction: EntityUpdateFunction<C, T, W, D>, world: BaseWorld<ComponentDefinitionMap, C>, createsEntities = false) {
		super();
		this.updateFunction = updateFunction;
		this.world = world;
		this.createsEntities = createsEntities;
		const registry = world.registry as RegisteredComponentRegistry<C>;
		this.allocator = {
			allocateEid: () => world.allocateEid(),
			allocateComponentBlock: (name, values) => registry[name as keyof C].memoryComponent.create(values),
		};
	}

	postMessage(message: ComponentWorkerMessage<W, D>): void {
		if(message.type === 'init') {
			this.onMessageTyped({
				type: 'init-complete',
			});
		} else if(message.type === 'load') {
			this.worldExtension = this.updateFunction.init?.(message.data) ?? undefined;
			this.onMessageTyped({
				type: 'loaded',
			});
		} else if(message.type === 'reset') {
			// Drop the persistent lists so a reused world starts empty; worldExtension is refreshed by the next load.
			this.entities = [];
			this.queryEntities = {};
		} else if(message.type === 'run') {
			if(this.worldExtension) {
				Object.assign(message.world, this.worldExtension);
			}
			message.world.getString = (pointer: number) => this.world.constantStrings.getString(pointer) ?? '';
			message.world.allocate = this.allocator;
			if(this.createsEntities) {
				const registry: WorkerCreateRegistry = this.world.registry;
				message.world.buildEntityDescriptor = config => buildWorkerEntity(config, this.world.factory.configs, registry, this.allocator);
			}
			// Timed like the real worker so a forceMainThread system reports a real run cost, not zero.
			const start = performance.now();
			let entityEvents: Array<EntityEvent> = [];
			let systemEvents: SystemEvents = {};
			let createdEntities: Array<WorkerCreatedEntity> = [];

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
				createEntity(entity: WorkerCreatedEntity) {
					createdEntities.push(entity);
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
				generation: message.generation,
				runTime,
				events: entityEvents,
				systemEvents,
				created: createdEntities,
			});
		}
	}

	onMessageTyped(message: ComponentWorkerMessage<W, D>) {
		this.onmessage({
			data: message,
		});
	}
}
