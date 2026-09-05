import {
	BaseEntity,
	BaseWorld,
	CLASS_INDEX,
	Component,
	EntityFactory,
	defineEntityClasses,
	defineEntityConfigs,
} from '../index';
import type {
	ComponentDefinition,
	ComponentsOf,
	EntityConfigOf,
	EntityInstanceConfigOf,
	EntityInstancesOf,
} from '../index';

interface VitalityComponent {
	index: number
	vitality: number
}

class VitalityComponentImpl extends Component<Int32Array> implements VitalityComponent {
	get vitality(): number {
		return this.block[0];
	}
}

const vitalityDefinition: ComponentDefinition<VitalityComponent, Int32Array, { vitality: number }> = {
	type: Int32Array,
	size: 1,
	loadProperties: ['vitality'],
	toBlock(config) {
		return [config.vitality];
	},
	attach(_entity, memory, index) {
		return new VitalityComponentImpl(memory.getBlock(index), index);
	},
};

interface ValueComponent {
	index: number
	value: number
}

class ValueComponentImpl extends Component<Int32Array> implements ValueComponent {
	get value(): number {
		return this.block[0];
	}
}

const valueDefinition: ComponentDefinition<ValueComponent, Int32Array, { value: number }> = {
	type: Int32Array,
	size: 1,
	loadProperties: ['value'],
	toBlock(config) {
		return [config.value];
	},
	attach(_entity, memory, index) {
		return new ValueComponentImpl(memory.getBlock(index), index);
	},
};

interface MarkerComponent {
	index: number
	marked: boolean
}

const delayedDefinition: ComponentDefinition<MarkerComponent, Uint32Array, { delayed: boolean }> = {
	type: Uint32Array,
	size: 1,
	loadProperties: ['delayed'],
	loadInFinishLoading: true,
	toBlock() {
		return [1];
	},
	attach(_entity, _memory, index) {
		return { index, marked: true };
	},
};

const auditedValueDefinition: ComponentDefinition<MarkerComponent, Uint32Array, { value: number }> = {
	type: Uint32Array,
	size: 1,
	loadProperties: ['value'],
	toBlock() {
		return [1];
	},
	attach(_entity, _memory, index) {
		return { index, marked: true };
	},
};

const registry = {
	vitality: vitalityDefinition,
	value: valueDefinition,
	delayed: delayedDefinition,
	auditedValue: auditedValueDefinition,
};

type Components = ComponentsOf<typeof registry>;
type Config = EntityConfigOf<typeof registry>;

class ActorEntity extends BaseEntity<Components, Config> {
	get vitality(): number | undefined {
		return this.components.vitality?.vitality;
	}
}

class ItemEntity extends BaseEntity<Components, Config> {
	get value(): number | undefined {
		return this.components.value?.value;
	}
}

const classes = defineEntityClasses(registry, {
	actor: {
		entity: ActorEntity,
		components: ['vitality', 'delayed', 'auditedValue'],
	},
	item: {
		entity: ItemEntity,
		components: ['value'],
	},
} as const);

defineEntityClasses(registry, {
	invalidComponent: {
		entity: ItemEntity,
		// @ts-expect-error class component names must come from the registry
		components: ['missing'],
	},
	invalidConstructor: {
		// @ts-expect-error class constructors must produce BaseEntity instances
		entity: class NotAnEntity {},
		components: ['value'],
	},
});

const templates = defineEntityConfigs(classes, {
	guardian: {
		type: 'guardian',
		class: 'actor',
		vitality: 100,
		delayed: true,
	},
	token: {
		type: 'token',
		class: 'item',
		value: 5,
	},
} as const);

type Entities = EntityInstancesOf<typeof classes>;
type InstanceConfig = EntityInstanceConfigOf<typeof classes>;
type ClassWorld = BaseWorld<typeof registry, Components, Config, Entities>;

function createWorld(): ClassWorld {
	const factory = new EntityFactory<Components, Config, Entities>(templates, classes);
	return new BaseWorld<typeof registry, Components, Config, Entities>(registry, { factory });
}

