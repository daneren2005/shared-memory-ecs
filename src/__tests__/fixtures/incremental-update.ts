import type { EntityUpdateFunction, EntityWorkerSystemWorld } from '../../worker';
import type { Components } from './components';

export interface IncrementalWorld extends EntityWorkerSystemWorld {
	state?: { fail: boolean | 'preBatch' }
	preparedAt?: number
}

type IncrementalUpdate = EntityUpdateFunction<Components, { health: Int32Array, movement?: Float32Array }, IncrementalWorld, boolean | 'preBatch'>;
export const incrementalUpdate: IncrementalUpdate = (world, eid, components, queries, callbacks) => {
	components.health[0] -= world.elapsedTime;
	callbacks.emitEntityEvent(eid, 'visited', world.elapsedTime, world.gameTime, world.preparedAt, components.movement?.[0]);
};
incrementalUpdate.init = fail => ({ state: { fail: fail ?? false } });
incrementalUpdate.preRun = (world, entities, _queries, callbacks) => {
	if(world.state?.fail === true) {
		world.state.fail = false;
		throw new Error('Preparation failed');
	}
	world.preparedAt = world.gameTime;
	entities.forEach(entity => callbacks.emitSystemEvent('prepared', entity.entityId));
};
incrementalUpdate.preBatch = (world, entities, _queries, callbacks) => {
	if(world.state?.fail === 'preBatch') {
		world.state.fail = false;
		throw new Error('Batch preparation failed');
	}
	entities.forEach(entity => callbacks.emitSystemEvent('batch', entity.entityId));
};
incrementalUpdate.queryChanged = (_world, name, delta, callbacks) => {
	delta.added.forEach(entity => callbacks.emitSystemEvent(`added-${name}`, entity.entityId));
};
