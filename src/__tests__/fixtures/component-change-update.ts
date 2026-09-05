import { addComponentWorker, removeComponentWorker } from '../../worker';
import type { EntityUpdateFunction, EntityWorkerSystemWorld } from '../../worker';
import type { ComponentArrays, Components } from './components';

export interface ComponentChangeWorld extends EntityWorkerSystemWorld {
	componentAction?: 'add' | 'remove'
}

export const componentChangeUpdate: EntityUpdateFunction<
	Components,
	Partial<Pick<ComponentArrays, 'movement'>> & Pick<ComponentArrays, 'health'>,
	ComponentChangeWorld
> = (world, entityId, components, queries, callbacks) => {
	if(world.componentAction === 'add' && !components.movement) {
		addComponentWorker(world, entityId, 'movement', { speed: 42 }, callbacks);
	} else if(world.componentAction === 'remove' && components.movement) {
		removeComponentWorker(entityId, 'movement', callbacks);
	}
};
