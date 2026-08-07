import type { ComponentDefinition } from './component-definition';

// dead/isStatic live in the shared block (worker-visible); type is main-thread only.
export interface EntityComponent {
	index: number
	type: string
	dead: boolean
	isStatic: boolean
}

export interface EntityComponentConfig {
	type: string
	isStatic?: boolean
}

export interface EntityComponentSerialization {
	type?: string
	dead?: boolean
}

export const DEAD_INDEX = 0;
export const STATIC_INDEX = 1;

export const entityDefinition: ComponentDefinition<EntityComponent, Uint32Array, EntityComponentConfig, EntityComponentSerialization> = {
	type: Uint32Array,
	size: 2,
	loadProperties: ['type', 'isStatic'],
	load(entity, memory, config) {
		const index = memory.create([config.dead ? 1 : 0, config.isStatic ? 1 : 0]);
		const block = memory.getBlock(index);

		return {
			index,
			type: config.type,
			get dead() {
				return block[DEAD_INDEX] === 1;
			},
			set dead(value: boolean) {
				block[DEAD_INDEX] = value ? 1 : 0;
			},
			get isStatic() {
				return block[STATIC_INDEX] === 1;
			},
			set isStatic(value: boolean) {
				block[STATIC_INDEX] = value ? 1 : 0;
			},
		};
	},
	save(component) {
		const config: EntityComponentSerialization = {};
		if(component.type) {
			config.type = component.type;
		}
		if(component.dead) {
			config.dead = true;
		}

		return config;
	},
};
