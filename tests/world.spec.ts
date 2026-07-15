import { System, killEntity } from '../src';
import { createTestWorld, type Components, type TestWorld } from './fixtures/components';

describe('world load', () => {
	it('loads every entity from the config', () => {
		let world = createTestWorld();
		world.load({
			entities: [
				{ maxHealth: 20, speed: 5 },
				{ maxHealth: 10 },
			],
		});

		expect(world.entities.length).toEqual(2);
		expect(world.entities[0].components.health?.maxHealth).toEqual(20);
		expect(world.entities[0].components.movement?.speed).toEqual(5);
		expect(world.entities[1].components.health?.maxHealth).toEqual(10);
	});

	it('clears existing entities and frees their memory before loading', () => {
		let world = createTestWorld();
		let old = world.loadEntity({ maxHealth: 20 });
		expect(world.registry.health.memoryComponent.length).toEqual(1);

		world.load({ entities: [{ maxHealth: 10 }] });

		expect(world.entities).not.toContain(old);
		expect(world.getEntityByEid(old.eid)).toBeUndefined();
		// The old entity's health block was freed, so only the newly loaded entity's block remains.
		expect(world.registry.health.memoryComponent.length).toEqual(1);
		expect(world.entities[0].components.health?.maxHealth).toEqual(10);
	});

	it('clears existing systems before loading', () => {
		let world = createTestWorld();
		world.addSystem(new NoopSystem(world));
		expect(world.systems.length).toEqual(1);

		world.load({ entities: [] });
		expect(world.systems.length).toEqual(0);
	});

	it('defaults to an empty world when called with no config', () => {
		let world = createTestWorld();
		world.loadEntity({ maxHealth: 20 });
		world.addSystem(new NoopSystem(world));

		world.load({ entities: [] });

		expect(world.entities.length).toEqual(0);
		expect(world.systems.length).toEqual(0);
	});

	it('runs finishLoading only after every entity exists so deferred components see the whole world', () => {
		let world = createTestWorld();
		world.load({
			entities: [
				// The counter is first in the list, yet it still counts all three of the other entities.  If
				// finishLoading ran as each entity was created (rather than after the whole batch), it would see
				// zero neighbors - so the count proves the deferral.
				{ countsNeighbors: true },
				{ maxHealth: 20 },
				{ maxHealth: 10 },
				{ speed: 5 },
			],
		});

		let counter = world.entities[0];
		expect(counter.components.neighbors?.count).toEqual(3);
	});

	it('every deferred component counts the full batch regardless of its position', () => {
		let world = createTestWorld();
		world.load({
			entities: [
				{ countsNeighbors: true },
				{ maxHealth: 20 },
				{ countsNeighbors: true },
			],
		});

		// Both counters see the other two entities, no matter where they sit in the load order.
		expect(world.entities[0].components.neighbors?.count).toEqual(2);
		expect(world.entities[2].components.neighbors?.count).toEqual(2);
	});

	it('restores the world clocks from the config', () => {
		let world = createTestWorld();

		world.load({
			entities: [],
			gameTime: 5000,
			playerTime: 8000,
			timeScale: 4,
		});

		expect(world.gameTime).toEqual(5000);
		expect(world.playerTime).toEqual(8000);
		expect(world.timeScale).toEqual(4);
	});

	it('resets the world clocks to their defaults when the config omits them', () => {
		let world = createTestWorld();
		world.gameTime = 5000;
		world.playerTime = 8000;
		world.timeScale = 4;

		world.load({ entities: [] });

		expect(world.gameTime).toEqual(0);
		expect(world.playerTime).toEqual(0);
		expect(world.timeScale).toEqual(1);
	});

	it('emits entity-added once per entity loaded through load', () => {
		let world = createTestWorld();

		let added: Array<any> = [];
		world.on('entity-added', entity => added.push(entity));

		world.load({
			entities: [
				{ maxHealth: 20 },
				{ maxHealth: 10 },
			],
		});

		// Each entity is loaded with created = false (so addEntity stays quiet), then announced exactly once by
		// load - so we get one event per entity, in order, and no duplicates.
		expect(added.length).toEqual(2);
		expect(added[0]).toBe(world.entities[0]);
		expect(added[1]).toBe(world.entities[1]);
	});

	it('emits entity-added once for an entity added through loadEntity', () => {
		let world = createTestWorld();

		let added: Array<any> = [];
		world.on('entity-added', entity => added.push(entity));

		let entity = world.loadEntity({ maxHealth: 20 });

		expect(added.length).toEqual(1);
		expect(added[0]).toBe(entity);
	});

	it('calls removeEntity once when an entity loaded through load dies', () => {
		let world = createTestWorld();
		world.load({ entities: [{ maxHealth: 20 }] });
		let entity = world.entities[0];

		// The death handler is registered exactly once (by load, not also by the created = false addEntity), so a
		// single kill removes the entity a single time rather than double-freeing its memory.
		let removeEntity = vi.spyOn(world, 'removeEntity');
		killEntity(entity);

		expect(removeEntity).toHaveBeenCalledTimes(1);
		expect(removeEntity).toHaveBeenCalledWith(entity);
		expect(world.entities).not.toContain(entity);
	});

	it('calls removeEntity once when an entity added through loadEntity dies', () => {
		let world = createTestWorld();
		let entity = world.loadEntity({ maxHealth: 20 });

		let removeEntity = vi.spyOn(world, 'removeEntity');
		killEntity(entity);

		expect(removeEntity).toHaveBeenCalledTimes(1);
		expect(removeEntity).toHaveBeenCalledWith(entity);
		expect(world.entities).not.toContain(entity);
	});
});

