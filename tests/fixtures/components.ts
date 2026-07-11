import { BaseWorld } from '../../src';
import type { ComponentDefinition } from '../../src';

// A tiny set of memory-backed components used by the tests, mirroring the shape a real game supplies.

export interface HealthComponent {
	index: number
	health: number
	maxHealth: number
}
const HEALTH_INDEX = 0;
const HEALTH_MAX_INDEX = 1;
export const healthDefinition: ComponentDefinition<HealthComponent, Int32Array, { health?: number, maxHealth: number }> = {
	type: Int32Array,
	size: 2,
	load(entity, memory, config) {
		const index = memory.create([config.health ?? config.maxHealth, config.maxHealth]);
		const block = memory.getBlock(index);

		return {
			index,
			get health() {
				return block[HEALTH_INDEX];
			},
			set health(value: number) {
				block[HEALTH_INDEX] = value;
			},
			get maxHealth() {
				return block[HEALTH_MAX_INDEX];
			},
			set maxHealth(value: number) {
				block[HEALTH_MAX_INDEX] = value;
			},
		};
	},
	save(component) {
		const config: { maxHealth: number, health?: number } = { maxHealth: component.maxHealth };
		// Only persist current health when it differs from full, matching the real game's saver.
		if(component.health !== component.maxHealth) {
			config.health = component.health;
		}

		return config;
	},
};

export interface MovementComponent {
	index: number
	speed: number
}
export const movementDefinition: ComponentDefinition<MovementComponent, Float32Array, { speed: number }> = {
	type: Float32Array,
	size: 1,
	load(entity, memory, config) {
		const index = memory.create([config.speed]);
		const block = memory.getBlock(index);

		return {
			index,
			get speed() {
				return block[0];
			},
			set speed(value: number) {
				block[0] = value;
			},
		};
	},
	save(component) {
		return { speed: component.speed };
	},
};

export const registry = {
	health: healthDefinition,
	movement: movementDefinition,
};

// Derives the component map type straight from the registry so BaseWorld<Components> is fully typed.
export type Components = {
	[K in keyof typeof registry]: ReturnType<(typeof registry)[K]['load']>
};

export function createTestWorld() {
	return new BaseWorld<Components>(registry);
}
