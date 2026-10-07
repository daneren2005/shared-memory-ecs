import { BaseWorld, DefaultScheduler, EntityWorkerSystem, IterableSystem, System } from '../../index';
import type { Scheduler, SchedulerContext, SystemConfig, SystemError } from '../../index';
import { registry, type Components, type TestWorld } from '../../__tests__/fixtures/components';
import NodeWorkerAdapter from '../../__tests__/fixtures/node-worker-adapter';
import { damageUpdate, type DamageWorld, type DamageInitData } from '../../__tests__/fixtures/damage-update';

const CONTROLLED_WORKER_URL = new URL('../../__tests__/fixtures/controlled-node-worker.mjs', import.meta.url);

class RecordingSystem extends System<Components> {
	deltas: Array<number> = [];
	active = true;
	onRun?: () => void;

	constructor(world: TestWorld, options: SystemConfig<Components> = { name: 'Recording' }) {
		super(world, options);
	}

	run(elapsedTime: number): void {
		this.deltas.push(elapsedTime);
		this.onRun?.();
	}
	shouldRun(): boolean {
		return this.active;
	}
}

class TrackingScheduler extends DefaultScheduler<Components> {
	completed: Array<string> = [];
	systemAdded = vi.fn<NonNullable<Scheduler<Components>['systemAdded']>>();
	systemRemoved = vi.fn<NonNullable<Scheduler<Components>['systemRemoved']>>();
	reset = vi.fn<NonNullable<Scheduler<Components>['reset']>>();
	destroy = vi.fn<NonNullable<Scheduler<Components>['destroy']>>();

	runCompleted(_context: SchedulerContext<Components>, system: System<Components>): void {
		this.completed.push(system.name);
	}
}

class SlicedSystem extends IterableSystem<Components, number> {
	visited: Array<number> = [];

	constructor(world: TestWorld) {
		super(world, { name: 'Sliced', maxMsPerFrame: -1 });
	}
	getIterables(): Array<number> {
		return [1, 2];
	}
	updateIterable(iterable: number): void {
		this.visited.push(iterable);
	}
}

class ControlledSystem extends EntityWorkerSystem<Components, { health: Int32Array }> {
	constructor(world: TestWorld, name: string, control: Int32Array) {
		super(world, {
			name,
			required: ['health'],
			updateFunction: () => {},
			getInitData: () => ({ control }),
			getWorker: () => new NodeWorkerAdapter(CONTROLLED_WORKER_URL) as unknown as Worker,
		});
	}
}

function release(control: Int32Array): void {
	Atomics.store(control, 1, 1);
	Atomics.notify(control, 1);
}

