import { killEntityWorker } from '../../index';
import type { EntityUpdateFunction } from '../../index';
import type { ComponentArrays, Components } from './components';

// Reports events for entities in the `targets` sub-query, not the main-query entity it runs over — mirroring a
// collision system, whose events route back via world.getEntityByEid. The sub-query includes `entity`.
export const queryTargetUpdate: EntityUpdateFunction<Components, Pick<ComponentArrays, 'movement'>> = (world, entityId, components, queries, callbacks) => {
	(queries.targets ?? []).forEach(target => {
		callbacks.entityComponentChanged(target.entityId, 'health', 'health', 50);
		killEntityWorker(target.entityId, target.components, callbacks);
	});
};
