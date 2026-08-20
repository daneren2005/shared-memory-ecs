import { TYPE_INDEX } from '../../index';
import type { EntityUpdateFunction } from '../../index';
import type { Components } from './components';

// Reads each entity's type off its shared block (the pointer at TYPE_INDEX) and resolves it back to a string
// through world.getString, reporting it so a test can prove the worker resolves types over the shared heap. The
// query must pull in `entity` so its block reaches the worker.
export const TYPE_READ_EVENT = 'type-read';

export const typeReadUpdate: EntityUpdateFunction<Components, { entity: Uint32Array }> = (world, entityId, components, queries, callbacks) => {
	const type = world.getString(components.entity[TYPE_INDEX]);
	callbacks.emitEntityEvent(entityId, TYPE_READ_EVENT, type);
};
