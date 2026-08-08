// Worker-thread entry point (`@daneren2005/shared-memory-ecs/worker`). Single-entry worker builds don't
// tree-shake a barrel, so importing from index.ts would drag the whole library into every worker bundle. This
// re-exports only what worker code uses, keeping those bundles tiny.
export { default as createComponentWorker } from './systems/workers/create-component-worker';
export type { ComponentWorkerScope } from './systems/workers/create-component-worker';
export { default as createEntityWorker } from './actions/create-entity-worker';
export { default as killEntityWorker } from './actions/kill-entity-worker';
export { DEAD_INDEX } from './entity-component';

export type { default as ComponentWorkerMessage } from './systems/workers/component-worker-message';
export type { EntityEvent, SystemEvents } from './systems/workers/component-worker-message';
export type {
	ComponentSystemWorld,
	ComponentSystemCallbacks,
	CreateEntityConfig,
	EntityUpdateComponents,
	EntityQueryComponents,
	EntityUpdateFunction,
	EntityUpdateInitFunction,
	EntityUpdatePreRunFunction,
	EntityRemovedFunction,
	UpdateEntityConfigObject,
} from './systems/component-system';
