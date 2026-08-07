import { killEntityWorker } from '../../index';
import type { EntityUpdateFunction } from '../../index';
import type { ComponentArrays, Components } from './components';

// Kills every entity it runs over via killEntityWorker. The query pulls in `entity` so its block is reachable.
export const KILLED_ENTITIES_EVENT = 'killed-entities';

export const killUpdate: EntityUpdateFunction<Components, Pick<ComponentArrays, 'health'>> = (world, entityId, components, queries, callbacks) => {
	killEntityWorker(entityId, components, callbacks);
	// Batched before the queued `death` dispatches, so a test sees the world as it is at that moment.
	callbacks.emitSystemEvent(KILLED_ENTITIES_EVENT, entityId);
};
