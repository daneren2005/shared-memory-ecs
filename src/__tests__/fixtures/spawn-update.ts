import { createEntityWorker } from '../../index';
import type { EntityUpdateFunction } from '../../index';
import type { ComponentArrays, Components } from './components';

// Asks the main thread to create one plain health entity per entity it runs over, exercising deferred creation.
export const spawnUpdate: EntityUpdateFunction<Components, Pick<ComponentArrays, 'health'>> = (world, entityId, components, queries, callbacks) => {
	createEntityWorker({ maxHealth: 10 }, callbacks);
};
