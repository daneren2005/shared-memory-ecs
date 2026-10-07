import { BaseWorld, ConflictScheduler, EntitySystem, EntityWorkerSystem, IterableSystem, System, WorkerSystem } from '../../index';
import type { EntityWorkerSystemConfig, SystemConfig, SystemError } from '../../index';
import { registry, type Components, type TestWorld } from '../../__tests__/fixtures/components';
import NodeWorkerAdapter from '../../__tests__/fixtures/node-worker-adapter';

const CONTROLLED_WORKER_URL = new URL('../../__tests__/fixtures/controlled-node-worker.mjs', import.meta.url);

class RecordingSystem extends System<Components> {
	deltas: Array<number> = [];
	gameTimes: Array<number> = [];
	active = true;
	busy = false;
	onRun?: () => void;

	constructor(world: TestWorld, options: SystemConfig<Components>, private readonly deferred = false) {
		super(world, options);
	}
	run(elapsedTime: number): void {
		this.deltas.push(elapsedTime);
		this.gameTimes.push(this.gameTime);
		this.busy = this.deferred;
		this.onRun?.();
	}
	update(elapsedTime: number): boolean {
		return this.busy ? false : super.update(elapsedTime);
	}
	shouldRun(): boolean {
		return this.active;
	}
	isCurrentlyRunning(): boolean {
		return this.busy;
	}
	protected onRunFinished(): void {
		if(!this.busy) {
			super.onRunFinished();
		}
	}
	complete(): void {
		this.busy = false;
		super.onRunFinished();
	}
}

class SlicedRecordingSystem extends IterableSystem<Components, number> {
	visits: Array<{ value: number, delta: number, gameTime: number }> = [];

	constructor(world: TestWorld) {
		super(world, { name: 'Sliced', reads: [], writes: ['health'], maxMsPerFrame: -1 });
	}
	getIterables(): Array<number> {
		return [1, 2, 3];
	}
	updateIterable(value: number, delta: number): void {
		this.visits.push({ value, delta, gameTime: this.gameTime });
	}
}

function createWorld(): TestWorld {
	return new BaseWorld(registry, { scheduler: new ConflictScheduler<Components>() });
}

