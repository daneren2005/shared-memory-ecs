// Worker-thread entry point (`@daneren2005/shared-memory-ecs/worker`). Single-entry worker builds don't
// tree-shake a barrel, so importing from index.ts would drag the whole library into every worker bundle. This
// re-exports only what worker code uses, keeping those bundles tiny.
export { default as createEntitySystemWorker } from './systems/workers/create-entity-system-worker';
export type { EntitySystemWorkerScope } from './systems/workers/create-entity-system-worker';
export { default as createSystemWorker } from './systems/workers/create-system-worker';
export type { WorkerSystemRunFunction } from './systems/workers/create-system-worker';
export { default as createEntityWorker } from './actions/create-entity-worker';
export { default as addComponentWorker } from './actions/add-component-worker';
export { default as removeComponentWorker } from './actions/remove-component-worker';
export { default as killEntityWorker } from './actions/kill-entity-worker';
export { CLASS_INDEX, DEAD_INDEX, TYPE_INDEX } from './entity-component';

export type { default as EntitySystemWorkerMessage } from './systems/workers/entity-system-worker-message';
export type { EntityEvent, SystemEvents } from './systems/workers/entity-system-worker-message';
export type {
	EntityWorkerSystemWorld,
	EntityWorkerSystemCallbacks,
	WorkerAllocator,
	WorkerCreateEntityConfig,
	WorkerCreatedEntity,
	WorkerCreatedComponent,
	WorkerComponentChange,
	EntityUpdateComponents,
	EntityQueryComponents,
	EntityUpdateFunction,
	EntityUpdateInitFunction,
	EntityUpdatePreRunFunction,
	EntityRemovedFunction,
	UpdateEntityConfigObject,
} from './systems/entity-worker-system';