describe('default scheduler', () => {
	it('is selected by default and preserves the synchronous update result', () => {
		const world = new BaseWorld(registry);
		expect(world.scheduler).toBeInstanceOf(DefaultScheduler);
		expect(world.update(16)).toEqual({ lastSystemError: null });
	});

	it('leaves clocks, pause, deferred frees, and the update envelope in the world', () => {
		const scheduler = new TrackingScheduler();
		const result = { lastSystemError: new Error('custom result') };
		const update = vi.spyOn(scheduler, 'update').mockReturnValue(result);
		const world = new BaseWorld(registry, { scheduler });
		const removed = world.loadEntity({ maxHealth: 10 });
		world.removeEntity(removed);
		world.timeScale = 3;
		const events: Array<string> = [];
		world.on('update-started', () => events.push('started'));
		world.on('update-finished', () => events.push('finished'));

		expect(world.update(10)).toBe(result);
		expect(update).toHaveBeenCalledExactlyOnceWith(world, 30);
		expect(world.gameTime).toBe(30);
		expect(world.playerTime).toBe(10);
		expect(world.registry.health.memoryComponent.length).toBe(0);
		world.pause();
		expect(world.update(10)).toEqual({});
		expect(update).toHaveBeenCalledTimes(1);
		expect(world.gameTime).toBe(30);
		expect(world.playerTime).toBe(20);
		expect(events).toEqual(['started', 'finished', 'started', 'finished']);
	});

	it('preserves firstRun, cadence remainders, and shouldRun skips', () => {
		const world = new BaseWorld(registry);
		const system = world.addSystem(new RecordingSystem(world, { name: 'Cadence', deltaBetweenRuns: 100, firstRun: true }));
		world.update(25);
		world.update(90);
		system.active = false;
		world.update(1000);
		system.active = true;
		world.update(85);

		expect(system.deltas).toEqual([0, 100, 100]);
		expect(system.currentDelta).toBe(0);
	});

	it('continues after shouldRun and update errors and preserves dispatch event payloads', () => {
		const world = new BaseWorld(registry);
		const shouldFail = world.addSystem(new RecordingSystem(world, { name: 'ShouldFail' }));
		const runFail = world.addSystem(new RecordingSystem(world, { name: 'RunFail' }));
		const skipped = world.addSystem(new RecordingSystem(world, { name: 'Skipped' }));
		const cadence = world.addSystem(new RecordingSystem(world, { name: 'Cadence', deltaBetweenRuns: 100 }));
		const healthy = world.addSystem(new RecordingSystem(world, { name: 'Healthy' }));
		const shouldError = new Error('shouldRun failed');
		const runError = new Error('run failed');
		vi.spyOn(shouldFail, 'shouldRun').mockImplementation(() => {
			throw shouldError;
		});
		runFail.onRun = () => {
			throw runError;
		};
		skipped.active = false;
		const errors: Array<SystemError> = [];
		const trace: Array<unknown> = [];
		world.on('system-error', (error: SystemError) => errors.push(error));
		for(const system of world.systems) {
			world.on(`system-${system.name}-started`, () => trace.push(system.name));
			world.on(`system-${system.name}-finished`, (payload: unknown) => trace.push(payload));
		}
		const log = vi.spyOn(console, 'error').mockImplementation(() => {});
		try {
			expect(world.update(16)).toEqual({ lastSystemError: runError });
		} finally {
			log.mockRestore();
		}

		expect(errors).toEqual([
			{ system: 'ShouldFail', error: shouldError, phase: 'run' },
			{ system: 'RunFail', error: runError, phase: 'run' },
		]);
		expect(trace).toEqual([
			'ShouldFail', { ran: false, shouldRun: true, failed: true },
			'RunFail', { ran: false, shouldRun: true, failed: true },
			'Skipped', { ran: false, shouldRun: false, failed: false },
			'Cadence', { ran: false, shouldRun: true, failed: false },
			'Healthy', { ran: true, shouldRun: true, failed: false },
		]);
		expect(skipped.currentDelta).toBe(0);
		expect(cadence.currentDelta).toBe(16);
		expect(healthy.deltas).toEqual([16]);
	});

	it('retains live forEach mutation and its captured array length', () => {
		const world = new BaseWorld(registry);
		const first = world.addSystem(new RecordingSystem(world, { name: 'First' }));
		const removed = world.addSystem(new RecordingSystem(world, { name: 'Removed' }));
		const last = world.addSystem(new RecordingSystem(world, { name: 'Last' }));
		const appended = new RecordingSystem(world, { name: 'Appended' });
		first.onRun = () => {
			world.removeSystem('Removed');
			world.addSystem(appended);
			first.onRun = undefined;
		};
		world.update(16);
		expect(removed.deltas).toEqual([]);
		expect(last.deltas).toEqual([16]);
		// Removing shifts the array, so the append still occupies an index within the captured length.
		expect(appended.deltas).toEqual([16]);
		const next = new RecordingSystem(world, { name: 'Next' });
		first.onRun = () => {
			world.addSystem(next);
		};
		world.update(16);
		expect(next.deltas).toEqual([]);
	});

	it('reads direct array replacements on the next dispatch without membership notifications', () => {
		const scheduler = new TrackingScheduler();
		const world = new BaseWorld(registry, { scheduler });
		const first = world.addSystem(new RecordingSystem(world));
		const originalLast = world.addSystem(new RecordingSystem(world));
		const replacement = new RecordingSystem(world);
		first.onRun = () => {
			world.systems = [replacement];
		};
		world.update(10);
		world.update(20);

		expect(originalLast.deltas).toEqual([10]);
		expect(replacement.deltas).toEqual([20]);
		expect(scheduler.systemAdded).toHaveBeenCalledTimes(2);
		expect(scheduler.systemRemoved).not.toHaveBeenCalled();
	});

	it('notifies membership with legacy duplicate names and first-match removal', () => {
		const scheduler = new TrackingScheduler();
		const world = new BaseWorld(registry, { scheduler });
		const first = world.addSystem(new RecordingSystem(world));
		const second = world.addSystem(new RecordingSystem(world));
		world.addSystemIfNotExists(new RecordingSystem(world));
		const unique = new RecordingSystem(world, { name: 'Unique' });
		world.addSystemIfNotExists(unique);
		world.removeSystem('missing');
		world.removeSystem(first.name);

		expect(world.systems).toEqual([second, unique]);
		expect(scheduler.systemAdded.mock.calls).toEqual([[world, first], [world, second], [world, unique]]);
		expect(scheduler.systemRemoved).toHaveBeenCalledExactlyOnceWith(world, first);
	});

	it('resets on reload and non-pristine clear and destroys once after systems', async () => {
		const scheduler = new TrackingScheduler();
		const world = new BaseWorld(registry, { scheduler });
		const system = world.addSystem(new RecordingSystem(world));
		const destroy = vi.spyOn(system, 'destroy');
		await world.clear();
		world.load({ entities: [{ maxHealth: 10 }] });
		expect(scheduler.reset).not.toHaveBeenCalled();
		world.load({ entities: [{ maxHealth: 20 }] });
		expect(scheduler.reset).toHaveBeenCalledExactlyOnceWith(world);
		await world.clear();
		expect(scheduler.reset).toHaveBeenCalledTimes(2);
		world.destroy();
		world.destroy();
		expect(destroy).toHaveBeenCalledTimes(1);
		expect(scheduler.destroy).toHaveBeenCalledExactlyOnceWith(world);
		expect(destroy.mock.invocationCallOrder[0]).toBeLessThan(scheduler.destroy.mock.invocationCallOrder[0]);
	});

	it('reports fallback completion after effects, inside dispatch before its finished event', () => {
		const scheduler = new TrackingScheduler();
		const world = new BaseWorld(registry, { scheduler });
		const entity = world.loadEntity({ maxHealth: 10 });
		const system = world.addSystem(new (class extends EntityWorkerSystem<Components, { health: Int32Array }, DamageWorld, DamageInitData> {
			constructor() {
				super(world, {
					name: 'Fallback', required: ['health'], updateFunction: damageUpdate, forceMainThread: true,
					getWorker: () => {
						throw new Error('fallback should not construct a worker');
					},
				});
			}
		})());
		const trace: Array<string> = [];
		entity.on('damaged', () => trace.push('effect'));
		const completed = vi.spyOn(scheduler, 'runCompleted').mockImplementation((context, finished) => {
			trace.push(`completed:${finished.name}`);
		});
		world.on('system-Fallback-finished', () => trace.push('dispatch-finished'));
		try {
			world.update(16);
			expect(trace).toEqual(['effect', 'completed:Fallback', 'dispatch-finished']);
			expect(completed).toHaveBeenCalledExactlyOnceWith(world, system);
			expect(entity.components.health?.health).toBe(9);
		} finally {
			world.destroy();
		}
	});

	it('keeps synchronous, worker, and sliced dispatch in registration order while two real workers overlap', async () => {
		const scheduler = new TrackingScheduler();
		const world = new BaseWorld(registry, { scheduler });
		world.loadEntity({ maxHealth: 10 });
		const controls = [0, 1].map(() => new Int32Array(new SharedArrayBuffer(8)));
		world.addSystem(new RecordingSystem(world, { name: 'Sync' }));
		const workers = controls.map((control, i) => world.addSystem(new ControlledSystem(world, `Worker${i}`, control)));
		const sliced = world.addSystem(new SlicedSystem(world));
		const dispatch: Array<string> = [];
		for(const system of world.systems) {
			world.on(`system-${system.name}-started`, () => dispatch.push(system.name));
		}
		try {
			await world.init();
			await Promise.all(workers.map(system => system.finishLoading()));
			expect(world.update(16)).toEqual({ lastSystemError: null });
			await Promise.all(controls.map(control => Promise.resolve(Atomics.waitAsync(control, 0, 0, 2000).value)));
			expect(controls.map(control => Atomics.load(control, 0))).toEqual([1, 1]);
			expect(dispatch).toEqual(['Sync', 'Worker0', 'Worker1', 'Sliced']);
			expect(workers.map(system => system.isCurrentlyRunning())).toEqual([true, true]);
			expect(scheduler.completed).toEqual(['Sync']);
			expect(sliced.visited).toEqual([1]);
			world.update(16);
			expect(sliced.visited).toEqual([1, 2]);
			expect(scheduler.completed).toEqual(['Sync', 'Sync', 'Sliced']);
			const completion = workers.map(system => Promise.resolve(system.waitForRunToComplete()));
			controls.forEach(release);
			await Promise.all(completion);
			expect(scheduler.completed.slice(3).sort()).toEqual(['Worker0', 'Worker1']);
		} finally {
			controls.forEach(release);
			world.destroy();
		}
	});

	it('does not notify completion for a stale worker reply after reload', async () => {
		const scheduler = new TrackingScheduler();
		const world = new BaseWorld(registry, { scheduler });
		world.loadEntity({ maxHealth: 10 });
		const control = new Int32Array(new SharedArrayBuffer(8));
		const system = world.addSystem(new ControlledSystem(world, 'Worker', control));
		try {
			await system.init();
			await system.finishLoading();
			world.update(16);
			await Atomics.waitAsync(control, 0, 0, 2000).value;
			expect(Atomics.load(control, 0)).toBe(1);
			world.load({ entities: [] });
			release(control);
			// FIFO load acknowledgement arrives after the discarded run-complete reply.
			await system.finishLoading();
			expect(scheduler.completed).toEqual([]);
		} finally {
			release(control);
			world.destroy();
		}
	});
});
