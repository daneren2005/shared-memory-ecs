import { createEntityWorker } from '../../index';
import type { EntityUpdateFunction } from '../../index';
import type { ComponentArrays, Components } from './components';

// Creates one health entity per entity it runs over, from a factory config. The worker merges the 'Spawned' template
// (if any) and allocates + writes the health block off-thread; the main thread adopts it on run-complete.
export const spawnUpdate: EntityUpdateFunction<Components, Pick<ComponentArrays, 'health'>> = (world, entityId, components, queries, callbacks) => {
	createEntityWorker(world, { type: 'Spawned', maxHealth: 10 }, callbacks);
};
