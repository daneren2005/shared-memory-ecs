import { killEntityWorker } from '../../src';
import type { EntityUpdateFunction } from '../../src';
import type { Components } from './components';

// Kills every entity it runs over via killEntityWorker so the death path can be exercised end to end from
// both the main-thread and real-worker backends.  The system that uses this must include the entity
// component in its query so its shared-memory block is available to flag dead.
export const killUpdate: EntityUpdateFunction<Components> = (world, entityId, components, queries, callbacks) => {
	killEntityWorker(entityId, components, callbacks);
};
