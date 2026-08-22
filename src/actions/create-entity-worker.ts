import type { ComponentSystemCallbacks, ComponentSystemWorld, WorkerCreateEntityConfig } from '../systems/component-system';

// Worker-side entity creation from a factory config. Pass `{ type: 'ship', ...overrides }`: the worker merges the
// ship template shipped from the factory, mints a unique id, and allocates + writes every triggered component's block
// directly into the shared pools (off-thread) via each component's toBlock(). It reports the descriptor back; the main
// thread adopts it on run-complete (world.adoptEntity), building the `entity` component there and wrapping the
// worker-written blocks, so the entity first exists on the following frame.
//
// Requires the system to be registered with `createsEntities: true` and its worker entry to pass the component
// registry to createComponentWorker (so the worker has each component's toBlock).
export default function createEntityWorker(world: ComponentSystemWorld, config: WorkerCreateEntityConfig, callbacks: ComponentSystemCallbacks): void {
	if(!world.buildEntityDescriptor) {
		throw new Error('createEntityWorker requires the system to be registered with createsEntities: true and the component registry passed to createComponentWorker');
	}

	callbacks.createEntity(world.buildEntityDescriptor(config));
}
