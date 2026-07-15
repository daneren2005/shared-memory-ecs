import type { ComponentSystemWorld, EntityUpdateFunction } from '../../src';
import type { ComponentArrays, Components } from './components';

// Per-run world shape this system attaches through addDataToWorld: an optional per-run damage override.
export interface DamageWorld extends ComponentSystemWorld {
	damage?: number
}

// Shared update logic used by both ComponentSystem backends: the main-thread ComponentWebWorker runs it
// directly (passed as `updateFunction`), while the real worker file imports it and hands it to
// createComponentWorker.  Keeping it in one place means both paths run identical logic.
//
// Each run subtracts `world.damage` (default 1) from the entity's current health - index 0 of the shared
// Int32Array block - and reports the change back through the callbacks.  Because the block lives in a
// SharedArrayBuffer, mutating it here is visible on the main thread's entity.
// `T` lists only the components this system actually uses (its query requires `health`), typed as their
// concrete backing arrays - so `components.health` is a plain `Int32Array`, not the ComponentTypedArray union.
export const damageUpdate: EntityUpdateFunction<Components, Pick<ComponentArrays, 'health'>, DamageWorld> = (world, entityId, components, queries, callbacks) => {
	const health = components.health;

	const damage = world.damage ?? 1;
	health[0] -= damage;
	callbacks.entityComponentChanged(entityId, 'health', 'health', health[0]);
};
