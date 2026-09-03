import { System, EntityWorkerSystem } from '../index';
import { createTestWorld, type Components, type TestWorld } from './fixtures/components';
import { damageUpdate, type DamageWorld, type DamageInitData } from './fixtures/damage-update';

// A minimal synchronous system whose run cadence and shouldRun the tests drive directly, so the world's deferred
// free bookkeeping (which systems a freed block waits on) can be exercised without any worker timing.
class CountingSystem extends System<Components> {
	runs = 0;
	active = true;

	constructor(world: TestWorld, name = 'Counting', deltaBetweenRuns = 0) {
		super(world, { name, deltaBetweenRuns });
	}

	run(): void {
		this.runs++;
	}
	shouldRun(): boolean {
		return this.active;
	}
}

// forceMainThread so the worker round-trip is synchronous and deterministic, while still driving the real
// EntityWorkerSystem completion path (completedRuns is bumped on the worker's run-complete, not in update()).
class DamageSystem extends EntityWorkerSystem<Components, { health: Int32Array }, DamageWorld, DamageInitData> {
	constructor(world: TestWorld) {
		super(world, {
			name: 'DamageSystem',
			required: ['health'],
			updateFunction: damageUpdate,
			forceMainThread: true,
			getWorker: () => {
				throw new Error('forceMainThread system should not build a worker');
			},
		});
	}
}

function healthLength(world: TestWorld): number {
	return world.registry.health.memoryComponent.length;
}

describe('deferred component memory free', () => {
	it('holds a removed block until a waiting system finishes a run, then frees it', () => {
		let world = createTestWorld();
		let system = new CountingSystem(world);
		world.addSystem(system);

		let entity = world.loadEntity({ maxHealth: 20 });
		entity.removeComponent('health');
		// Component gone, but its block is deferred rather than freed immediately.
		expect(healthLength(world)).toEqual(1);

		world.update(16);
		expect(system.runs).toEqual(1);
		expect(healthLength(world)).toEqual(0);
	});

	it('frees immediately when no system is running or will run', () => {
		let world = createTestWorld();
		let system = new CountingSystem(world);
		system.active = false;
		world.addSystem(system);

		let entity = world.loadEntity({ maxHealth: 20 });
		entity.removeComponent('health');

		world.update(16);
		// Nothing to wait on, so the block is freed and the system never ran.
		expect(system.runs).toEqual(0);
		expect(healthLength(world)).toEqual(0);
	});

	it('waits for every system in the buffer, not just the first to finish', () => {
		let world = createTestWorld();
		let fast = new CountingSystem(world, 'Fast');
		// Only runs once its accumulated delta crosses 100, so early updates leave it un-run.
		let slow = new CountingSystem(world, 'Slow', 100);
		world.addSystem(fast);
		world.addSystem(slow);

		let entity = world.loadEntity({ maxHealth: 20 });
		entity.removeComponent('health');

		world.update(16);
		// Fast ran, Slow has not; the block must still be held because Slow could be using it.
		expect(fast.runs).toEqual(1);
		expect(slow.runs).toEqual(0);
		expect(healthLength(world)).toEqual(1);

		// Advance until Slow's delta crosses 100 and it finally runs.
		for(let i = 0; i < 6; i++) {
			world.update(16);
		}
		expect(slow.runs).toBeGreaterThanOrEqual(1);
		expect(healthLength(world)).toEqual(0);
	});

	it('warns and frees anyway once a system has kept the buffer waiting too long', () => {
		let warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		try {
			let world = createTestWorld();
			// shouldRun stays true so it joins the wait list, but its huge delta means it never actually runs.
			let stuck = new CountingSystem(world, 'StuckSystem', Number.MAX_SAFE_INTEGER);
			world.addSystem(stuck);

			let entity = world.loadEntity({ maxHealth: 20 });
			entity.removeComponent('health');

			world.update(16);
			expect(healthLength(world)).toEqual(1);
			expect(warn).not.toHaveBeenCalled();

			// One big unscaled step past the 10s threshold: the buffer gives up, warns which system it was stuck on,
			// and frees the block rather than leaking it.
			world.update(11000);
			expect(stuck.runs).toEqual(0);
			expect(warn).toHaveBeenCalledTimes(1);
			expect(warn.mock.calls[0][0]).toContain('StuckSystem');
			expect(healthLength(world)).toEqual(0);
		} finally {
			warn.mockRestore();
		}
	});

	it('measures the wait in unscaled time, so timeScale does not trigger the warning early', () => {
		let warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		try {
			let world = createTestWorld();
			let stuck = new CountingSystem(world, 'StuckSystem', Number.MAX_SAFE_INTEGER);
			world.addSystem(stuck);
			world.timeScale = 1000;

			let entity = world.loadEntity({ maxHealth: 20 });
			entity.removeComponent('health');

			// gameTime races ahead by timeScale, but only 9s of real time has passed, so no warning yet.
			world.update(9000);
			expect(warn).not.toHaveBeenCalled();
			expect(healthLength(world)).toEqual(1);

			world.update(2000);
			expect(warn).toHaveBeenCalledTimes(1);
			expect(healthLength(world)).toEqual(0);
		} finally {
			warn.mockRestore();
		}
	});

	it('waits for an EntityWorkerSystem\'s worker run to complete before freeing', () => {
		let world = createTestWorld();
		let system = new DamageSystem(world);
		world.addSystem(system);

		let removed = world.loadEntity({ maxHealth: 20 });
		let survivor = world.loadEntity({ maxHealth: 30 });
		expect(healthLength(world)).toEqual(2);

		// Drop one entity's block; the survivor keeps the system non-empty so it still runs (and is thus waited on).
		removed.removeComponent('health');
		expect(healthLength(world)).toEqual(2);

		world.update(16);
		// The system ran over the survivor, so its worker reported back and the held block is now freed.
		expect(survivor.components.health?.health).toEqual(29);
		expect(healthLength(world)).toEqual(1);

		system.destroy();
	});

	it('does not free while paused', () => {
		let world = createTestWorld();
		let system = new CountingSystem(world);
		world.addSystem(system);

		let entity = world.loadEntity({ maxHealth: 20 });
		entity.removeComponent('health');
		world.pause();

		world.update(16);
		expect(system.runs).toEqual(0);
		expect(healthLength(world)).toEqual(1);

		world.resume();
		world.update(16);
		expect(healthLength(world)).toEqual(0);
	});
});
