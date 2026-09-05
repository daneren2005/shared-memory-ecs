import type { ComponentDefinition } from './component-definition';
import Component from './component';
import type ConstantStringCache from './constant-string-cache';

export interface EntityComponent {
	index: number
	readonly type: string
	readonly class: string
	dead: boolean
	isStatic: boolean
}

export interface EntityComponentConfig {
	type: string
	isStatic?: boolean
}

export interface EntityClassConfig {
	readonly class: string
}

export interface EntityComponentSerialization {
	type?: string
	dead?: boolean
}

export const DEAD_INDEX = 0;
export const STATIC_INDEX = 1;
export const TYPE_INDEX = 2;
export const CLASS_INDEX = 3;

// Identity strings are interned, so the accessor needs the world's cache to resolve their pointers.
class EntityComponentImpl extends Component<Uint32Array> implements EntityComponent {
	private cache: ConstantStringCache;

	constructor(block: Uint32Array, index: number, cache: ConstantStringCache) {
		super(block, index);
		this.cache = cache;
	}

	get type() {
		return this.cache.getString(this.block[TYPE_INDEX]) ?? '';
	}
	get class() {
		return this.cache.getString(this.block[CLASS_INDEX]) ?? '';
	}
	get dead() {
		return this.block[DEAD_INDEX] === 1;
	}
	set dead(value: boolean) {
		this.block[DEAD_INDEX] = value ? 1 : 0;
	}
	get isStatic() {
		return this.block[STATIC_INDEX] === 1;
	}
	set isStatic(value: boolean) {
		this.block[STATIC_INDEX] = value ? 1 : 0;
	}
}

export const entityDefinition: ComponentDefinition<EntityComponent, Uint32Array, EntityComponentConfig & Partial<EntityClassConfig>, EntityComponentSerialization> = {
	type: Uint32Array,
	size: 4,
	loadProperties: ['type', 'isStatic'],
	// The only component that reads the entity (never worker-created): it interns its identity strings through the heap and
	// stores the pointer. `entity` is always passed here since loadComponent runs on the main thread.
	toBlock(config, entity) {
		const cache = entity!.world.constantStrings;
		const typePointer = config.type ? cache.getOrCreate(config.type).pointer : 0;
		const classPointer = config.class ? cache.getOrCreate(config.class).pointer : 0;
		return [config.dead ? 1 : 0, config.isStatic ? 1 : 0, typePointer, classPointer];
	},
	attach(entity, memory, index) {
		return new EntityComponentImpl(memory.getBlock(index), index, entity.world.constantStrings);
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
