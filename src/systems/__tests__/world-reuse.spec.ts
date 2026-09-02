import { ComponentSystem } from '../../index';
import type { ComponentSystemWorld, EntityUpdateFunction, System } from '../../index';
import { createTestWorld, type Components, type TestWorld } from '../../__tests__/fixtures/components';
import NodeWorkerAdapter from '../../__tests__/fixtures/node-worker-adapter';
import { damageUpdate, DAMAGED_ENTITIES_EVENT, type DamageWorld, type DamageInitData } from '../../__tests__/fixtures/damage-update';
import { spawnUpdate } from '../../__tests__/fixtures/spawn-update';

const DAMAGE_WORKER_URL = new URL('../../__tests__/fixtures/damage.worker.ts', import.meta.url);
const SPAWN_WORKER_URL = new URL('../../__tests__/fixtures/spawn.worker.ts', import.meta.url);
const CONTROLLED_WORKER_URL = new URL('../../__tests__/fixtures/controlled-node-worker.mjs', import.meta.url);
const STARTED_INDEX = 0;
const RESUME_INDEX = 1;

type ControlledWorld = ComponentSystemWorld;
interface ControlledInitData {
	control: Int32Array
}

const noopUpdate: EntityUpdateFunction<Components, { health: Int32Array }, ControlledWorld, ControlledInitData> = () => {};

// Shape of a run-complete message (see component-worker-message.ts). Filled with empty defaults so each test
// only specifies the part it exercises.
interface RunCompletePayload {
	generation: number
	events?: Array<{ entityId: number, event: string, args: Array<unknown> }>
	systemEvents?: { [event: string]: Array<number> }
	created?: Array<Record<string, unknown>>
}

// Delivers a run-complete to the system's own message handler, exactly as its worker does when a run finishes.
// Used to model a run that was in flight across a world.load() (clear + reload) and only reports back afterwards:
// a real worker's reply is always async, so it necessarily lands after the synchronous load() call.
function deliverRunComplete<S extends ComponentSystem<Components, any, any, any>>(system: S, payload: RunCompletePayload) {
	const worker = system.worker as unknown as { onmessage: (e: { data: unknown }) => void };
	worker.onmessage({
		data: {
			type: 'run-complete',
			generation: payload.generation,
			runTime: 0,
			events: payload.events ?? [],
			systemEvents: payload.systemEvents ?? {},
			created: payload.created ?? [],
		},
	});
}

function generationOf(system: ComponentSystem<Components, any, any, any>): number {
	return Reflect.get(system, 'generation') as number;
}
function workerEntityCount(system: ComponentSystem<Components, any, any, any>): number {
	return (Reflect.get(system.worker, 'entities') as Array<unknown>).length;
}

async function waitForAtomicValue(control: Int32Array, index: number, expected: number): Promise<void> {
	const deadline = performance.now() + 2_000;
	while(Atomics.load(control, index) !== expected) {
		if(performance.now() >= deadline) {
			throw new Error(`Timed out waiting for control[${index}] to equal ${expected}`);
		}
		await new Promise(resolve => setTimeout(resolve, 0));
	}
}

