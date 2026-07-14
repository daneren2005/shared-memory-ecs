import { EntitySystem } from '../../src';
import type { BaseEntity } from '../../src';
import { createTestWorld, type Components, type TestWorld } from '../fixtures/components';

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
		expect(system.entities.map(e => e.eid)).toEqual([entity1.eid, entity2.eid]);

		// Reloading the saved entities into a fresh world reproduces the same membership.  save carries only
		// serialization, so reload layers it over each entity's defining config (its template).
		let saves = world.entities.map(e => ({ ...e.config, ...e.save() }));
		let newWorld = createTestWorld();
		let newSystem = new StubSystem(newWorld, ['health']);
		saves.forEach(save => newWorld.loadEntity(save));
		expect(newSystem.entities.length).toEqual(2);
		expect(newSystem.entities.every(e => !!e.components.health)).toEqual(true);
	});

	it('with multiple components', () => {
		let system = new StubSystem(world, ['health', 'movement']);
		world.addSystem(system);

		let entity1 = createEntity({ maxHealth: 100, speed: 100 });
		createEntity({ maxHealth: 100 });
		createEntity({ speed: 100 });
		expect(system.entities.map(e => e.eid)).toEqual([entity1.eid]);

		// save carries only serialization, so reload layers it over each entity's defining config.
		let saves = world.entities.map(e => ({ ...e.config, ...e.save() }));
		let newWorld = createTestWorld();
		let newSystem = new StubSystem(newWorld, ['health', 'movement']);
		saves.forEach(save => newWorld.loadEntity(save));
		expect(newSystem.entities.length).toEqual(1);
	});

	it('with dynamically added components', () => {
		let system = new StubSystem(world, ['health']);
		world.addSystem(system);

		let entity1 = createEntity({ maxHealth: 100, speed: 100 });
		let entity2 = createEntity({ maxHealth: 100 });
		let otherEntity = createEntity({ speed: 100 });
		expect(system.entities.map(e => e.eid)).toEqual([entity1.eid, entity2.eid]);

		// Do not add from other component being added
		otherEntity.loadComponent('movement', { speed: 100 });
		expect(system.entities.map(e => e.eid)).toEqual([entity1.eid, entity2.eid]);

		// Do add from correct component being added
		otherEntity.loadComponent('health', { maxHealth: 100 });
		expect(system.entities.map(e => e.eid)).toEqual([entity1.eid, entity2.eid, otherEntity.eid]);

		// Do not remove from other component being removed
		otherEntity.removeComponent('movement');
		expect(system.entities.map(e => e.eid)).toEqual([entity1.eid, entity2.eid, otherEntity.eid]);

		// Do remove from correct component being removed
		otherEntity.removeComponent('health');
		expect(system.entities.map(e => e.eid)).toEqual([entity1.eid, entity2.eid]);
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
