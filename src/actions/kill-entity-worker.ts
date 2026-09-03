import type { ComponentTypedArray } from '../memory-component';
import type { EntityWorkerSystemCallbacks, EntityUpdateComponents } from '../systems/entity-worker-system';
import { DEAD_INDEX } from '../entity-component';

// Worker-side killEntity: flags the entity dead in its block and reports the death back via callbacks. The
// entity component must be in the system's query for its block to be available here.
export default function killEntityWorker(entityId: number, components: EntityUpdateComponents, callbacks: EntityWorkerSystemCallbacks): void {
	const block = (components as { entity?: ComponentTypedArray }).entity;
	if(block) {
		block[DEAD_INDEX] = 1;
	}

	callbacks.entityDied(entityId);
}
