import type { ComponentDefinition } from './component-definition';

// The one component every entity is required to have.  `dead` and `isStatic` are boolean flags stored in
// the shared-memory block so a worker that pulls the `entity` component into its query can read them too.
// `type` is a plain string that names the EntityFactory template this entity was built from; it lives off
// to the side (not in shared memory), so - unlike `dead`/`isStatic` - it is NOT visible to workers.
// Games that need a stable string id (or any other per-entity data) add their own component for it.
export interface EntityComponent {
	index: number
	type: string
	dead: boolean
	isStatic: boolean
}

// The defining config for the entity component.  `type` is required - every entity is created from a factory
// template, named by its type - while `isStatic` is an optional flag supplied up front.
export interface EntityComponentConfig {
	type: string
	isStatic?: boolean
}

// Runtime-derived state plus `type`: `dead` is only meaningful once the entity is alive, and `type` is kept
// so a save can be re-expanded through the factory.  `isStatic` is intentionally absent - it comes back from
// the type's template config, not the save.
export interface EntityComponentSerialization {
	type?: string
	dead?: boolean
}

export const DEAD_INDEX = 0;
export const STATIC_INDEX = 1;

export const entityDefinition: ComponentDefinition<EntityComponent, Uint32Array, EntityComponentConfig, EntityComponentSerialization> = {
	type: Uint32Array,
	size: 2,
	// The entity component is always loaded by BaseEntity's constructor, so this never actually gates
	// loading; it documents the defining config props and keeps it consistent with game components.
	loadProperties: ['type', 'isStatic'],
	load(entity, memory, config) {
		const index = memory.create([config.dead ? 1 : 0, config.isStatic ? 1 : 0]);
		const block = memory.getBlock(index);

		return {
			index,
			// Plain (non-memory) property, so it is main-thread only and not readable from workers.
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
		// `type` + `dead` are serialized; `isStatic` (and the rest of the template) come back from the type's
		// config on reload, so they are deliberately left out.
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
