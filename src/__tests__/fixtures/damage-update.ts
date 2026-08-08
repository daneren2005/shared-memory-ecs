import type { ComponentSystemWorld, EntityUpdateFunction } from '../../index';
import type { ComponentArrays, Components } from './components';

export interface DamageWorld extends ComponentSystemWorld {
	damage?: number
}

export interface DamageInitData {
	damage?: number
}

// Shared update logic both ComponentSystem backends run, so they stay behavior-identical. Subtracts
// world.damage (default 1) from health and reports the change back through the callbacks.
export const DAMAGED_ENTITIES_EVENT = 'damaged-entities';

export const damageUpdate: EntityUpdateFunction<Components, Pick<ComponentArrays, 'health'>, DamageWorld, DamageInitData> = (world, entityId, components, queries, callbacks) => {
	const health = components.health;

	const damage = world.damage ?? 1;
	health[0] -= damage;
	callbacks.entityComponentChanged(entityId, 'health', 'health', health[0]);
	// A custom event carrying both damage taken and health left, which a per-property change can't say at once.
	callbacks.emitEntityEvent(entityId, 'damaged', damage, health[0]);
	// The same thing the cheap way: ids batched onto the system, values read off the shared block.
	callbacks.emitSystemEvent(DAMAGED_ENTITIES_EVENT, entityId);
};

// Exercises the init hook: a getInitData `{ damage }` payload becomes persistent per-run world state. Returns
// undefined when no payload, so systems without getInitData keep the default-1 behavior.
damageUpdate.init = (data) => {
	const damage = data?.damage;
	return damage === undefined ? undefined : { damage };
};