// A World is meant to be reused: world.load() clears the old contents and loads a fresh scenario. These tests
// cover a ComponentSystem un-initializing across that boundary — its main-thread caches, the worker's persistent
// lists, and the generation guard that drops a worker run still in flight when the reload happened.
//
// forceMainThread runs the (synchronous) ComponentWebWorker so the reset and run round-trips are deterministic.
describe('component-system world reuse', () => {
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

	it('resets its in-flight running flag when the world is cleared', () => {
		let system = useSystem(new DamageSystem(world));
		world.loadEntity({ maxHealth: 100 });

		// Model a run in flight: run() sets this when it posts to the worker and only the reply clears it.
		Reflect.set(system, 'isRunning', true);

		world.load({ entities: [{ maxHealth: 100 }] });

		expect(Reflect.get(system, 'isRunning')).toEqual(false);
	});

	it('world.clear waits for a real in-flight worker before resolving', async () => {
		const control = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 2));
		const system = useSystem(new ControlledSystem(world, control));
		world.loadEntity({ maxHealth: 100 });
		await system.init();
		await system.finishLoading();

		world.update(16);
		await waitForAtomicValue(control, STARTED_INDEX, 1);

		let clearSettled = false;
		const clearPromise = world.clear().then(() => {
			clearSettled = true;
			return undefined;
		});
		try {
			await new Promise(resolve => setTimeout(resolve, 0));
			expect(clearSettled).toEqual(false);
		} finally {
			Atomics.store(control, RESUME_INDEX, 1);
			Atomics.notify(control, RESUME_INDEX);
			await clearPromise;
		}
		expect(world.entities.size).toEqual(0);
		expect(world.registry.health.memoryComponent.length).toEqual(0);
	});

	it('empties its main-thread entity caches when the world is cleared', () => {
		let system = useSystem(new DamageSystem(world));
		world.loadEntity({ maxHealth: 100 });
		expect(system.isEntityInSystem(Array.from(world.entities.values())[0])).toEqual(true);

		world.load({ entities: [] });

		expect(system.entities.size).toEqual(0);
	});

	it('drops the worker\'s persistent entity list when the world is cleared', () => {
		let system = useSystem(new DamageSystem(world));
		world.loadEntity({ maxHealth: 100 });
		system.run(16);
		expect(workerEntityCount(system)).toEqual(1);

		world.load({ entities: [] });

		expect(workerEntityCount(system)).toEqual(0);
	});

	// The generation guard drops a reply from a run that started before the reload, so its system event never
	// reaches a listener registered for the new scenario.
	it('ignores a stale system event from a run that predates the reload', () => {
		let system = useSystem(new DamageSystem(world));
		let oldEntity = world.loadEntity({ maxHealth: 100 });
		let staleGeneration = generationOf(system);

		let reportedIds: Array<number> = [];
		system.on(DAMAGED_ENTITIES_EVENT, (entityIds: Array<number>) => {
			reportedIds.push(...entityIds);
		});

		world.load({ entities: [{ maxHealth: 100 }] });
		deliverRunComplete(system, { generation: staleGeneration, systemEvents: { [DAMAGED_ENTITIES_EVENT]: [oldEntity.eid] } });

		expect(reportedIds).not.toContain(oldEntity.eid);
	});

	it('ignores stale per-entity events from a run that predates the reload', () => {
		let warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		try {
			let system = useSystem(new DamageSystem(world));
			let oldEntity = world.loadEntity({ maxHealth: 100 });
			let staleGeneration = generationOf(system);

			world.load({ entities: [{ maxHealth: 100 }] });
			deliverRunComplete(system, {
				generation: staleGeneration,
				events: [{ entityId: oldEntity.eid, event: 'component-property-updated', args: ['health', 'health', 99] }],
			});

			expect(warn).not.toHaveBeenCalled();
		} finally {
			warn.mockRestore();
		}
	});

	it('ignores a stale createEntity from a run that predates the reload', () => {
		let system = useSystem(new SpawnSystem(world));
		world.loadEntity({ maxHealth: 100 });
		let staleGeneration = generationOf(system);

		world.load({ entities: [{ maxHealth: 50 }] });
		expect(world.entities.size).toEqual(1);

		deliverRunComplete(system, { generation: staleGeneration, created: [{ maxHealth: 10 }] });

		expect(world.entities.size).toEqual(1);
	});

	// The guard must not over-block: a run started in the reloaded world reports back normally.
	it('still processes runs for the reloaded world after a clear', () => {
		let system = useSystem(new DamageSystem(world));
		world.loadEntity({ maxHealth: 100 });
		system.run(16);

		world.load({ entities: [{ maxHealth: 100 }] });
		let entity = Array.from(world.entities.values())[0];

		let events: Array<number> = [];
		entity.on('component-property-updated', (_component, _prop, value: number) => {
			events.push(value);
		});

		system.run(16);

		expect(entity.components.health?.health).toEqual(99);
		expect(events).toEqual([99]);
	});
});

class DamageSystem extends ComponentSystem<Components, { health: Int32Array }, DamageWorld, DamageInitData> {
	constructor(world: TestWorld) {
		super(world, {
			name: 'DamageSystem',
			required: ['health'],
			updateFunction: damageUpdate,
			forceMainThread: true,
			getWorker: () => new Worker(DAMAGE_WORKER_URL, { type: 'module' }),
		});
	}
}

class SpawnSystem extends ComponentSystem<Components, { health: Int32Array }> {
	constructor(world: TestWorld) {
		super(world, {
			name: 'SpawnSystem',
			required: ['health'],
			updateFunction: spawnUpdate,
			forceMainThread: true,
			getWorker: () => new Worker(SPAWN_WORKER_URL, { type: 'module' }),
		});
	}
}

class ControlledSystem extends ComponentSystem<Components, { health: Int32Array }, ControlledWorld, ControlledInitData> {
	constructor(world: TestWorld, control: Int32Array) {
		super(world, {
			name: 'ControlledSystem',
			required: ['health'],
			updateFunction: noopUpdate,
			getInitData: () => ({ control }),
			getWorker: () => new NodeWorkerAdapter(CONTROLLED_WORKER_URL) as unknown as Worker,
		});
	}
}
