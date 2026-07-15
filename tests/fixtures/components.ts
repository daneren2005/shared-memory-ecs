import { BaseWorld } from '../../src';
import type { ComponentDefinition, ComponentsOf, EntityConfigOf, EntityFactory } from '../../src';

// A tiny set of memory-backed components used by the tests, mirroring the shape a real game supplies.

export interface HealthComponent {
	index: number
	health: number
	maxHealth: number
}
// `maxHealth` is the defining Config prop; `health` is optional, runtime-derived Serialization that is the
// only thing `save` persists.
export interface HealthConfig {
	maxHealth: number
}
export interface HealthSerialization {
	health?: number
}
const HEALTH_INDEX = 0;
const HEALTH_MAX_INDEX = 1;
export const healthDefinition: ComponentDefinition<HealthComponent, Int32Array, HealthConfig, HealthSerialization> = {
	type: Int32Array,
	size: 2,
	// `maxHealth` is what defines a health component; a bare `health` in the config does not trigger a load.
	loadProperties: ['maxHealth'],
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
		// maxHealth is Config, so it is not serialized; only persist current health when it differs from full.
		const config: HealthSerialization = {};
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
// `speed` is entirely Config (it comes from the type template, like health's maxHealth), so movement has no
// runtime serialization and defines no `save` - nothing about it needs persisting on the entity.
export const movementDefinition: ComponentDefinition<MovementComponent, Float32Array, { speed: number }> = {
	type: Float32Array,
	size: 1,
	loadProperties: ['speed'],
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
};

// A deferred component (loadInFinishLoading) that mirrors the lumbermill/trees use case: it records how many
// OTHER entities exist in the world.  Because it reads the rest of the world, its count is only correct once
// every entity in a load batch exists - which is exactly why loading it is deferred to finishLoading rather
// than running as each entity is created.
export interface NeighborsComponent {
	index: number
	count: number
}
export interface NeighborsConfig {
	countsNeighbors: boolean
}
export const neighborsDefinition: ComponentDefinition<NeighborsComponent, Int32Array, NeighborsConfig> = {
	type: Int32Array,
	size: 1,
	loadProperties: ['countsNeighbors'],
	// Wait for finishLoading so every other entity is already loaded before we count them.
	loadInFinishLoading: true,
	load(entity, memory) {
		const count = entity.world.entities.filter(other => other !== entity).length;
		const index = memory.create([count]);
		const block = memory.getBlock(index);

		return {
			index,
			get count() {
				return block[0];
			},
			set count(value: number) {
				block[0] = value;
			},
		};
	},
};

export const registry = {
	health: healthDefinition,
	movement: movementDefinition,
	neighbors: neighborsDefinition,
};

// The component-instance map and flat entity config both derive straight from the registry, so tests get a
// fully typed world (and `entity.config`) without hand-writing any composite type.  `ComponentsOf` adds the
// always-present entity component automatically.
export type Components = ComponentsOf<typeof registry>;
export type ComponentArrays = {
	[K in keyof typeof registry]: InstanceType<(typeof registry)[K]['type']>
};
export type Config = EntityConfigOf<typeof registry>;
export type TestWorld = BaseWorld<typeof registry>;

export function createTestWorld(factory?: EntityFactory<Components, Config>): TestWorld {
	return new BaseWorld(registry, { factory });
}