describe('world time', () => {
	it('defaults timeScale to 1, paused to false and the clocks to 0', () => {
		let world = createTestWorld();

		expect(world.timeScale).toEqual(1);
		expect(world.paused).toEqual(false);
		expect(world.gameTime).toEqual(0);
		expect(world.playerTime).toEqual(0);
	});

	it('advances gameTime and playerTime together at the default timeScale', () => {
		let world = createTestWorld();

		world.update(100);
		world.update(50);

		expect(world.gameTime).toEqual(150);
		expect(world.playerTime).toEqual(150);
	});

	it('scales gameTime by timeScale while playerTime tracks real elapsed time', () => {
		let world = createTestWorld();
		world.timeScale = 2;

		world.update(100);

		// gameTime is the scaled simulation clock; playerTime is the unscaled wall clock.
		expect(world.gameTime).toEqual(200);
		expect(world.playerTime).toEqual(100);
	});

	it('passes the scaled elapsedTime through to systems', () => {
		let world = createTestWorld();
		let system = world.addSystem(new RecordingSystem(world));
		world.timeScale = 3;

		world.update(100);

		expect(system.elapsed).toEqual([300]);
	});
});

describe('world pause / resume', () => {
	it('pause() and resume() toggle the paused flag', () => {
		let world = createTestWorld();

		world.pause();
		expect(world.paused).toEqual(true);

		world.resume();
		expect(world.paused).toEqual(false);
	});

	it('keeps advancing playerTime but freezes gameTime while paused', () => {
		let world = createTestWorld();

		world.pause();
		world.update(100);

		expect(world.gameTime).toEqual(0);
		expect(world.playerTime).toEqual(100);
	});

	it('does not run systems while paused', () => {
		let world = createTestWorld();
		let system = world.addSystem(new RecordingSystem(world));

		world.pause();
		world.update(100);
		expect(system.elapsed).toEqual([]);

		world.resume();
		world.update(100);
		expect(system.elapsed).toEqual([100]);
	});
});

class NoopSystem extends System<Components> {
	constructor(world: TestWorld) {
		super(world, { name: 'NoopSystem' });
	}

	run() {}
}

// Records every elapsedTime it is run with so tests can assert whether (and with what value) it ran.
class RecordingSystem extends System<Components> {
	elapsed: Array<number> = [];

	constructor(world: TestWorld) {
		super(world, { name: 'RecordingSystem' });
	}

	run(elapsedTime: number) {
		this.elapsed.push(elapsedTime);
	}
}