describe('conflict scheduler', () => {
	it('compiles frozen batches and their execution order before the first update', () => {
		const world = createWorld();
		const scheduler = world.scheduler as ConflictScheduler<Components>;
		const reader = world.addSystem(new RecordingSystem(world, { name: 'Reader', reads: ['health'], writes: [] }));
		const writer = world.addSystem(new RecordingSystem(world, { name: 'Writer', reads: [], writes: ['health'] }));
		const later = world.addSystem(new RecordingSystem(world, { name: 'Later', reads: ['health'], writes: [] }));
		const independent = world.addSystem(new RecordingSystem(world, { name: 'Independent', reads: ['movement'], writes: [] }));
		expect(scheduler.schedule.batches).toEqual([[reader, independent], [writer], [later]]);
		expect(scheduler.schedule.order).toEqual([reader, independent, writer, later]);
		expect(Object.isFrozen(scheduler.schedule)).toBe(true);
		expect(Object.isFrozen(scheduler.schedule.order)).toBe(true);
		expect(Object.isFrozen(scheduler.schedule.batches)).toBe(true);
		expect(scheduler.schedule.batches.every(Object.isFrozen)).toBe(true);
		expect(reader.deltas).toEqual([]);
	});

	it('reuses the compiled schedule across updates and queued passes', async () => {
		const world = createWorld();
		const scheduler = world.scheduler as ConflictScheduler<Components>;
		const writer = world.addSystem(new RecordingSystem(world, { name: 'Writer', reads: [], writes: ['health'] }, true));
		const reader = world.addSystem(new RecordingSystem(world, { name: 'Reader', reads: ['health'], writes: [] }));
		const schedule = scheduler.schedule;
		const reads = vi.spyOn(writer, 'readComponents', 'get');
		const readerReads = vi.spyOn(reader, 'readComponents', 'get');
		world.update(10);
		world.update(20);
		writer.complete();
		await Promise.resolve();
		expect(reader.deltas).toEqual([10]);
		expect(writer.deltas).toEqual([10, 20]);
		writer.complete();
		await Promise.resolve();
		expect(reader.deltas).toEqual([10, 20]);
		expect(scheduler.schedule).toBe(schedule);
		expect(reads).not.toHaveBeenCalled();
		expect(readerReads).not.toHaveBeenCalled();
	});

	it('releases a dependent without waiting for unrelated members of its compiled batch', async () => {
		const world = createWorld();
		const health = world.addSystem(new RecordingSystem(world, { name: 'Health', reads: [], writes: ['health'] }, true));
		const movement = world.addSystem(new RecordingSystem(world, { name: 'Movement', reads: [], writes: ['movement'] }, true));
		const reader = world.addSystem(new RecordingSystem(world, { name: 'Reader', reads: ['health'], writes: [] }));
		world.update(16);
		expect(health.deltas).toEqual([16]);
		expect(movement.deltas).toEqual([16]);
		health.complete();
		await Promise.resolve();
		expect(reader.deltas).toEqual([16]);
		expect(movement.isCurrentlyRunning()).toBe(true);
		movement.complete();
		await Promise.resolve();
		expect(reader.deltas).toEqual([16]);
	});

	it('lets an independent frequent system keep its cadence across updates while a slow run is unfinished', () => {
		const world = createWorld();
		const slow = world.addSystem(new RecordingSystem(world, { name: 'Slow', reads: [], writes: ['health'], firstRun: true, deltaBetweenRuns: 1000 }, true));
		const frequent = world.addSystem(new RecordingSystem(world, { name: 'Frequent', reads: [], writes: ['movement'], deltaBetweenRuns: 32 }));
		for(let frame = 0; frame < 6; frame++) {
			world.update(16);
		}
		expect(slow.deltas).toEqual([0]);
		expect(slow.isCurrentlyRunning()).toBe(true);
		expect(frequent.deltas).toEqual([32, 32, 32]);
		expect(frequent.gameTimes).toEqual([32, 64, 96]);
		expect(frequent.currentDelta).toBe(0);
		world.destroy();
	});

	it.each([
		{ name: 'reader before writer', earlier: { reads: ['health'], writes: [] }, later: { reads: [], writes: ['health'] } },
		{ name: 'writer before reader', earlier: { reads: [], writes: ['health'] }, later: { reads: ['health'], writes: [] } },
		{ name: 'writer before writer', earlier: { reads: [], writes: ['health'] }, later: { reads: [], writes: ['health'] } },
	] satisfies Array<{
		name: string
		earlier: Omit<SystemConfig<Components>, 'name'>
		later: Omit<SystemConfig<Components>, 'name'>
	}>)('preserves $name ordering across queued updates', async ({ earlier, later }) => {
		const world = createWorld();
		const first = world.addSystem(new RecordingSystem(world, { name: 'First', ...earlier }, true));
		const second = world.addSystem(new RecordingSystem(world, { name: 'Second', ...later }));
		const trace: Array<string> = [];
		first.onRun = () => trace.push(`first:${first.gameTime}`);
		second.onRun = () => trace.push(`second:${second.gameTime}`);
		world.update(16);
		world.update(16);
		world.update(16);
		for(let run = 0; run < 3; run++) {
			first.complete();
			await Promise.resolve();
		}
		expect(trace).toEqual(['first:16', 'second:16', 'first:32', 'second:32', 'first:48', 'second:48']);
		world.destroy();
	});

	it('lets independent readers advance but holds their next reads behind an earlier pending writer', async () => {
		const world = createWorld();
		const slowReader = world.addSystem(new RecordingSystem(world, { name: 'SlowReader', reads: ['health'], writes: [] }, true));
		const fastReader = world.addSystem(new RecordingSystem(world, { name: 'FastReader', reads: ['health'], writes: [] }));
		const writer = world.addSystem(new RecordingSystem(world, { name: 'Writer', reads: [], writes: ['health'] }));
		world.update(16);
		world.update(16);
		expect(fastReader.gameTimes).toEqual([16]);
		expect(writer.gameTimes).toEqual([]);
		slowReader.complete();
		await Promise.resolve();
		expect(writer.gameTimes).toEqual([16]);
		expect(fastReader.gameTimes).toEqual([16, 32]);
		expect(slowReader.gameTimes).toEqual([16, 32]);
		world.destroy();
	});

	it('lets readers on different systems overlap across updates when no writer is pending', () => {
		const world = createWorld();
		const slow = world.addSystem(new RecordingSystem(world, { name: 'Slow', reads: ['health'], writes: [] }, true));
		const fast = world.addSystem(new RecordingSystem(world, { name: 'Fast', reads: ['health'], writes: [] }));
		world.update(16);
		world.update(16);
		world.update(16);
		expect(slow.gameTimes).toEqual([16]);
		expect(fast.gameTimes).toEqual([16, 32, 48]);
		world.destroy();
	});

	it.each([
		['health', 'health', 'health', 'movement', 'movement', 'movement'],
		['movement', 'movement', 'movement', 'health', 'health', 'health'],
		['health', 'movement', 'movement', 'health', 'health', 'movement'],
	])('produces the same per-system results with completion order %j', async (...completions: Array<string>) => {
		const world = createWorld();
		let health = 0;
		let movement = 0;
		const healthValues: Array<number> = [];
		const movementValues: Array<number> = [];
		const healthWriter = world.addSystem(new RecordingSystem(world, { name: 'HealthWriter', reads: [], writes: ['health'] }, true));
		const movementWriter = world.addSystem(new RecordingSystem(world, { name: 'MovementWriter', reads: [], writes: ['movement'] }, true));
		const healthReader = world.addSystem(new RecordingSystem(world, { name: 'HealthReader', reads: ['health'], writes: [] }));
		const movementReader = world.addSystem(new RecordingSystem(world, { name: 'MovementReader', reads: ['movement'], writes: [] }));
		healthWriter.onRun = () => {
			health = health * 10 + healthWriter.gameTime;
		};
		movementWriter.onRun = () => {
			movement = movement * 10 + movementWriter.gameTime;
		};
		healthReader.onRun = () => healthValues.push(health);
		movementReader.onRun = () => movementValues.push(movement);
		for(let frame = 0; frame < 3; frame++) {
			world.update(16);
		}
		for(const completion of completions) {
			(completion === 'health' ? healthWriter : movementWriter).complete();
			await Promise.resolve();
		}
		expect(healthValues).toEqual([16, 192, 1968]);
		expect(movementValues).toEqual([16, 192, 1968]);
		expect(healthWriter.gameTimes).toEqual([16, 32, 48]);
		expect(movementWriter.gameTimes).toEqual([16, 32, 48]);
		world.destroy();
	});

	it('preserves outstanding access reservations when metadata changes before another update', async () => {
		const world = createWorld();
		const scheduler = world.scheduler as ConflictScheduler<Components>;
		const writes: Array<keyof Components> = ['health'];
		const writer = world.addSystem(new RecordingSystem(world, { name: 'Writer', reads: [], writes }, true));
		world.update(16);
		writes[0] = 'movement';
		scheduler.rebuild(world);
		const reader = world.addSystem(new RecordingSystem(world, { name: 'Reader', reads: ['health'], writes: [] }));
		world.update(16);
		expect(reader.gameTimes).toEqual([]);
		writer.complete();
		await Promise.resolve();
		expect(reader.gameTimes).toEqual([32]);
		expect(writer.isCurrentlyRunning()).toBe(true);
		world.destroy();
	});

	it('keeps exclusive runs as barriers across updates, including pending exclusive work', async () => {
		const world = createWorld();
		const first = world.addSystem(new RecordingSystem(world, { name: 'First', reads: [], writes: ['health'] }, true));
		const exclusive = world.addSystem(new RecordingSystem(world, { name: 'Exclusive', reads: [], writes: [], exclusive: true }, true));
		const independent = world.addSystem(new RecordingSystem(world, { name: 'Independent', reads: [], writes: ['movement'] }));
		world.update(16);
		world.update(16);
		expect(independent.gameTimes).toEqual([]);
		first.complete();
		await Promise.resolve();
		expect(exclusive.gameTimes).toEqual([16]);
		expect(independent.gameTimes).toEqual([]);
		exclusive.complete();
		await Promise.resolve();
		expect(independent.gameTimes).toEqual([16]);
		expect(first.gameTimes).toEqual([16, 32]);
		world.destroy();
	});

	it('uses the queued logical time for shouldRun and dispatch without changing the world clock', async () => {
		const world = createWorld();
		world.gameTime = 1000;
		world.timeScale = 2;
		const blocker = world.addSystem(new RecordingSystem(world, { name: 'Blocker', reads: [], writes: ['health'] }, true));
		const reader = world.addSystem(new RecordingSystem(world, { name: 'Reader', reads: ['health'], writes: [] }));
		const checks: Array<number> = [];
		vi.spyOn(reader, 'shouldRun').mockImplementation(() => {
			checks.push(reader.gameTime);
			return true;
		});
		world.update(10);
		world.update(20);
		checks.length = 0;
		blocker.complete();
		await Promise.resolve();
		expect(reader.gameTimes).toEqual([1020]);
		expect(checks).toEqual([1020]);
		expect(reader.deltas).toEqual([20]);
		expect(world.gameTime).toBe(1060);
		expect(reader.gameTime).toBe(1060);
		world.destroy();
	});

	it('rebuilds on membership changes and explicitly rebuilds changed declarations', () => {
		const world = createWorld();
		const scheduler = world.scheduler as ConflictScheduler<Components>;
		const writes: Array<keyof Components> = ['health'];
		const first = world.addSystem(new RecordingSystem(world, { name: 'First', reads: [], writes }));
		const second = world.addSystem(new RecordingSystem(world, { name: 'Second', reads: ['movement'], writes: [] }));
		expect(scheduler.schedule.batches).toEqual([[first, second]]);
		writes.push('movement');
		expect(scheduler.rebuild(world).batches).toEqual([[first], [second]]);
		world.removeSystem('First');
		expect(scheduler.schedule.batches).toEqual([[second]]);
		world.systems = [first];
		scheduler.rebuild(world);
		expect(scheduler.schedule.batches).toEqual([[first]]);
	});

	it('keeps an active pass on its original schedule when membership changes', async () => {
		const world = createWorld();
		const scheduler = world.scheduler as ConflictScheduler<Components>;
		const writer = world.addSystem(new RecordingSystem(world, { name: 'Writer', reads: [], writes: ['health'] }, true));
		const reader = world.addSystem(new RecordingSystem(world, { name: 'Reader', reads: ['health'], writes: [] }));
		const original = scheduler.schedule;
		world.update(10);
		const added = world.addSystem(new RecordingSystem(world, { name: 'Added', reads: [], writes: [] }));
		expect(scheduler.schedule).not.toBe(original);
		writer.complete();
		await Promise.resolve();
		expect(reader.deltas).toEqual([10]);
		expect(added.deltas).toEqual([]);
		world.update(20);
		expect(added.deltas).toEqual([20]);
	});

	it('cancels queued automatic dispatch on reset and destroy', async () => {
		for(const destroy of [false, true]) {
			const world = createWorld();
			world.loadEntity({ maxHealth: 10 });
			const writer = world.addSystem(new RecordingSystem(world, { name: 'Writer', reads: [], writes: ['health'] }, true));
			const reader = world.addSystem(new RecordingSystem(world, { name: 'Reader', reads: ['health'], writes: [] }));
			world.update(10);
			world.update(20);
			writer.complete();
			if(destroy) {
				world.destroy();
			} else {
				world.load({ entities: [] });
			}
			await Promise.resolve();
			expect(reader.deltas).toEqual([]);
			world.destroy();
		}
	});

	it.each(['pause', 'assignment'] as const)('drains queued updates while paused through %s without enqueueing more work', async mode => {
		const world = createWorld();
		world.timeScale = 2;
		const writer = world.addSystem(new RecordingSystem(world, { name: 'Writer', reads: [], writes: ['health'] }, true));
		const reader = world.addSystem(new RecordingSystem(world, { name: 'Reader', reads: ['health'], writes: [] }));
		world.update(10);
		world.update(20);
		if(mode === 'pause') {
			world.pause();
		} else {
			world.paused = true;
		}
		const added = world.addSystem(new RecordingSystem(world, { name: 'Added', reads: [], writes: [] }));
		world.update(100);
		writer.complete();
		await Promise.resolve();
		expect(reader.deltas).toEqual([20]);
		expect(writer.deltas).toEqual([20, 40]);
		writer.complete();
		await Promise.resolve();
		expect(reader.deltas).toEqual([20, 40]);
		expect(reader.gameTimes).toEqual([20, 60]);
		expect(writer.gameTimes).toEqual([20, 60]);
		expect(writer.isCurrentlyRunning()).toBe(false);
		expect(added.deltas).toEqual([]);
		expect(world.gameTime).toBe(60);
		expect(world.playerTime).toBe(130);
		expect(world.paused).toBe(true);
		world.resume();
		world.update(5);
		writer.complete();
		await Promise.resolve();
		expect(reader.deltas).toEqual([20, 40, 10]);
		expect(added.deltas).toEqual([10]);
		world.destroy();
	});

	it('drains active and queued slices while paused without further host updates', async () => {
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
		const world = createWorld();
		const sliced = world.addSystem(new SlicedRecordingSystem(world));
		const reader = world.addSystem(new RecordingSystem(world, { name: 'Reader', reads: ['health'], writes: [] }));
		try {
			world.update(10);
			world.update(20);
			expect(sliced.visits.map(visit => visit.value)).toEqual([1, 2]);
			world.paused = true;
			await vi.runAllTimersAsync();
			expect(sliced.visits).toEqual([
				{ value: 1, delta: 10, gameTime: 10 },
				{ value: 2, delta: 10, gameTime: 10 },
				{ value: 3, delta: 10, gameTime: 10 },
				{ value: 1, delta: 20, gameTime: 30 },
				{ value: 2, delta: 20, gameTime: 30 },
				{ value: 3, delta: 20, gameTime: 30 },
			]);
			expect(reader.deltas).toEqual([10, 20]);
			expect(reader.gameTimes).toEqual([10, 30]);
			expect(sliced.currentDelta).toBe(0);
			expect(sliced.isCurrentlyRunning()).toBe(false);
			expect(world.gameTime).toBe(30);
			expect(world.playerTime).toBe(30);
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			world.destroy();
			vi.useRealTimers();
		}
	});

	it('automatically drains slices first dispatched by a worker completion while paused', async () => {
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
		const world = createWorld();
		const writer = world.addSystem(new RecordingSystem(world, { name: 'Writer', reads: [], writes: ['health'] }, true));
		const sliced = world.addSystem(new SlicedRecordingSystem(world));
		const reader = world.addSystem(new RecordingSystem(world, { name: 'Reader', reads: ['health'], writes: [] }));
		try {
			world.update(10);
			world.pause();
			expect(vi.getTimerCount()).toBe(0);
			writer.complete();
			await vi.runAllTimersAsync();
			expect(sliced.visits.map(visit => visit.value)).toEqual([1, 2, 3]);
			expect(reader.deltas).toEqual([10]);
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			world.destroy();
			vi.useRealTimers();
		}
	});

	it.each(['reset', 'reload', 'clear', 'destroy'] as const)('cancels paused slice continuations on %s', async action => {
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
		const world = createWorld();
		world.loadEntity({ maxHealth: 10 });
		const sliced = world.addSystem(new SlicedRecordingSystem(world));
		const reader = world.addSystem(new RecordingSystem(world, { name: 'Reader', reads: ['health'], writes: [] }));
		try {
			world.update(10);
			world.pause();
			expect(vi.getTimerCount()).toBe(1);
			if(action === 'reset') {
				world.scheduler.reset?.(world);
			} else if(action === 'reload') {
				world.load({ entities: [] });
			} else if(action === 'clear') {
				await world.clear();
			} else {
				world.destroy();
			}
			await vi.runAllTimersAsync();
			expect(sliced.visits.map(visit => visit.value)).toEqual([1]);
			expect(reader.deltas).toEqual([]);
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			world.destroy();
			vi.useRealTimers();
		}
	});

	it('prepares shared memory again before automatically dispatching another batch', async () => {
		const world = createWorld();
		const prepare = vi.spyOn(world, 'prepareForSystemDispatch');
		const writer = world.addSystem(new RecordingSystem(world, { name: 'Writer', reads: [], writes: ['health'] }, true));
		const reader = world.addSystem(new RecordingSystem(world, { name: 'Reader', reads: ['health'], writes: [] }));
		reader.onRun = () => expect(prepare).toHaveBeenCalled();
		world.update(10);
		prepare.mockClear();
		writer.complete();
		await Promise.resolve();
		expect(reader.deltas).toEqual([10]);
	});

	it('reports errors from automatically dispatched systems through system-error', async () => {
		const world = createWorld();
		const writer = world.addSystem(new RecordingSystem(world, { name: 'Writer', reads: [], writes: ['health'] }, true));
		const broken = world.addSystem(new RecordingSystem(world, { name: 'Broken', reads: ['health'], writes: [] }));
		const error = new Error('automatic dispatch failed');
		broken.onRun = () => {
			throw error;
		};
		const errors: Array<SystemError> = [];
		world.on('system-error', (payload: SystemError) => errors.push(payload));
		const log = vi.spyOn(console, 'error').mockImplementation(() => {});
		try {
			world.update(10);
			writer.complete();
			await Promise.resolve();
			expect(errors).toEqual([{ system: 'Broken', error, phase: 'run' }]);
		} finally {
			log.mockRestore();
		}
	});

	it.each([
		{ name: 'read/read', first: { reads: ['health'], writes: [] }, second: { reads: ['health'], writes: [] }, overlaps: true },
		{ name: 'write/read', first: { reads: [], writes: ['health'] }, second: { reads: ['health'], writes: [] }, overlaps: false },
		{ name: 'read/write', first: { reads: ['health'], writes: [] }, second: { reads: [], writes: ['health'] }, overlaps: false },
		{ name: 'write/write', first: { reads: [], writes: ['health'] }, second: { reads: [], writes: ['health'] }, overlaps: false },
		{ name: 'disjoint writes', first: { reads: [], writes: ['health'] }, second: { reads: [], writes: ['movement'] }, overlaps: true },
	] satisfies Array<{
		name: string
		first: Omit<SystemConfig<Components>, 'name'>
		second: Omit<SystemConfig<Components>, 'name'>
		overlaps: boolean
	}>)('$name conflicts', async ({ first, second, overlaps }) => {
		const world = createWorld();
		const a = world.addSystem(new RecordingSystem(world, { name: 'A', ...first }, true));
		const b = world.addSystem(new RecordingSystem(world, { name: 'B', ...second }, true));
		world.update(16);
		expect(a.deltas).toEqual([16]);
		expect(b.deltas).toEqual(overlaps ? [16] : []);
		if(!overlaps) {
			a.complete();
			await Promise.resolve();
			expect(b.deltas).toEqual([16]);
		}
	});

	it('does not let a later reader overtake a blocked writer', () => {
		const world = createWorld();
		const reader = world.addSystem(new RecordingSystem(world, { name: 'Reader', reads: ['health'], writes: [] }, true));
		const writer = world.addSystem(new RecordingSystem(world, { name: 'Writer', reads: [], writes: ['health'] }, true));
		const later = world.addSystem(new RecordingSystem(world, { name: 'Later', reads: ['health'], writes: [] }));
		const independent = world.addSystem(new RecordingSystem(world, { name: 'Independent', reads: ['movement'], writes: [] }));
		world.update(10);
		expect(later.deltas).toEqual([]);
		expect(independent.deltas).toEqual([10]);
		reader.complete();
		world.update(20);
		expect(writer.deltas).toEqual([10]);
		expect(later.deltas).toEqual([]);
		writer.complete();
		world.update(30);
		expect(later.deltas).toEqual([10]);
		expect(reader.deltas).toEqual([10, 20]);
	});

	it('queues exact update deltas and prevents later batches overtaking unfinished runs', () => {
		const world = createWorld();
		const writer = world.addSystem(new RecordingSystem(world, { name: 'Writer', reads: [], writes: ['health'] }, true));
		const reader = world.addSystem(new RecordingSystem(world, { name: 'Reader', reads: ['health'], writes: [] }));
		world.update(10);
		world.update(20);
		world.update(30);
		expect(writer.deltas).toEqual([10]);
		expect(reader.deltas).toEqual([]);
		writer.complete();
		world.update(40);
		expect(reader.deltas).toEqual([10]);
		expect(writer.deltas).toEqual([10, 20]);
		writer.complete();
		world.update(50);
		expect(reader.deltas).toEqual([10, 20]);
		expect(writer.deltas).toEqual([10, 20, 30]);
	});

	it('waits for applied-effects completion even after execution reports it is no longer running', () => {
		const world = createWorld();
		const writer = world.addSystem(new RecordingSystem(world, { name: 'Writer', reads: [], writes: ['health'] }, true));
		const reader = world.addSystem(new RecordingSystem(world, { name: 'Reader', reads: ['health'], writes: [] }));
		world.update(10);
		writer.busy = false;
		world.update(20);
		expect(writer.deltas).toEqual([10]);
		expect(reader.deltas).toEqual([]);
		writer.complete();
		world.update(30);
		expect(reader.deltas).toEqual([10]);
	});

	it('keeps reservations for a removed running system until it completes', () => {
		const world = createWorld();
		const writer = world.addSystem(new RecordingSystem(world, { name: 'Writer', reads: [], writes: ['health'] }, true));
		const reader = world.addSystem(new RecordingSystem(world, { name: 'Reader', reads: ['health'], writes: [] }));
		world.update(10);
		world.removeSystem('Writer');
		world.update(20);
		expect(reader.deltas).toEqual([]);
		writer.complete();
		world.update(30);
		expect(reader.deltas).toEqual([10, 20, 30]);
	});

	it.each(['createsEntities', 'addsComponents'] as const)('makes %s workers exclusive', capability => {
		const world = createWorld();
		const worker = world.addSystem(new (class extends EntityWorkerSystem<Components, { health: Int32Array }> {})(world, {
			name: 'Structural', required: [], writes: [], [capability]: true, forceMainThread: true,
			updateFunction: () => {}, getWorker: () => {
				throw new Error('fallback');
			},
		}));
		try {
			expect(worker.requiresExclusiveScheduling).toBe(true);
		} finally {
			world.destroy();
		}
	});

	it.each([
		{ reads: ['health'] },
		{ writes: ['health'] },
		{},
		{ reads: [], writes: [], exclusive: true },
	] satisfies Array<Omit<SystemConfig<Components>, 'name'>>)('serializes undeclared or exclusive access: %j', options => {
		const world = createWorld();
		world.addSystem(new RecordingSystem(world, { name: 'First', ...options }, true));
		const independent = world.addSystem(new RecordingSystem(world, { name: 'Next', reads: [], writes: [] }));
		world.update(16);
		expect(independent.deltas).toEqual([]);
	});

	it('preserves firstRun, cadence remainders, inactive skips, and synchronous dispatch events', () => {
		const world = createWorld();
		const system = world.addSystem(new RecordingSystem(world, { name: 'Cadence', reads: [], writes: [], deltaBetweenRuns: 100, firstRun: true }));
		const trace: Array<unknown> = [];
		world.on('system-Cadence-started', () => trace.push('started'));
		world.on('system-Cadence-finished', (payload: unknown) => trace.push(payload));
		world.update(25);
		world.update(90);
		system.active = false;
		world.update(1000);
		system.active = true;
		world.update(85);
		expect(system.deltas).toEqual([0, 100, 100]);
		expect(system.currentDelta).toBe(0);
		expect(trace).toEqual([
			'started', { ran: true, shouldRun: true, failed: false },
			'started', { ran: true, shouldRun: true, failed: false },
			'started', { ran: false, shouldRun: false, failed: false },
			'started', { ran: true, shouldRun: true, failed: false },
		]);
	});

	it('releases dependencies after cadence skips and dispatch errors', () => {
		const world = createWorld();
		const cadence = world.addSystem(new RecordingSystem(world, { name: 'Cadence', reads: [], writes: ['health'], deltaBetweenRuns: 100 }));
		const broken = world.addSystem(new RecordingSystem(world, { name: 'Broken', reads: [], writes: ['health'] }));
		const reader = world.addSystem(new RecordingSystem(world, { name: 'Reader', reads: ['health'], writes: [] }));
		const error = new Error('broken');
		broken.onRun = () => {
			throw error;
		};
		const errors: Array<SystemError> = [];
		world.on('system-error', (payload: SystemError) => errors.push(payload));
		const log = vi.spyOn(console, 'error').mockImplementation(() => {});
		try {
			expect(world.update(16)).toEqual({ lastSystemError: error });
			expect(cadence.deltas).toEqual([]);
			expect(reader.deltas).toEqual([16]);
			expect(errors).toEqual([{ system: 'Broken', error, phase: 'run' }]);
		} finally {
			log.mockRestore();
		}
	});

	it('holds sliced run dependencies until the queue drains without counting elapsed time twice', () => {
		const world = createWorld();
		const visited: Array<number> = [];
		const sliced = world.addSystem(new (class extends IterableSystem<Components, number> {
			constructor() {
				super(world, { name: 'Sliced', reads: [], writes: ['health'], maxMsPerFrame: -1 });
			}
			getIterables(): Array<number> {
				return [1, 2, 3];
			}
			updateIterable(value: number): void {
				visited.push(value);
			}
		})());
		const reader = world.addSystem(new RecordingSystem(world, { name: 'Reader', reads: ['health'], writes: [] }));
		world.update(10);
		expect(visited).toEqual([1]);
		world.update(20);
		expect(visited).toEqual([1, 2]);
		expect(reader.deltas).toEqual([]);
		world.update(30);
		expect(visited).toEqual([1, 2, 3, 1]);
		expect(reader.deltas).toEqual([10]);
		expect(sliced.currentDelta).toBe(0);
	});

	it('infers main, optional, and named query reads and includes additional explicit reads', () => {
		const world = createWorld();
		const options: EntityWorkerSystemConfig<Components, { health: Int32Array }> = {
			name: 'Queries', required: ['health'], optional: ['movement'], writes: [], reads: ['neighbors'],
			queries: { related: { required: ['entity'], optional: ['health'] } },
			forceMainThread: true, updateFunction: () => {}, getWorker: () => {
				throw new Error('fallback');
			},
		};
		const worker = new (class extends EntityWorkerSystem<Components, { health: Int32Array }> {})(world, options);
		const entity = new (class extends EntitySystem<Components> {
			updateEntity(): void {}
		})(world, {
			name: 'Entities', components: ['health'], reads: ['movement'], writes: [],
		});
		const once = new WorkerSystem(world, {
			name: 'Once', queries: options.queries, writes: [], forceMainThread: true, updateFunction: () => {}, getWorker: options.getWorker,
		});
		try {
			expect(new Set(worker.readComponents)).toEqual(new Set(['entity', 'health', 'movement', 'neighbors']));
			expect(new Set(entity.readComponents)).toEqual(new Set(['entity', 'health', 'movement']));
			expect(new Set(once.readComponents)).toEqual(new Set(['entity', 'health']));
		} finally {
			worker.destroy();
			once.destroy();
			world.destroy();
		}
	});

	it('uses inferred reads for synchronous worker fallback without holding completed locks', () => {
		const world = createWorld();
		const entity = world.loadEntity({ maxHealth: 10 });
		const writer = world.addSystem(new (class extends EntityWorkerSystem<Components, { health: Int32Array }> {})(world, {
			name: 'Writer', required: ['health'], writes: ['health'], forceMainThread: true,
			updateFunction: (_world, _eid, components) => {
				components.health[0] = 7;
			},
			getWorker: () => {
				throw new Error('fallback');
			},
		}));
		const reader = world.addSystem(new RecordingSystem(world, { name: 'Reader', reads: ['health'], writes: [] }));
		const values: Array<number | undefined> = [];
		reader.onRun = () => values.push(entity.components.health?.health);
		try {
			world.update(10);
			world.update(20);
			expect(values).toEqual([7, 7]);
			expect(reader.deltas).toEqual([10, 20]);
			expect(writer.isCurrentlyRunning()).toBe(false);
		} finally {
			world.destroy();
		}
	});

	it.each([false, true])('automatically starts the reader after a real worker reply without another update (paused: %s)', async paused => {
		const world = createWorld();
		const entity = world.loadEntity({ maxHealth: 10 });
		const control = new Int32Array(new SharedArrayBuffer(8));
		const writer = world.addSystem(new (class extends EntityWorkerSystem<Components, { health: Int32Array }> {})(world, {
			name: 'Writer', required: ['health'], writes: ['health'], updateFunction: () => {},
			getInitData: () => ({ control }), getWorker: () => new NodeWorkerAdapter(CONTROLLED_WORKER_URL) as unknown as Worker,
		}));
		const reader = world.addSystem(new RecordingSystem(world, { name: 'Reader', reads: ['health'], writes: [] }));
		const values: Array<number | undefined> = [];
		reader.onRun = () => values.push(entity.components.health?.health);
		try {
			await world.init();
			await writer.finishLoading();
			world.update(10);
			await Atomics.waitAsync(control, 0, 0, 2000).value;
			expect(Atomics.load(control, 0)).toBe(1);
			expect(values).toEqual([]);
			world.paused = paused;
			const completion = writer.waitForRunToComplete();
			Atomics.store(control, 1, 1);
			Atomics.notify(control, 1);
			await completion;
			expect(values).toEqual([777]);
			expect(reader.deltas).toEqual([10]);
		} finally {
			Atomics.store(control, 1, 1);
			Atomics.notify(control, 1);
			world.destroy();
		}
	});

	it('keeps independent cadence moving while a real worker owns conflicting memory', async () => {
		const world = createWorld();
		world.loadEntity({ maxHealth: 10 });
		const control = new Int32Array(new SharedArrayBuffer(8));
		const writer = world.addSystem(new (class extends EntityWorkerSystem<Components, { health: Int32Array }> {})(world, {
			name: 'Writer', required: ['health'], writes: ['health'], firstRun: true, deltaBetweenRuns: 1000, updateFunction: () => {},
			getInitData: () => ({ control }), getWorker: () => new NodeWorkerAdapter(CONTROLLED_WORKER_URL) as unknown as Worker,
		}));
		const reader = world.addSystem(new RecordingSystem(world, { name: 'Reader', reads: ['health'], writes: [] }));
		const frequent = world.addSystem(new RecordingSystem(world, { name: 'Frequent', reads: [], writes: ['movement'], deltaBetweenRuns: 32 }));
		try {
			await writer.init();
			await writer.finishLoading();
			world.update(16);
			await Atomics.waitAsync(control, 0, 0, 2000).value;
			expect(Atomics.load(control, 0)).toBe(1);
			world.update(16);
			world.update(16);
			world.update(16);
			expect(frequent.gameTimes).toEqual([32, 64]);
			expect(reader.gameTimes).toEqual([]);
			expect(writer.isCurrentlyRunning()).toBe(true);
			const completion = writer.waitForRunToComplete();
			Atomics.store(control, 1, 1);
			Atomics.notify(control, 1);
			await completion;
			expect(reader.gameTimes).toEqual([16, 32, 48, 64]);
			expect(writer.isCurrentlyRunning()).toBe(false);
		} finally {
			Atomics.store(control, 1, 1);
			Atomics.notify(control, 1);
			world.destroy();
		}
	});

	it('sends a delayed real worker its original logical clock and configured timestep', async () => {
		const world = createWorld();
		world.loadEntity({ maxHealth: 10 });
		const control = new Int32Array(new SharedArrayBuffer(16));
		const blocker = world.addSystem(new RecordingSystem(world, { name: 'Blocker', reads: [], writes: ['health'], deltaBetweenRuns: 32 }, true));
		const writer = world.addSystem(new (class extends EntityWorkerSystem<Components, { health: Int32Array }> {})(world, {
			name: 'Writer', required: ['health'], writes: ['health'], deltaBetweenRuns: 32, updateFunction: () => {},
			getInitData: () => ({ control }), getWorker: () => new NodeWorkerAdapter(CONTROLLED_WORKER_URL) as unknown as Worker,
		}));
		try {
			await writer.init();
			await writer.finishLoading();
			for(let frame = 0; frame < 4; frame++) {
				world.update(16);
			}
			expect(blocker.gameTimes).toEqual([32]);
			expect(writer.isCurrentlyRunning()).toBe(false);
			blocker.complete();
			await Promise.resolve();
			await Atomics.waitAsync(control, 0, 0, 2000).value;
			expect(Atomics.load(control, 0)).toBe(1);
			expect(Atomics.load(control, 2)).toBe(32);
			expect(Atomics.load(control, 3)).toBe(32);
			expect(world.gameTime).toBe(64);
			const completion = writer.waitForRunToComplete();
			Atomics.store(control, 1, 1);
			Atomics.notify(control, 1);
			await completion;
		} finally {
			Atomics.store(control, 1, 1);
			Atomics.notify(control, 1);
			world.destroy();
		}
	});

	it('uses the same logical clock in worker fallback and restores it after a throwing dispatch', async () => {
		const world = createWorld();
		world.loadEntity({ maxHealth: 10 });
		const blocker = world.addSystem(new RecordingSystem(world, { name: 'Blocker', reads: [], writes: ['health'] }, true));
		const times: Array<number> = [];
		const worker = world.addSystem(new (class extends EntityWorkerSystem<Components, { health: Int32Array }> {})(world, {
			name: 'Fallback', required: ['health'], writes: [], forceMainThread: true,
			updateFunction: workerWorld => times.push(workerWorld.gameTime), getWorker: () => {
				throw new Error('fallback');
			},
		}));
		const broken = world.addSystem(new RecordingSystem(world, { name: 'Broken', reads: ['health'], writes: [] }));
		broken.onRun = () => {
			throw new Error('broken');
		};
		const log = vi.spyOn(console, 'error').mockImplementation(() => {});
		try {
			world.update(16);
			world.update(16);
			blocker.complete();
			await Promise.resolve();
			expect(times).toEqual([16]);
			expect(worker.gameTime).toBe(32);
			expect(broken.gameTimes).toEqual([16]);
			expect(broken.gameTime).toBe(32);
		} finally {
			log.mockRestore();
			world.destroy();
		}
	});

	it('does not start another batch while clear awaits a real worker', async () => {
		const world = createWorld();
		world.loadEntity({ maxHealth: 10 });
		const control = new Int32Array(new SharedArrayBuffer(8));
		const writer = world.addSystem(new (class extends EntityWorkerSystem<Components, { health: Int32Array }> {})(world, {
			name: 'Writer', required: ['health'], writes: ['health'], updateFunction: () => {},
			getInitData: () => ({ control }), getWorker: () => new NodeWorkerAdapter(CONTROLLED_WORKER_URL) as unknown as Worker,
		}));
		const reader = world.addSystem(new RecordingSystem(world, { name: 'Reader', reads: ['health'], writes: [] }));
		try {
			await writer.init();
			await writer.finishLoading();
			world.update(10);
			await Atomics.waitAsync(control, 0, 0, 2000).value;
			expect(Atomics.load(control, 0)).toBe(1);
			world.update(20);
			const clearing = world.clear();
			Atomics.store(control, 1, 1);
			Atomics.notify(control, 1);
			await clearing;
			await Promise.resolve();
			expect(reader.deltas).toEqual([]);
			expect(writer.isCurrentlyRunning()).toBe(false);
			expect(world.entities.size).toBe(0);
			expect(world.registry.health.memoryComponent.length).toBe(0);
		} finally {
			Atomics.store(control, 1, 1);
			Atomics.notify(control, 1);
			world.destroy();
		}
	});

	it('drops removed pending systems, includes additions in future updates, and resets queued deltas', () => {
		const world = createWorld();
		world.loadEntity({ maxHealth: 10 });
		const first = world.addSystem(new RecordingSystem(world, { name: 'First', reads: [], writes: ['health'] }, true));
		const removed = world.addSystem(new RecordingSystem(world, { name: 'Removed', reads: ['health'], writes: [] }));
		world.update(10);
		world.update(20);
		world.removeSystem('Removed');
		const added = world.addSystem(new RecordingSystem(world, { name: 'Added', reads: ['movement'], writes: [] }));
		first.complete();
		world.update(30);
		expect(removed.deltas).toEqual([]);
		expect(added.deltas).toEqual([30]);
		world.load({ entities: [] });
		first.busy = false;
		world.update(40);
		expect(first.deltas).toEqual([10, 20, 40]);
		world.destroy();
	});

	it('keeps component declarations typed to registry keys', () => {
		expectTypeOf<SystemConfig<Components>['writes']>().toEqualTypeOf<ReadonlyArray<keyof Components> | undefined>();
		expectTypeOf<'missing'>().not.toExtend<keyof Components>();
	});
});
