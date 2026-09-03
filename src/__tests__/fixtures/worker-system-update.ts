import { createEntityWorker } from '../../index';
import type { EntityWorkerSystemWorld, WorkerSystemRunFunction } from '../../index';
import type { Components } from './components';

export interface WorkerSystemWorld extends EntityWorkerSystemWorld {
	// Injected fresh each run via the system's addDataToWorld.
	tag?: number
	spawn?: boolean
}

// Reports the ids currently in the `targets` sub-query.
export const TARGETS_SEEN_EVENT = 'targets-seen';
// Echoes back the per-run `tag` injected via addDataToWorld, so a test can confirm it reached the worker.
export const RUN_TAG_EVENT = 'run-tag';

// A WorkerSystem run function: called once per run over the named sub-queries, not per entity. Counts the `targets`
// sub-query, echoes injected per-run data, and optionally spawns an entity off-thread.
export const workerSystemUpdate: WorkerSystemRunFunction<Components, WorkerSystemWorld> = (world, queries, callbacks) => {
	(queries.targets ?? []).forEach(target => {
		callbacks.emitSystemEvent(TARGETS_SEEN_EVENT, target.entityId);
	});

	if(world.tag !== undefined) {
		callbacks.emitSystemEvent(RUN_TAG_EVENT, world.tag);
	}

	if(world.spawn) {
		createEntityWorker(world, { type: 'Spawned', maxHealth: 10 }, callbacks);
	}
};
