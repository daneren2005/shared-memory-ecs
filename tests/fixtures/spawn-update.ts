import { createEntityWorker } from '../../src';
import type { EntityUpdateFunction } from '../../src';
import type { Components } from './components';

// Asks the main thread to create one new entity for each entity it runs over, exercising the deferred creation
// path end to end from both the main-thread and real-worker backends.  The spawned entity is a plain health
// entity so the test can assert it showed up with the expected component.
export const spawnUpdate: EntityUpdateFunction<Components> = (world, entityId, components, queries, callbacks) => {
	createEntityWorker({ maxHealth: 10 }, callbacks);
};
