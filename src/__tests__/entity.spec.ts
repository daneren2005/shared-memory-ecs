import { BaseEntity, EntityFactory, killEntity } from '../index';
import { createTestWorld, type Components, type Config } from './fixtures/components';

describe('entity', () => {
	it('load only loads registered component data', () => {
		let world = createTestWorld();
		// A prop no component claims should be ignored, not assigned onto the entity.
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

		let entity = world.loadEntity({ type: 'goblin', health: 10 });
		expect(entity.components.entity.type).toEqual('goblin');
		expect(entity.components.health?.maxHealth).toEqual(20);
		expect(entity.components.health?.health).toEqual(10);
		expect(entity.components.movement?.speed).toEqual(5);

		let saved = entity.save();
		expect(saved).toEqual({ type: 'goblin', health: 10 });

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

	it('removeComponent removes the component and defers freeing its memory until an update', () => {
		let world = createTestWorld();
		let entity = world.loadEntity({ maxHealth: 20 });
		expect(world.registry.health.memoryComponent.length).toEqual(1);

		entity.removeComponent('health');
		// The component is gone immediately, but its block is held until systems have had a chance to finish
		// using it, so nothing can reuse it mid-run.
		expect(entity.components.health).toBeUndefined();
		expect(world.registry.health.memoryComponent.length).toEqual(1);

		// No systems to wait on, so the next update frees it.
		world.update(16);
		expect(world.registry.health.memoryComponent.length).toEqual(0);
	});

	it('every entity gets an entity component, even without config', () => {
		let world = createTestWorld();

		let fromConfig = world.loadEntity({ maxHealth: 20 });
		expect(fromConfig.components.entity).toBeDefined();
		expect(fromConfig.components.entity.dead).toEqual(false);
		expect(fromConfig.components.entity.isStatic).toEqual(false);

		let bare = new BaseEntity(world);
		expect(bare.components.entity).toBeDefined();
	});

	it('entity component dead/isStatic flags are backed by shared memory', () => {
		let world = createTestWorld();
		let entity = world.loadEntity({ dead: true, isStatic: true });

		expect(entity.components.entity.dead).toEqual(true);
		expect(entity.components.entity.isStatic).toEqual(true);
		// Read straight from the shared block to prove the flags live there.
		let block = world.registry.entity.memoryComponent.getBlock(entity.components.entity.index);
		expect(block[0]).toEqual(1);
		expect(block[1]).toEqual(1);

		entity.components.entity.dead = false;
		expect(block[0]).toEqual(0);
	});

	it('killEntity flags the entity dead and emits death', () => {
		let world = createTestWorld();
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
		expect(world.entities.has(entity.eid)).toEqual(true);

		killEntity(entity);

		expect(world.entities.has(entity.eid)).toEqual(false);
	});
});
