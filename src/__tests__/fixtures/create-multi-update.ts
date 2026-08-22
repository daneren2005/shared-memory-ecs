import { createEntityWorker } from '../../index';
import type { EntityUpdateFunction } from '../../index';
import type { ComponentArrays, Components } from './components';

// Creates one static 'ship' from a factory config, overriding speed. The worker merges the ship template (maxHealth +
// isStatic) with the override and writes both the health and movement blocks off-thread. Exercises template merge,
// override, isStatic, multi-component adoption, and a worker-minted eid.
export const createMultiUpdate: EntityUpdateFunction<Components, Pick<ComponentArrays, 'movement'>> = (world, entityId, components, queries, callbacks) => {
	createEntityWorker(world, { type: 'ship', speed: 9 }, callbacks);
};
