import { BaseEntity, EntityFactory, killEntity } from '../index';
import { createTestWorld, type Components, type Config } from './fixtures/components';

describe('entity', () => {
	it('load only loads registered component data', () => {
		let world = createTestWorld();
		// The typed config is now closed, so cast to mirror an untyped/dynamic config (e.g. loaded from disk)
		// carrying a prop no component claims - it should be ignored rather than assigned onto the entity.
		let entity = world.loadEntity({
			maxHealth: 20,
			speed: 5,
			bogus: 1,
		} as unknown as Config);

		expect(entity.components.health?.maxHealth).toEqual(20);
		expect(entity.components.movement?.speed).toEqual(5);
		expect('bogus' in entity.components).toEqual(false);
	});

	it('save returns each component serialization', () => {
		let world = createTestWorld();
		let entity = world.loadEntity({
			isStatic: true,
			maxHealth: 20,
			health: 10,
			speed: 5,
		});

		// save returns only serialization: isStatic, maxHealth and speed are all Config, so the output is just
		// the runtime-derived health (which differs from max).
		expect(entity.save()).toEqual({
			health: 10,
		});
	});

	it('serialization layered over the defining config reloads unchanged', () => {
		let world = createTestWorld();
		let config = {
			isStatic: true,
			maxHealth: 20,
			health: 10,
			speed: 5,
		};
		let entity = world.loadEntity(config);
		let savedConfig = entity.save();

		// save only carries serialization, so reloading re-applies the defining config (the template) and
		// layers the saved runtime state on top - which round-trips to the same save.
		let reloaded = world.loadEntity({ ...config, ...savedConfig });
		expect(reloaded.save()).toEqual(savedConfig);
		expect(reloaded.components.entity.isStatic).toEqual(true);
		expect(reloaded.components.health?.maxHealth).toEqual(20);
		expect(reloaded.components.health?.health).toEqual(10);
		expect(reloaded.components.movement?.speed).toEqual(5);
	});

	it('loads typed entities from factory templates and saves only type + serialization', () => {
		let factory = new EntityFactory<Components, Config>({
			goblin: { maxHealth: 20, speed: 5 },
		});
		let world = createTestWorld(factory);

		// The caller supplies only the type + runtime health; maxHealth/speed come from the goblin template.
		let entity = world.loadEntity({ type: 'goblin', health: 10 });
		expect(entity.components.entity.type).toEqual('goblin');
		expect(entity.components.health?.maxHealth).toEqual(20);
		expect(entity.components.health?.health).toEqual(10);
		expect(entity.components.movement?.speed).toEqual(5);

		// The templated maxHealth/speed are not saved - only the type and the entity's serialization.
		let saved = entity.save();
		expect(saved).toEqual({ type: 'goblin', health: 10 });

		// That save re-expands through the factory to the same entity when reloaded.
		let reloaded = world.loadEntity(saved);
		expect(reloaded.components.health?.maxHealth).toEqual(20);
		expect(reloaded.components.movement?.speed).toEqual(5);
		expect(reloaded.save()).toEqual(saved);
	});

	it('a config whose type has no template is loaded as-is', () => {
		let world = createTestWorld(new EntityFactory<Components, Config>({ goblin: { maxHealth: 20 } }));

		let entity = world.loadEntity({ type: 'slime', maxHealth: 5 });
		expect(entity.components.entity.type).toEqual('slime');
		expect(entity.components.health?.maxHealth).toEqual(5);
	});

	it('setComponent emits and updates memory', () => {
		let world = createTestWorld();
		let entity = world.loadEntity({ maxHealth: 20 });

		let updated: Array<any> = [];
		entity.on('component-property-updated', (...args: Array<any>) => updated.push(args));

		entity.setComponent('health', 'health', 5);
		expect(entity.components.health?.health).toEqual(5);
		expect(updated).toEqual([['health', 'health', 5]]);
	});

	it('removeComponent frees its memory block and removes it', () => {
		let world = createTestWorld();
		let entity = world.loadEntity({ maxHealth: 20 });
		expect(world.registry.health.memoryComponent.length).toEqual(1);

		entity.removeComponent('health');
		expect(entity.components.health).toBeUndefined();
		expect(world.registry.health.memoryComponent.length).toEqual(0);
	});

	it('every entity gets an entity component, even without config', () => {
		let world = createTestWorld();

		let fromConfig = world.loadEntity({ maxHealth: 20 });
		expect(fromConfig.components.entity).toBeDefined();
		expect(fromConfig.components.entity.dead).toEqual(false);
		expect(fromConfig.components.entity.isStatic).toEqual(false);

		// A bare entity constructed with no config still has one.
		let bare = new BaseEntity(world);
		expect(bare.components.entity).toBeDefined();
	});

	it('entity component dead/isStatic flags are backed by shared memory', () => {
		let world = createTestWorld();
		let entity = world.loadEntity({ dead: true, isStatic: true });

		expect(entity.components.entity.dead).toEqual(true);
		expect(entity.components.entity.isStatic).toEqual(true);
		// Reading straight from the shared block proves the flags live there (1 === true).
		let block = world.registry.entity.memoryComponent.getBlock(entity.components.entity.index);
		expect(block[0]).toEqual(1);
		expect(block[1]).toEqual(1);

		entity.components.entity.dead = false;
		expect(block[0]).toEqual(0);
	});

	it('killEntity flags the entity dead and emits death', () => {
		let world = createTestWorld();
		// Not added to the world, so nothing auto-removes it and the dead flag can be read afterwards.
		let entity = new BaseEntity(world);

		let died = false;
		entity.on('death', () => {
			died = true;
		});

		killEntity(entity);

		expect(entity.components.entity.dead).toEqual(true);
		expect(died).toEqual(true);
	});

	it('world removes an entity when it dies', () => {
		let world = createTestWorld();
		let entity = world.loadEntity({ maxHealth: 20 });
		expect(world.entities).toContain(entity);

		killEntity(entity);

		expect(world.entities).not.toContain(entity);
	});
});
