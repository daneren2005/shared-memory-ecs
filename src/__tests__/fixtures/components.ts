import { BaseWorld, Component } from '../../index';
import type { ComponentDefinition, ComponentsOf, EntityConfigOf, EntityFactory } from '../../index';

// A tiny set of memory-backed components used by the tests, mirroring the shape a real game supplies.

export interface HealthComponent {
	index: number
	health: number
	maxHealth: number
}
export interface HealthConfig {
	maxHealth: number
}
export interface HealthSerialization {
	health?: number
}
const HEALTH_INDEX = 0;
const HEALTH_MAX_INDEX = 1;
class HealthComponentImpl extends Component<Int32Array> implements HealthComponent {
	get health() {
		return this.block[HEALTH_INDEX];
	}
	set health(value: number) {
		this.block[HEALTH_INDEX] = value;
	}
	get maxHealth() {
		return this.block[HEALTH_MAX_INDEX];
	}
	set maxHealth(value: number) {
		this.block[HEALTH_MAX_INDEX] = value;
	}
}
export const healthDefinition: ComponentDefinition<HealthComponent, Int32Array, HealthConfig, HealthSerialization> = {
	type: Int32Array,
	size: 2,
	loadProperties: ['maxHealth'],
	// Worker-safe config → block values.
	toBlock(config) {
		return [config.health ?? config.maxHealth, config.maxHealth];
	},
	attach(entity, memory, index) {
		return new HealthComponentImpl(memory.getBlock(index), index);
	},
	save(component) {
		// Only persist current health when it differs from full; maxHealth is Config.
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
class MovementComponentImpl extends Component<Float32Array> implements MovementComponent {
	get speed() {
		return this.block[0];
	}
	set speed(value: number) {
		this.block[0] = value;
	}
}
// `speed` is entirely Config, so movement has no serialization and defines no `save`.
export const movementDefinition: ComponentDefinition<MovementComponent, Float32Array, { speed: number }> = {
	type: Float32Array,
	size: 1,
	loadProperties: ['speed'],
	toBlock(config) {
		return [config.speed];
	},
	attach(entity, memory, index) {
		return new MovementComponentImpl(memory.getBlock(index), index);
	},
};

// A deferred (loadInFinishLoading) component that counts the OTHER entities in the world, correct only once
// the whole load batch exists — hence deferred to finishLoading.
export interface NeighborsComponent {
	index: number
	count: number
}
export interface NeighborsConfig {
	countsNeighbors: boolean
}
class NeighborsComponentImpl extends Component<Int32Array> implements NeighborsComponent {
	get count() {
		return this.block[0];
	}
	set count(value: number) {
		this.block[0] = value;
	}
}
export const neighborsDefinition: ComponentDefinition<NeighborsComponent, Int32Array, NeighborsConfig> = {
	type: Int32Array,
	size: 1,
	loadProperties: ['countsNeighbors'],
	loadInFinishLoading: true,
	// Deferred + world-dependent, so never worker-created: toBlock reads the entity (only ever passed on the main
	// thread) to count the others in the world.
	toBlock(config, entity) {
		const count = entity!.world.entities.has(entity!.eid) ? entity!.world.entities.size - 1 : entity!.world.entities.size;
		return [count];
	},
	attach(entity, memory, index) {
		return new NeighborsComponentImpl(memory.getBlock(index), index);
	},
};

export const registry = {
	health: healthDefinition,
	movement: movementDefinition,
	neighbors: neighborsDefinition,
};

export type Components = ComponentsOf<typeof registry>;
export type ComponentArrays = {
	[K in keyof typeof registry]: InstanceType<(typeof registry)[K]['type']>
};
export type Config = EntityConfigOf<typeof registry>;
export type TestWorld = BaseWorld<typeof registry>;

export function createTestWorld(factory?: EntityFactory<Components, Config>): TestWorld {
	return new BaseWorld(registry, { factory });
}