describe('entity classes', () => {
	it('derives template config fields from each class component list', () => {
		defineEntityConfigs(classes, {
			validItem: { type: 'validItem', class: 'item', value: 2 },
			invalidItem: {
				type: 'invalidItem',
				class: 'item',
				value: 2,
				// @ts-expect-error vitality belongs to the actor class
				vitality: 10,
			},
		});

		const config: InstanceConfig = { type: 'token', value: 8 };
		expect(config.type).toBe('token');
		// @ts-expect-error an instance cannot choose its class
		config.class = 'item';
	});

	it('constructs the template class and loads only its allowed components', () => {
		const world = createWorld();
		const actor = world.loadEntity({ type: 'guardian' });
		const item = world.loadEntity({ type: 'token' });

		expect(actor).toBeInstanceOf(ActorEntity);
		expect(item).toBeInstanceOf(ItemEntity);
		expect(actor.components.vitality?.vitality).toBe(100);
		expect(actor.components.delayed?.marked).toBe(true);
		expect(actor.components.value).toBeUndefined();
		expect(item.components.value?.value).toBe(5);
		expect(item.components.vitality).toBeUndefined();
		expect(item.components.auditedValue).toBeUndefined();
	});

	it('provides immutable identity accessors on every BaseEntity subclass', () => {
		const world = createWorld();
		const entity = world.loadEntity({ type: 'token' });

		expect(entity.id).toBe(entity.eid);
		expect(entity.dead).toBe(false);
		expect(entity.type).toBe('token');
		expect(entity.components.entity.class).toBe('item');
		expect(entity.components.entity.block?.[CLASS_INDEX]).toBeGreaterThan(0);
		expect(Reflect.set(entity.components.entity, 'type', 'other')).toBe(false);
		expect(Reflect.set(entity.components.entity, 'class', 'actor')).toBe(false);
		expect(entity.type).toBe('token');
		expect(entity.components.entity.class).toBe('item');
		expect(() => Reflect.apply(entity.setComponent, entity, ['entity', 'type', 'other'])).toThrow('Entity type is immutable');
		expect(() => Reflect.apply(entity.setComponentBulk, entity, ['entity', { class: 'actor' }])).toThrow('Entity class is immutable');
	});

	it('rejects instance class overrides and disallowed component triggers', () => {
		const world = createWorld();

		expect(() => Reflect.apply(world.loadEntity, world, [{ type: 'token', class: 'actor' }])).toThrow('cannot be supplied by an instance config');
		expect(() => world.loadEntity({ type: 'token', vitality: 2 })).toThrow('cannot load component vitality');

		const item = world.loadEntity({ type: 'token' });
		expect(() => item.loadComponent('vitality', { vitality: 2 })).toThrow('not allowed for entity type token');
	});

	it('saves type without class and re-derives the same class on reload', () => {
		const world = createWorld();
		const entity = world.loadEntity({ type: 'token' });
		const saved = entity.save();

		expect(saved).toEqual({ type: 'token' });
		expect(saved).not.toHaveProperty('class');

		const reloaded = createWorld().loadEntity(saved);
		expect(reloaded).toBeInstanceOf(ItemEntity);
		expect(reloaded.components.entity.class).toBe('item');
	});

	it('uses the class factory when adopting an existing descriptor', () => {
		const world = createWorld();
		const index = world.registry.value.memoryComponent.create([12]);
		const entity = world.adoptEntity({
			eid: 42,
			type: 'token',
			class: 'item',
			components: { value: index },
		});

		expect(entity).toBeInstanceOf(ItemEntity);
		expect((entity as ItemEntity).value).toBe(12);
	});

	it('reclaims worker blocks when descriptor validation rejects adoption', () => {
		const world = createWorld();
		const index = world.registry.value.memoryComponent.create([12]);

		expect(() => world.adoptEntity({
			eid: 42,
			type: 'guardian',
			class: 'actor',
			components: { value: index },
		})).toThrow('not allowed for entity class actor');

		world.update(0);
		expect(world.registry.value.memoryComponent.length).toBe(0);
	});

	it('validates the final result of an overridable config transformation', () => {
		class InvalidTransformFactory extends EntityFactory<Components, Config, Entities> {
			getConfig(config: Config): Config {
				return { ...super.getConfig(config), vitality: 2 };
			}
		}

		const factory = new InvalidTransformFactory(templates, classes);
		const world = new BaseWorld<typeof registry, Components, Config, Entities>(registry, { factory });
		expect(() => world.loadEntity({ type: 'token' })).toThrow('cannot load component vitality');
	});

	it('rejects constructors that do not extend BaseEntity at runtime', () => {
		class EidableObject {
			readonly eid = 1;
		}
		const invalidClasses = defineEntityClasses(registry, {
			item: { entity: EidableObject, components: ['value'] },
		});
		const invalidTemplates = defineEntityConfigs(invalidClasses, {
			token: { type: 'token', class: 'item', value: 5 },
		});
		const factory = new EntityFactory<Components, Config, ItemEntity>(invalidTemplates, invalidClasses);

		expect(() => new BaseWorld<typeof registry, Components, Config, ItemEntity>(registry, { factory })).toThrow('must extend BaseEntity');
	});

	it('keeps the classless factory behavior', () => {
		const world = new BaseWorld(registry);
		const entity = world.loadEntity({ type: 'legacy', vitality: 4 });

		expect(entity.constructor).toBe(BaseEntity);
		expect(entity).not.toBeInstanceOf(ActorEntity);
		expect(entity.components.vitality?.vitality).toBe(4);
	});
});
