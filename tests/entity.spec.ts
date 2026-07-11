import { createTestWorld } from './fixtures/components';

describe('entity', () => {
	it('load only loads registered component data', () => {
		let world = createTestWorld();
		let entity = world.loadEntity({
			health: { maxHealth: 20 },
			movement: { speed: 5 },
			// Not a registered component, so it is ignored rather than assigned onto the entity.
			bogus: { foo: 1 },
		});

		expect(entity.components.health?.maxHealth).toEqual(20);
		expect(entity.components.movement?.speed).toEqual(5);
		expect('bogus' in entity.components).toEqual(false);
	});

	it('save returns each component serialization', () => {
		let world = createTestWorld();
		let entity = world.loadEntity({
			health: { maxHealth: 20, health: 10 },
			movement: { speed: 5 },
		});

		expect(entity.save()).toEqual({
			health: { maxHealth: 20, health: 10 },
			movement: { speed: 5 },
		});
	});

	it('save config does not change results when reloaded', () => {
		let world = createTestWorld();
		let entity = world.loadEntity({
			health: { maxHealth: 20 },
			movement: { speed: 5 },
		});
		let savedConfig = entity.save();

		let reloaded = world.loadEntity(savedConfig);
		expect(reloaded.save()).toEqual(savedConfig);
		expect(reloaded.components.health?.maxHealth).toEqual(20);
		expect(reloaded.components.movement?.speed).toEqual(5);
	});

	it('setComponent emits and updates memory', () => {
		let world = createTestWorld();
		let entity = world.loadEntity({ health: { maxHealth: 20 } });

		let updated: Array<any> = [];
		entity.on('component-property-updated', (...args: Array<any>) => updated.push(args));

		entity.setComponent('health', 'health', 5);
		expect(entity.components.health?.health).toEqual(5);
		expect(updated).toEqual([['health', 'health', 5]]);
	});

	it('removeComponent frees its memory block and removes it', () => {
		let world = createTestWorld();
		let entity = world.loadEntity({ health: { maxHealth: 20 } });
		expect(world.components.health.length).toEqual(1);

		entity.removeComponent('health');
		expect(entity.components.health).toBeUndefined();
		expect(world.components.health.length).toEqual(0);
	});
});
