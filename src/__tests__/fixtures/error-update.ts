import type { EntityWorkerSystemWorld, EntityUpdateFunction } from '../../index';
import type { ComponentArrays, Components } from './components';

// Drives the error-handling tests: an entity whose maxHealth is POISON_MAX_HEALTH throws from its update body,
// so a run mixes failing and succeeding entities. preRun throws when world.failPreRun is set.
export const POISON_MAX_HEALTH = 13;

export interface ErrorWorld extends EntityWorkerSystemWorld {
	failPreRun?: boolean
}

export const errorUpdate: EntityUpdateFunction<Components, Pick<ComponentArrays, 'health'>, ErrorWorld> = (world, entityId, components, queries, callbacks) => {
	const health = components.health;
	if(health[1] === POISON_MAX_HEALTH) {
		throw new Error(`entity ${entityId} update failed`);
	}

	health[0] -= 1;
	callbacks.entityComponentChanged(entityId, 'health', 'health', health[0]);
};

errorUpdate.preRun = (world) => {
	if(world.failPreRun) {
		throw new Error('preRun failed');
	}
};
