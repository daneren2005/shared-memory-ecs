import type { EntityWorkerSystemWorld, EntityUpdateFunction } from '../../index';
import type { ComponentArrays, Components } from './components';

export const QUERY_ADDED_EVENT = 'query-added';
export const QUERY_REMOVED_EVENT = 'query-removed';
export const TRACKED_EVENT = 'tracked';

// Mirrors a worker-local structure kept in sync from query deltas: `tracked` lives in the init-returned extension.
export interface QueryChangedWorld extends EntityWorkerSystemWorld {
	tracked: Set<number>
	failQueryChanged?: boolean
}

export const queryChangedUpdate: EntityUpdateFunction<Components, Pick<ComponentArrays, 'health'>, QueryChangedWorld> = () => {};

queryChangedUpdate.init = () => ({ tracked: new Set<number>() });

queryChangedUpdate.queryChanged = (world, queryName, delta, callbacks) => {
	if(world.failQueryChanged) {
		throw new Error('queryChanged failed');
	}
	delta.added.forEach(entity => {
		world.tracked.add(entity.entityId);
		callbacks.emitSystemEvent(`${queryName}-${QUERY_ADDED_EVENT}`, entity.entityId);
	});
	delta.removed.forEach(entityId => {
		world.tracked.delete(entityId);
		callbacks.emitSystemEvent(`${queryName}-${QUERY_REMOVED_EVENT}`, entityId);
	});
};

// Reports the tracked set after queryChanged, proving the hook runs before preRun.
queryChangedUpdate.preRun = (world, entities, queries, callbacks) => {
	world.tracked.forEach(entityId => callbacks.emitSystemEvent(TRACKED_EVENT, entityId));
};
