import { EntitySystem } from '../../index';
import type { BaseEntity } from '../../index';
import { createTestWorld, type Components, type TestWorld } from '../../__tests__/fixtures/components';
import { eidsOf, listOf } from '../../__tests__/fixtures/entity-collections';

describe('entity-system', () => {
	let world: TestWorld;
	beforeEach(() => {
		world = createTestWorld();
	});

	it('with normal components', () => {
		let system = new StubSystem(world, ['health']);
		world.addSystem(system);

		let entity1 = createEntity({ maxHealth: 100, speed: 100 });
		let entity2 = createEntity({ maxHealth: 100 });
		createEntity({ speed: 100 });
		expect(eidsOf(system.entities)).toEqual([entity1.eid, entity2.eid]);

		// Reloading the saves into a fresh world reproduces the same membership.
		let saves = listOf(world.entities).map(e => ({ ...e.config, ...e.save() }));
		let newWorld = createTestWorld();
		let newSystem = new StubSystem(newWorld, ['health']);
		saves.forEach(save => newWorld.loadEntity(save));
		expect(newSystem.entities.size).toEqual(2);
		expect(listOf(newSystem.entities).every(e => !!e.components.health)).toEqual(true);
	});

	it('with multiple components', () => {
		let system = new StubSystem(world, ['health', 'movement']);
		world.addSystem(system);

		let entity1 = createEntity({ maxHealth: 100, speed: 100 });
		createEntity({ maxHealth: 100 });
		createEntity({ speed: 100 });
		expect(eidsOf(system.entities)).toEqual([entity1.eid]);

		let saves = listOf(world.entities).map(e => ({ ...e.config, ...e.save() }));
		let newWorld = createTestWorld();
		let newSystem = new StubSystem(newWorld, ['health', 'movement']);
		saves.forEach(save => newWorld.loadEntity(save));
		expect(newSystem.entities.size).toEqual(1);
	});

	it('with dynamically added components', () => {
		let system = new StubSystem(world, ['health']);
		world.addSystem(system);

		let entity1 = createEntity({ maxHealth: 100, speed: 100 });
		let entity2 = createEntity({ maxHealth: 100 });
		let otherEntity = createEntity({ speed: 100 });
		expect(eidsOf(system.entities)).toEqual([entity1.eid, entity2.eid]);

		// Do not add from other component being added
		otherEntity.loadComponent('movement', { speed: 100 });
		expect(eidsOf(system.entities)).toEqual([entity1.eid, entity2.eid]);

		// Do add from correct component being added
		otherEntity.loadComponent('health', { maxHealth: 100 });
		expect(eidsOf(system.entities)).toEqual([entity1.eid, entity2.eid, otherEntity.eid]);

		// Do not remove from other component being removed
		otherEntity.removeComponent('movement');
		expect(eidsOf(system.entities)).toEqual([entity1.eid, entity2.eid, otherEntity.eid]);

		// Do remove from correct component being removed
		otherEntity.removeComponent('health');
		expect(eidsOf(system.entities)).toEqual([entity1.eid, entity2.eid]);
	});

	function createEntity(config: any): BaseEntity<Components> {
		return world.loadEntity(config);
	}
});

class StubSystem extends EntitySystem<Components> {
	constructor(world: TestWorld, components: Array<keyof Components>) {
		super(world, {
			name: 'StubSystem',
			components,
		});
	}

	updateEntity(entity: BaseEntity<Components>, elapsedTime: number): void {}
}
