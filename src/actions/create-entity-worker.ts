import type { ComponentSystemCallbacks, CreateEntityConfig } from '../systems/component-system';

// The worker-thread counterpart of loadEntity.  Called from inside a component system's update function, it
// can't build the entity itself (eid generation, shared-memory allocation, and factory expansion all live on
// the main thread), so it buffers the flat config through the callbacks.  The main thread creates the entity
// via world.loadEntity once the run completes, meaning it first exists on the following frame.
export default function createEntityWorker(config: CreateEntityConfig, callbacks: ComponentSystemCallbacks): void {
	callbacks.createEntity(config);
}
