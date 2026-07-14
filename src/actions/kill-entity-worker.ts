import type { ComponentTypedArray } from '../memory-component';
import type { ComponentSystemCallbacks, EntityUpdateComponents } from '../systems/component-system';
import { DEAD_INDEX } from '../entity-component';

// The worker-thread counterpart of killEntity.  Called from inside a component system's update function,
// it flags the entity dead directly in its shared-memory block and reports the death back to the main
// thread through the callbacks so the world can run the same cleanup killEntity would.  The entity
// component must be part of the system's query for its block to be available here.
export default function killEntityWorker(entityId: number, components: EntityUpdateComponents, callbacks: ComponentSystemCallbacks): void {
	const block = (components as { entity?: ComponentTypedArray }).entity;
	if(block) {
		block[DEAD_INDEX] = 1;
	}

	callbacks.entityDied(entityId);
}
