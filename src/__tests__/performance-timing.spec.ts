import { vi } from 'vitest';
import { PerformanceTiming, System } from '../index';
import type { PerformanceStats } from '../index';
import { createTestWorld, type Components, type TestWorld } from './fixtures/components';

// performance.now() is driven by hand: each call shifts the next entry off `clock`, so a test can dictate
// exactly how long an update or dispatch "took".
let clock: Array<number> = [];
beforeEach(() => {
	clock = [];
	vi.spyOn(performance, 'now').mockImplementation(() => clock.length ? clock.shift()! : 0);
});
afterEach(() => {
	vi.restoreAllMocks();
});

describe('performance timing', () => {
	it('collects update times and reports them once the window elapses', () => {
		let world = createTestWorld();
		let timing = new PerformanceTiming(world);
		let snapshots: Array<PerformanceStats> = [];
		timing.on('stats-updated', (stats: PerformanceStats) => snapshots.push(stats));

		clock = [0, 2, 0, 6, 0, 4];
		world.update(400);
		expect(snapshots.length).toEqual(0);
		world.update(400);
		expect(snapshots.length).toEqual(0);
		world.update(400);

		expect(snapshots.length).toEqual(1);
		expect(timing.stats.update).toEqual({ avg: 4, min: 2, max: 6, samples: 3 });
		expect(snapshots[0]).toBe(timing.stats);
	});

	it('starts a fresh window after reporting', () => {
		let world = createTestWorld();
		let timing = new PerformanceTiming(world);

		clock = [0, 5, 0, 9];
		world.update(1_000);
		expect(timing.stats.update).toEqual({ avg: 5, min: 5, max: 5, samples: 1 });

		world.update(1_000);
		expect(timing.stats.update).toEqual({ avg: 9, min: 9, max: 9, samples: 1 });
	});

	it('honors a configured window size', () => {
		let world = createTestWorld();
		let timing = new PerformanceTiming(world, { ticksBetweenUpdates: 100 });

		clock = [0, 3];
		world.update(100);
		expect(timing.stats.update.samples).toEqual(1);
	});

	it('ignores frames the world was paused for', () => {
		let world = createTestWorld();
		let timing = new PerformanceTiming(world, { ticksBetweenUpdates: 100 });

		world.pause();
		clock = [0, 3, 0, 3];
		world.update(100);
		world.update(100);
		expect(timing.stats.update.samples).toEqual(0);

		world.resume();
		clock = [0, 7];
		world.update(100);
		expect(timing.stats.update).toEqual({ avg: 7, min: 7, max: 7, samples: 1 });
	});

	it('tracks each system run and its event handling separately', () => {
		let world = createTestWorld();
		world.addSystem(new NoopSystem(world, 'first'));
		world.addSystem(new NoopSystem(world, 'second'));
		let timing = new PerformanceTiming(world, { ticksBetweenUpdates: 100 });

		clock = [0, 0];
		emitRun(world, 'first', 3, 1);
		emitRun(world, 'second', 5, 4);
		world.update(100);

		expect(timing.stats.systems).toEqual([
			{
				name: 'first',
				run: { avg: 3, min: 3, max: 3, samples: 1 },
				events: { avg: 1, min: 1, max: 1, samples: 1 },
			},
			{
				name: 'second',
				run: { avg: 5, min: 5, max: 5, samples: 1 },
				events: { avg: 4, min: 4, max: 4, samples: 1 },
			},
		]);
		expect(timing.getSystemStats('second')?.run.avg).toEqual(5);
		expect(timing.getSystemStats('missing')).toBeUndefined();
	});

	it('combines every system event time into one stat', () => {
		let world = createTestWorld();
		world.addSystem(new NoopSystem(world, 'first'));
		world.addSystem(new NoopSystem(world, 'second'));
		let timing = new PerformanceTiming(world, { ticksBetweenUpdates: 100 });

		clock = [0, 0];
		emitRun(world, 'first', 1, 2);
		emitRun(world, 'first', 1, 6);
		emitRun(world, 'second', 1, 3);
		emitRun(world, 'second', 1, 5);
		world.update(100);

		// Summed from per-system figures, not sampled per frame.
		expect(timing.stats.events).toEqual({ avg: 8, min: 5, max: 11, samples: 4 });
	});

	it('reports zeroes for a system that never ran off thread', () => {
		let world = createTestWorld();
		world.addSystem(new NoopSystem(world, 'main-thread'));
		let timing = new PerformanceTiming(world, { ticksBetweenUpdates: 100 });

		clock = [0, 0];
		world.update(100);

		expect(timing.stats.systems).toEqual([{
			name: 'main-thread',
			run: { avg: 0, min: 0, max: 0, samples: 0 },
			events: { avg: 0, min: 0, max: 0, samples: 0 },
		}]);
		expect(timing.stats.events).toEqual({ avg: 0, min: 0, max: 0, samples: 0 });
	});

	it('follows systems added and removed after it was created', () => {
		let world = createTestWorld();
		let timing = new PerformanceTiming(world, { ticksBetweenUpdates: 100 });
		world.addSystem(new NoopSystem(world, 'late'));

		clock = [0, 0];
		emitRun(world, 'late', 2, 1);
		world.update(100);
		expect(timing.stats.systems.length).toEqual(1);
		expect(timing.stats.systems[0].run.avg).toEqual(2);

		world.removeSystem('late');
		clock = [0, 0];
		// Untracked now, so its report is dropped.
		emitRun(world, 'late', 9, 9);
		world.update(100);
		expect(timing.stats.systems).toEqual([]);
	});

	it('stops collecting once destroyed', () => {
		let world = createTestWorld();
		world.addSystem(new NoopSystem(world, 'first'));
		let timing = new PerformanceTiming(world, { ticksBetweenUpdates: 100 });

		timing.destroy();
		clock = [0, 5];
		emitRun(world, 'first', 3, 1);
		world.update(100);

		expect(timing.stats.update.samples).toEqual(0);
		expect(timing.stats.systems).toEqual([]);
	});

	it('throws away collected samples on reset', () => {
		let world = createTestWorld();
		let timing = new PerformanceTiming(world, { ticksBetweenUpdates: 200 });

		clock = [0, 5];
		world.update(100);
		timing.reset();

		clock = [0, 9];
		world.update(100);
		expect(timing.stats.update.samples).toEqual(0);

		clock = [0, 11];
		world.update(100);
		expect(timing.stats.update).toEqual({ avg: 10, min: 9, max: 11, samples: 2 });
	});
});

// Fakes one worker run of `name` (taking `runTime`) whose events then take `eventTime`, via the same events
// ComponentSystem emits around a dispatch.
function emitRun(world: TestWorld, name: string, runTime: number, eventTime: number) {
	clock.unshift(0, eventTime);
	world.emit(`system-${name}-worker-finished`, runTime);
	world.emit(`system-${name}-worker-events-finished`, runTime);
}

class NoopSystem extends System<Components> {
	constructor(world: TestWorld, name: string) {
		super(world, { name });
	}

	run() {}
}
