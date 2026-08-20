import type { ComponentDefinition } from './component-definition';

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
export const TYPE_INDEX = 2;

export const entityDefinition: ComponentDefinition<EntityComponent, Uint32Array, EntityComponentConfig, EntityComponentSerialization> = {
	type: Uint32Array,
	size: 3,
	loadProperties: ['type', 'isStatic'],
	load(entity, memory, config) {
		const cache = entity.world.constantStrings;
		const typePointer = config.type ? cache.getOrCreate(config.type).pointer : 0;
		const index = memory.create([config.dead ? 1 : 0, config.isStatic ? 1 : 0, typePointer]);
		const block = memory.getBlock(index);

		return {
			index,
			get type() {
				return cache.getString(block[TYPE_INDEX]) ?? '';
			},
			set type(value: string) {
				block[TYPE_INDEX] = value ? cache.getOrCreate(value).pointer : 0;
			},
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
