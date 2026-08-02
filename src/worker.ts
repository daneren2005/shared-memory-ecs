// Worker-thread entry point, imported as `@daneren2005/shared-memory-ecs/worker`.
//
// A game's worker files are each built as their own single-entry bundle (e.g. Vite's `?worker`).  A single-entry
// build does NOT tree-shake a re-export barrel: importing just `createComponentWorker` from the main `index.ts`
// drags the entire library - System, BaseWorld, MemoryComponent and their shared-memory-objects dependencies
// (SharedList, MemoryHeap, ...) - into every worker (~20kb of code a worker never runs).  This entry re-exports
// only the handful of helpers worker code actually uses, so a worker's module graph never reaches the
// main-thread runtime and each worker bundle stays tiny.
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
	EntityUpdatePreRunFunction,
	EntityRemovedFunction,
	UpdateEntityConfigObject,
} from './systems/component-system';
