import type { EntityWorkerSystemCallbacks, EntityWorkerSystemWorld, WorkerCreateEntityConfig } from '../systems/entity-worker-system';

// Worker-side entity creation from a factory config. The worker merges the selected type template, resolves its
// optional class, mints a unique id, and allocates + writes every allowed, triggered component block
// directly into the shared pools (off-thread) via each component's toBlock(). It reports the descriptor back; the main
// thread adopts it on run-complete (world.adoptEntity), building the `entity` component and class wrapper there
// worker-written blocks, so the entity first exists on the following frame.
//
// Requires the system to be registered with `createsEntities: true` and its worker entry to pass the component
// registry to createEntitySystemWorker (so the worker has each component's toBlock).
export default function createEntityWorker(world: EntityWorkerSystemWorld, config: WorkerCreateEntityConfig, callbacks: EntityWorkerSystemCallbacks): void {
	if(!world.buildEntityDescriptor) {
		throw new Error('createEntityWorker requires the system to be registered with createsEntities: true and the component registry passed to createEntitySystemWorker');
	}

	callbacks.createEntity(world.buildEntityDescriptor(config));
}
