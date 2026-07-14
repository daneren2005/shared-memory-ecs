import type { BaseWorld } from '../../src';
import type { ComponentDefinitionMap, ComponentMap } from '../../src';

// STEP_SIZE mirrors the game's fixed timestep so the timing based system tests behave identically.
export const STEP_SIZE = 16.66;

// Steps the world forward in fixed increments, the same way the real game loop drives it.  Generic over the
// registry `R` and component map `C` so any typed world can be driven; only `update` is used, which is
// registry-agnostic.
export function runWorld<R extends ComponentDefinitionMap, C extends ComponentMap>(world: BaseWorld<R, C>, totalTime: number = STEP_SIZE) {
	let steps = Math.ceil(totalTime / STEP_SIZE);
	for(let i = 0; i < steps; i++) {
		let { lastSystemError } = world.update(STEP_SIZE);
		if(lastSystemError) {
			throw lastSystemError;
		}
	}
}
