import type { EntityUpdateFunction } from '../../index';
import type { Components } from './components';

export const RANDOM_DRAWN_EVENT = 'random-drawn';

export const randomUpdate: EntityUpdateFunction<Components, { entity: Uint32Array }> = (world, entityId, components, queries, callbacks) => {
	callbacks.emitEntityEvent(entityId, RANDOM_DRAWN_EVENT, world.random.uint32());
};
