import { createEntityWorker } from '../../index';
import type { EntityWorkerSystemWorld, WorkerSystemRunFunction } from '../../index';
import type { Components } from './components';

export interface WorkerSystemWorld extends EntityWorkerSystemWorld {
	// Injected fresh each run via the system's addDataToWorld.
	tag?: number
	spawn?: boolean
	initialTargets?: Array<number>
	initGameTime?: number
	initHadHeap?: boolean
}

// Reports the ids currently in the `targets` sub-query.
export const TARGETS_SEEN_EVENT = 'targets-seen';
// Echoes back the per-run `tag` injected via addDataToWorld, so a test can confirm it reached the worker.
export const RUN_TAG_EVENT = 'run-tag';
export const INITIAL_TARGETS_EVENT = 'initial-targets';
// Echoes the base world init saw: [gameTime, heap ? 1 : 0].
export const INIT_WORLD_EVENT = 'init-world';

// A WorkerSystem run function: called once per run over the named sub-queries, not per entity. Counts the `targets`
// sub-query, echoes injected per-run data, and optionally spawns an entity off-thread.
export const workerSystemUpdate: WorkerSystemRunFunction<Components, WorkerSystemWorld> = (world, queries, callbacks) => {
	(queries.targets ?? []).forEach(target => {
		callbacks.emitSystemEvent(TARGETS_SEEN_EVENT, target.entityId);
	});

	world.initialTargets?.forEach(entityId => callbacks.emitSystemEvent(INITIAL_TARGETS_EVENT, entityId));
	if(world.initGameTime !== undefined) {
		callbacks.emitSystemEvent(INIT_WORLD_EVENT, world.initGameTime);
		callbacks.emitSystemEvent(INIT_WORLD_EVENT, world.initHadHeap ? 1 : 0);
	}

	if(world.tag !== undefined) {
		callbacks.emitSystemEvent(RUN_TAG_EVENT, world.tag);
	}

	if(world.spawn) {
		createEntityWorker(world, { type: 'Spawned', maxHealth: 10 }, callbacks);
	}
};

workerSystemUpdate.init = (world, _data, queries) => ({
	initialTargets: (queries.targets ?? []).map(target => target.entityId),
	initGameTime: world.gameTime,
	initHadHeap: !!world.heap,
});
