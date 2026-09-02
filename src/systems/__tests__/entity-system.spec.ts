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

	it('keeps updating the other entities when one throws, and surfaces a system-error', () => {
		let errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

		let system = new ThrowingSystem(world);
		world.addSystem(system);

		let failing = createEntity({ maxHealth: 100, speed: 100 });
		let survivor = createEntity({ maxHealth: 100, speed: 100 });
		system.failFor = failing.eid;

		let errors: Array<{ system: string, entityId?: number, phase?: string }> = [];
		world.on('system-error', (error) => errors.push(error));

		system.run(0);

		expect(system.updated).toEqual([survivor.eid]);
		expect(errors.length).toEqual(1);
		expect(errors[0].system).toEqual('ThrowingSystem');
		expect(errors[0].entityId).toEqual(failing.eid);
		expect(errors[0].phase).toEqual('update');
		expect(errorSpy).toHaveBeenCalled();

		errorSpy.mockRestore();
	});

	it('drains a sliced run without updating entities that left the system', () => {
		let system = new SlicedHealthSystem(world);
		system.maxMsPerFrame = 0;
		world.addSystem(system);
		let first = createEntity({ maxHealth: 10 });
		let second = createEntity({ maxHealth: 20 });

		world.update(16);
		expect(system.isCurrentlyRunning()).toEqual(true);
		expect(system.updated).toEqual([first.eid]);

		world.removeEntity(first);
		world.removeEntity(second);
		world.update(16);

		expect(system.isCurrentlyRunning()).toEqual(false);
		expect(system.updated).toEqual([first.eid]);
		expect(world.registry.health.memoryComponent.length).toEqual(0);
	});

	function createEntity(config: any): BaseEntity<Components> {
		return world.loadEntity(config);
	}
});

class ThrowingSystem extends EntitySystem<Components> {
	failFor?: number;
	updated: Array<number> = [];

	constructor(world: TestWorld) {
		super(world, { name: 'ThrowingSystem', components: ['health'] });
	}

	updateEntity(entity: BaseEntity<Components>): void {
		if(entity.eid === this.failFor) {
			throw new Error(`entity ${entity.eid} failed`);
		}
		this.updated.push(entity.eid);
	}
}

class StubSystem extends EntitySystem<Components> {
	constructor(world: TestWorld, components: Array<keyof Components>) {
		super(world, {
			name: 'StubSystem',
			components,
		});
	}

	updateEntity(entity: BaseEntity<Components>, elapsedTime: number): void {}
}

class SlicedHealthSystem extends EntitySystem<Components> {
	updated: Array<number> = [];

	constructor(world: TestWorld) {
		super(world, {
			name: 'SlicedHealthSystem',
			components: ['health'],
			iterationsPerCheck: 1,
			maxMsPerFrame: 0,
		});
	}

	updateEntity(entity: BaseEntity<Components>): void {
		this.updated.push(entity.eid);
	}
}
