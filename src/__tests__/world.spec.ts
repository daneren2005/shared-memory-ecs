import { System, killEntity } from '../index';
import { createTestWorld, type Components, type TestWorld } from './fixtures/components';
import { listOf } from './fixtures/entity-collections';

describe('world load', () => {
	it('loads every entity from the config', () => {
		let world = createTestWorld();
		world.load({
			entities: [
				{ maxHealth: 20, speed: 5 },
				{ maxHealth: 10 },
			],
		});

		expect(world.entities.size).toEqual(2);
		expect(listOf(world.entities)[0].components.health?.maxHealth).toEqual(20);
		expect(listOf(world.entities)[0].components.movement?.speed).toEqual(5);
		expect(listOf(world.entities)[1].components.health?.maxHealth).toEqual(10);
	});

	it('clears existing entities and defers freeing their memory until systems have run once', () => {
		let world = createTestWorld();
		let old = world.loadEntity({ maxHealth: 20 });
		expect(world.registry.health.memoryComponent.length).toEqual(1);

		world.load({ entities: [{ maxHealth: 10 }] });

		expect(world.entities.has(old.eid)).toEqual(false);
		expect(world.getEntityByEid(old.eid)).toBeUndefined();
		// The old block is still held (new entity got a fresh one) until systems have run once over the reloaded
		// world, so a worker mid-run can't have its memory reused underneath it.
		expect(world.registry.health.memoryComponent.length).toEqual(2);
		expect(listOf(world.entities)[0].components.health?.maxHealth).toEqual(10);

		// No systems to wait on, so the next update frees the old block and the pool settles back to one.
		world.update(16);
		expect(world.registry.health.memoryComponent.length).toEqual(1);
	});

	it('clears existing systems before loading', () => {
		let world = createTestWorld();
		world.addSystem(new NoopSystem(world));
		expect(world.systems.length).toEqual(1);

		world.load({ entities: [] });
		expect(world.systems.length).toEqual(1);
	});

	it('defaults to an empty world when called with no config', () => {
		let world = createTestWorld();
		world.loadEntity({ maxHealth: 20 });
		world.addSystem(new NoopSystem(world));

		world.load({ entities: [] });

		expect(world.entities.size).toEqual(0);
		expect(world.systems.length).toEqual(1);
	});

	it('runs finishLoading only after every entity exists so deferred components see the whole world', () => {
		let world = createTestWorld();
		world.load({
			entities: [
				// Counter is first yet counts all three others; without deferral it would see zero.
				{ countsNeighbors: true },
				{ maxHealth: 20 },
				{ maxHealth: 10 },
				{ speed: 5 },
			],
		});

		let counter = listOf(world.entities)[0];
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

		expect(listOf(world.entities)[0].components.neighbors?.count).toEqual(2);
		expect(listOf(world.entities)[2].components.neighbors?.count).toEqual(2);
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

		expect(added.length).toEqual(2);
		expect(added[0]).toBe(listOf(world.entities)[0]);
		expect(added[1]).toBe(listOf(world.entities)[1]);
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
		let entity = listOf(world.entities)[0];

		// The death handler is registered once (by load, not the created = false addEntity), so one kill removes once.
		let removeEntity = vi.spyOn(world, 'removeEntity');
		killEntity(entity);

		expect(removeEntity).toHaveBeenCalledTimes(1);
		expect(removeEntity).toHaveBeenCalledWith(entity);
		expect(world.entities.has(entity.eid)).toEqual(false);
	});

	it('calls removeEntity once when an entity added through loadEntity dies', () => {
		let world = createTestWorld();
		let entity = world.loadEntity({ maxHealth: 20 });

		let removeEntity = vi.spyOn(world, 'removeEntity');
		killEntity(entity);

		expect(removeEntity).toHaveBeenCalledTimes(1);
		expect(removeEntity).toHaveBeenCalledWith(entity);
		expect(world.entities.has(entity.eid)).toEqual(false);
	});

	it('keeps the entities it is left with in the order they were added', () => {
		let world = createTestWorld();
		let first = world.loadEntity({ maxHealth: 10 });
		let second = world.loadEntity({ maxHealth: 20 });
		let third = world.loadEntity({ maxHealth: 30 });

		// Removing from the middle must not reorder the rest: iteration order is load/save order.
		world.removeEntity(second);

		expect(listOf(world.entities).map(entity => entity.eid)).toEqual([first.eid, third.eid]);
	});

	it('removes an entity in constant time regardless of how many others there are', () => {
		// Guards against a return to quadratic clearing; per-entity removal cost should stay flat with size.

		// Warm the JIT so the first run isn't paying for compilation the second gets for free.
		timeToEmpty(500);

		const small = timeToEmpty(500);
		const large = timeToEmpty(5000);

		// Loose bound (wall-clock on a shared machine): an O(n) removal would make each ~10x dearer.
		expect(large / small).toBeLessThan(4);
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

class RecordingSystem extends System<Components> {
	elapsed: Array<number> = [];

	constructor(world: TestWorld) {
		super(world, { name: 'RecordingSystem' });
	}

	run(elapsedTime: number) {
		this.elapsed.push(elapsedTime);
	}
}

function timeToEmpty(count: number): number {
	const world = createTestWorld();
	for(let i = 0; i < count; i++) {
		world.loadEntity({ maxHealth: 10 });
	}

	const entities = listOf(world.entities);
	const start = performance.now();
	for(const entity of entities) {
		world.removeEntity(entity);
	}

	return (performance.now() - start) / count;
}
