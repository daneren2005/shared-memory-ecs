import { BaseWorld, ConflictScheduler, System, EntityWorkerSystem } from '../index';
import { createTestWorld, registry, type Components, type TestWorld } from './fixtures/components';
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

// Stands in for a worker or batched run still in flight across updates.
class InFlightSystem extends CountingSystem {
	inFlight = false;

	isCurrentlyRunning(): boolean {
		return this.inFlight;
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
	it('holds a removed block until the next update, then frees it', () => {
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

	it.each([
		['default', () => createTestWorld()],
		['conflict', (): TestWorld => new BaseWorld(registry, { scheduler: new ConflictScheduler<Components>() })],
	])('does not wait on a system whose next run has not started (%s scheduler)', (_name, createWorld) => {
		let world = createWorld();
		// Wants to run but is throttled: a run that hasn't started only sees live entities, so it can't hold the block.
		let slow = new CountingSystem(world, 'Slow', 1000);
		world.addSystem(slow);

		let entity = world.loadEntity({ maxHealth: 20 });
		entity.removeComponent('health');

		world.update(16);
		expect(slow.runs).toEqual(0);
		expect(healthLength(world)).toEqual(0);
	});

	it('waits for every in-flight system, not just the first to finish', () => {
		let world = createTestWorld();
		let first = new InFlightSystem(world, 'First', 1000);
		let second = new InFlightSystem(world, 'Second', 1000);
		first.inFlight = true;
		second.inFlight = true;
		world.addSystem(first);
		world.addSystem(second);

		let entity = world.loadEntity({ maxHealth: 20 });
		entity.removeComponent('health');
		world.update(16);

		first.inFlight = false;
		world.notifySystemRunCompleted(first);
		expect(healthLength(world)).toEqual(1);

		second.inFlight = false;
		world.notifySystemRunCompleted(second);
		expect(healthLength(world)).toEqual(0);
	});

	it('warns and frees anyway once a system has kept the buffer waiting too long', () => {
		let warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		try {
			let world = createTestWorld();
			// Mid-run and never reports completion.
			let stuck = new InFlightSystem(world, 'StuckSystem', Number.MAX_SAFE_INTEGER);
			stuck.inFlight = true;
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
			let stuck = new InFlightSystem(world, 'StuckSystem', Number.MAX_SAFE_INTEGER);
			stuck.inFlight = true;
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

		// The survivor's run is in flight when the block is orphaned, so the block waits for it.
		world.update(16);
		removed.removeComponent('health');
		Reflect.set(system, 'isRunning', true);
		world.update(16);
		expect(healthLength(world)).toEqual(2);

		// Its worker reports back, so the held block is now freed.
		Reflect.set(system, 'isRunning', false);
		world.notifySystemRunCompleted(system);
		expect(survivor.components.health?.health).toEqual(29);
		expect(healthLength(world)).toEqual(1);

		system.destroy();
	});

	it('keeps waiting on a skipped system whose run is still in flight', () => {
		let world = createTestWorld();
		let system = new InFlightSystem(world, 'InFlight', 1000);
		world.addSystem(system);

		let entity = world.loadEntity({ maxHealth: 20 });
		entity.removeComponent('health');

		system.inFlight = true;
		world.update(16);
		system.active = false;
		world.update(16);
		expect(healthLength(world)).toEqual(1);

		system.inFlight = false;
		world.notifySystemRunCompleted(system);
		expect(healthLength(world)).toEqual(0);
	});

	it('stops waiting on a system removed from the world', () => {
		let world = createTestWorld();
		let removed = new InFlightSystem(world, 'Removed', 1000);
		removed.inFlight = true;
		world.addSystem(removed);

		let entity = world.loadEntity({ maxHealth: 20 });
		entity.removeComponent('health');

		world.update(16);
		expect(healthLength(world)).toEqual(1);

		world.removeSystem('Removed');
		expect(healthLength(world)).toEqual(0);
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
