import { killEntityWorker } from '../../index';
import type { EntityUpdateFunction } from '../../index';
import type { ComponentArrays, Components } from './components';

// Kills every entity it runs over via killEntityWorker so the death path can be exercised end to end from
// both the main-thread and real-worker backends.  The system that uses this must include the entity
// component in its query so its shared-memory block is available to flag dead.
// The query requires `health` and pulls in `entity` (optional) so killEntityWorker can reach its shared block.
export const killUpdate: EntityUpdateFunction<Components, Pick<ComponentArrays, 'health'>> = (world, entityId, components, queries, callbacks) => {
	killEntityWorker(entityId, components, callbacks);
};
