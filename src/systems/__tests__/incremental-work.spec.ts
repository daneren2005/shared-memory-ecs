import { BaseWorld, ConflictScheduler, DefaultScheduler, EntityWorkerSystem, System } from '../../index';
import { registry, type Components, type TestWorld } from '../../__tests__/fixtures/components';
import { incrementalUpdate, type IncrementalWorld } from '../../__tests__/fixtures/incremental-update';

const WORKER_URL = new URL('../../__tests__/fixtures/incremental.worker.ts', import.meta.url);

class IncrementalSystem extends EntityWorkerSystem<Components, { health: Int32Array, movement?: Float32Array }, IncrementalWorld, boolean | 'preBatch'> {
	constructor(world: TestWorld, forceMainThread: boolean, size = 2, fail: boolean | 'preBatch' = false) {
		super(world, { name: 'Incremental', reads: [], writes: ['health'], required: ['health'], optional: ['movement'],
			queries: { movers: { required: ['movement'] } }, workBatchSize: size, deltaBetweenRuns: 100,
			updateFunction: incrementalUpdate, forceMainThread, getInitData: () => fail,
			getWorker: () => new Worker(WORKER_URL, { type: 'module' }) });
	}
}

let world: TestWorld;
afterEach(() => {
	world?.destroy();
	vi.restoreAllMocks();
});

describe.each([true, false])('incremental work (fallback: %s)', forceMainThread => {
	async function setup(size = 2, fail: boolean | 'preBatch' = false, conflict = true) {
		world = new BaseWorld(registry, { scheduler: conflict ? new ConflictScheduler<Components>() : new DefaultScheduler<Components>() });
		const system = world.addSystem(new IncrementalSystem(world, forceMainThread, size, fail));
		await world.init();
		await system.finishLoading();
		const entities = Array.from({ length: 5 }, () => world.loadEntity({ maxHealth: 1000 }));
		return { system, entities };
	}
	async function step(system: IncrementalSystem, delta: number) {
		world.update(delta);
		await system.waitForRunToComplete();
		await Promise.resolve();
	}

	it.each([true, false])('visits a stable pass in count-bounded batches with one delta/clock (conflict: %s)', async conflict => {
		const { system, entities } = await setup(2, false, conflict);
		const batches: Array<Array<number>> = [];
		const prepared: Array<Array<number>> = [];
		const visits: Array<Array<number>> = [];
		system.on('batch', eids => batches.push(eids));
		system.on('prepared', eids => prepared.push(eids));
		entities.forEach(entity => entity.on('visited', (...args: Array<number>) => visits.push([entity.eid, ...args])));
		await step(system, 100);
		expect(entities.map(entity => entity.components.health?.health)).toEqual([900, 900, 1000, 1000, 1000]);
		await step(system, 10);
		await step(system, 20);
		expect(batches).toEqual([entities.slice(0, 2).map(e => e.eid), entities.slice(2, 4).map(e => e.eid), [entities[4].eid]]);
		expect(prepared).toEqual([entities.map(e => e.eid)]);
		expect(visits.map(visit => visit.slice(1, 4))).toEqual(Array.from({ length: 5 }, () => [100, 100, 100]));
		expect(system.currentDelta).toBe(30);
		await step(system, 70);
		expect(prepared).toHaveLength(2);
		expect(visits.at(-1)?.slice(1, 4)).toEqual([100, 200, 200]);
	});

	it('releases a conflicting system after each batch, before the pass finishes', async () => {
		const { system, entities } = await setup();
		const totals: Array<number> = [];
		class Reader extends System<Components> {
			run() {
				totals.push(entities.reduce((sum, entity) => sum + (entity.components.health?.health ?? 0), 0));
			}
		}
		world.addSystem(new Reader(world, { name: 'Reader', reads: ['health'], writes: [] }));
		await step(system, 100);
		await step(system, 16);
		await step(system, 16);
		expect(totals).toEqual([4800, 4600, 4500]);
	});

	it('refreshes components and query deltas, skips removed members, and defers additions to the next pass', async () => {
		const { system, entities } = await setup();
		await step(system, 100);
		entities[2].removeComponent('health');
		entities[3].loadComponent('movement', { speed: 7 });
		const late = world.loadEntity({ maxHealth: 1000 });
		const speeds: Array<number> = [];
		entities[3].on('visited', (_delta: number, _time: number, _prepared: number, speed: number) => speeds.push(speed));
		const additions: Array<Array<number>> = [];
		system.on('added-movers', eids => additions.push(eids));
		await step(system, 16);
		await step(system, 16);
		expect(speeds).toEqual([7]);
		expect(additions).toEqual([[entities[3].eid]]);
		expect(late.components.health?.health).toBe(1000);
		await step(system, 100);
		await step(system, 16);
		await step(system, 16);
		expect(late.components.health?.health).toBe(900);
	});

	it('finishes an emptied snapshot without leaving an old continuation', async () => {
		const { system, entities } = await setup();
		await step(system, 100);
		entities.forEach(entity => entity.removeComponent('health'));
		await step(system, 16);
		await step(system, 16);
		expect(system.shouldRun()).toBe(false);
		const late = world.loadEntity({ maxHealth: 1000 });
		await step(system, 100);
		expect(late.components.health?.health).toBe(900);
	});

	it.each(['preRun', 'preBatch'])('abandons the remaining pass after %s fails', async phase => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
		const { system, entities } = await setup(2, phase === 'preRun' ? true : 'preBatch');
		const errors: Array<string> = [];
		world.on('system-error', (event: { phase: string }) => errors.push(event.phase));
		await step(system, 100);
		await step(system, 16);
		expect(errors).toEqual([phase]);
		expect(entities.map(entity => entity.components.health?.health)).toEqual([1000, 1000, 1000, 1000, 1000]);
		await step(system, 84);
		expect(entities.map(entity => entity.components.health?.health)).toEqual([900, 900, 1000, 1000, 1000]);
	});

	it('leaves unqueued pass work paused until another host update after resume', async () => {
		const { system, entities } = await setup();
		await step(system, 100);
		world.paused = true;
		await step(system, 16);
		expect(entities.map(entity => entity.components.health?.health)).toEqual([900, 900, 1000, 1000, 1000]);
		world.paused = false;
		await step(system, 16);
		expect(entities.map(entity => entity.components.health?.health)).toEqual([900, 900, 900, 900, 1000]);
	});

	it('drops the pass and worker-local preparation on clear', async () => {
		const { system } = await setup();
		await step(system, 100);
		await world.clear();
		const entity = world.loadEntity({ maxHealth: 1000 });
		await world.init();
		await step(system, 100);
		expect(entity.components.health?.health).toBe(900);
		expect(system.isCurrentlyRunning()).toBe(false);
	});
});

it.each([0, -1, 1.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1])('rejects invalid work batch size %s', size => {
	world = new BaseWorld(registry);
	expect(() => new IncrementalSystem(world, true, size)).toThrow('workBatchSize must be a positive safe integer');
});
