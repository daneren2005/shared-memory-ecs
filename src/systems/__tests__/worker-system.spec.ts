import { WorkerSystem } from '../../index';
import type { System, BaseEntity } from '../../index';
import { createTestWorld, type Components, type TestWorld } from '../../__tests__/fixtures/components';
import { listOf } from '../../__tests__/fixtures/entity-collections';
import { workerSystemUpdate, TARGETS_SEEN_EVENT, RUN_TAG_EVENT, type WorkerSystemWorld } from '../../__tests__/fixtures/worker-system-update';

const WORKER_SYSTEM_WORKER_URL = new URL('../../__tests__/fixtures/worker-system.worker.ts', import.meta.url);

// Both backends must behave identically (see entity-worker-system.spec.ts).
type Mode = 'main-thread' | 'worker';
const MODES: Array<Mode> = ['main-thread', 'worker'];

function flush(): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, 0));
}

async function initSystem(system: System<Components>): Promise<void> {
	await system.init();
	await system.finishLoading();
}

describe.each(MODES)('worker-system (%s)', (mode) => {
	let world: TestWorld;
	let systems: Array<System<Components>>;
	beforeEach(() => {
		world = createTestWorld();
		systems = [];
	});
	afterEach(() => {
		systems.forEach(system => system.destroy());
	});

	function useSystem<S extends System<Components>>(system: S): S {
		systems.push(system);
		world.addSystem(system);
		return system;
	}
	function createEntity(config: any): BaseEntity<Components> {
		return world.loadEntity(config);
	}

	it('runs every interval with zero entities', async () => {
		let system = useSystem(new TestWorkerSystem(world, mode));
		await initSystem(system);
		system.tag = 7;

		let tags: Array<Array<number>> = [];
		system.on(RUN_TAG_EVENT, (values: Array<number>) => tags.push(values));

		system.run(16);
		await flush();

		// The run fired despite no main-query entities, and the per-run tag reached the worker via addDataToWorld.
		expect(tags).toEqual([[7]]);
	});

	it('never populates its main query', async () => {
		let system = useSystem(new TestWorkerSystem(world, mode));
		await initSystem(system);

		createEntity({ maxHealth: 100 });
		createEntity({ maxHealth: 100 });

		// Matching entities land in the `targets` sub-query, never the (nonexistent) main query.
		expect(system.entities.size).toEqual(0);
	});

	it('sees sub-query membership across runs', async () => {
		let system = useSystem(new TestWorkerSystem(world, mode));
		await initSystem(system);

		let first = createEntity({ maxHealth: 100 });
		let second = createEntity({ maxHealth: 100 });

		let batches: Array<Array<number>> = [];
		system.on(TARGETS_SEEN_EVENT, (ids: Array<number>) => batches.push(ids));

		system.run(16);
		await flush();
		expect(batches).toEqual([[first.eid, second.eid]]);

		world.removeEntity(second);
		system.run(16);
		await flush();
		// The removal is reflected on the very next run.
		expect(batches[1]).toEqual([first.eid]);
	});

	it('receives fresh per-run data via addDataToWorld', async () => {
		let system = useSystem(new TestWorkerSystem(world, mode));
		await initSystem(system);

		let tags: Array<Array<number>> = [];
		system.on(RUN_TAG_EVENT, (values: Array<number>) => tags.push(values));

		system.tag = 1;
		system.run(16);
		await flush();

		system.tag = 2;
		system.run(16);
		await flush();

		expect(tags).toEqual([[1], [2]]);
	});

	it('creates entities from its run function', async () => {
		let system = useSystem(new TestWorkerSystem(world, mode));
		await initSystem(system);
		expect(world.entities.size).toEqual(0);

		system.spawn = true;
		system.run(16);
		await flush();

		expect(world.entities.size).toEqual(1);
		let spawned = listOf(world.entities)[0];
		expect(spawned.components.entity.type).toEqual('Spawned');
		expect(spawned.components.health?.maxHealth).toEqual(10);
	});
});

class TestWorkerSystem extends WorkerSystem<Components, WorkerSystemWorld> {
	tag?: number;
	spawn = false;

	constructor(world: TestWorld, mode: Mode) {
		super(world, {
			name: 'TestWorkerSystem',
			updateFunction: workerSystemUpdate,
			createsEntities: true,
			forceMainThread: mode === 'main-thread',
			getWorker: () => new Worker(WORKER_SYSTEM_WORKER_URL, { type: 'module' }),
			queries: {
				targets: { required: ['health'] },
			},
		});
	}

	addDataToWorld(world: WorkerSystemWorld): void {
		if(this.tag !== undefined) {
			world.tag = this.tag;
		}
		world.spawn = this.spawn;
	}
}
