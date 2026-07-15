import { killEntityWorker } from '../../src';
import type { EntityUpdateFunction } from '../../src';
import type { ComponentArrays, Components } from './components';

// Reports events (a component change then a death) for every entity in the `targets` sub-query rather than for
// the main-query entity it is running over.  This mirrors the collision-system case: the system acts on entities
// it only knows through a sub-query and never had in its main query, so routing those events back has to fall
// back to world.getEntityByEid.  The sub-query must include the entity component so killEntityWorker can reach
// its shared block.
// The main query is movement-only; the entities it acts on come from the `targets` sub-query, not `components`.
export const queryTargetUpdate: EntityUpdateFunction<Components, Pick<ComponentArrays, 'movement'>> = (world, entityId, components, queries, callbacks) => {
	(queries.targets ?? []).forEach(target => {
		callbacks.entityComponentChanged(target.entityId, 'health', 'health', 50);
		killEntityWorker(target.entityId, target.components, callbacks);
	});
};
