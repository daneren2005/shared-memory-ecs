import type { BaseWorld } from '../../index';
import type { ComponentDefinitionMap, ComponentMap } from '../../index';

// Mirrors the game's fixed timestep so timing-based system tests behave identically.
export const STEP_SIZE = 16.66;

// Steps the world forward in fixed increments, like the real game loop.
export function runWorld<R extends ComponentDefinitionMap, C extends ComponentMap>(world: BaseWorld<R, C>, totalTime: number = STEP_SIZE) {
	let steps = Math.ceil(totalTime / STEP_SIZE);
	for(let i = 0; i < steps; i++) {
		let { lastSystemError } = world.update(STEP_SIZE);
		if(lastSystemError) {
			throw lastSystemError;
		}
	}
}
