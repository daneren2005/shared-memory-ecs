import type { ComponentSystemCallbacks, CreateEntityConfig } from '../systems/component-system';

// Worker-side loadEntity: buffers the config through callbacks. The main thread builds it via world.loadEntity
// once the run completes, so it first exists on the following frame.
export default function createEntityWorker(config: CreateEntityConfig, callbacks: ComponentSystemCallbacks): void {
	callbacks.createEntity(config);
}
