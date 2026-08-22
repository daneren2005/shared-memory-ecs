import { ComponentSystem, EntityFactory } from '../../index';
import type { System } from '../../index';
import { createTestWorld, type Components, type Config, type TestWorld } from '../../__tests__/fixtures/components';
import { listOf } from '../../__tests__/fixtures/entity-collections';
import { createMultiUpdate } from '../../__tests__/fixtures/create-multi-update';

const CREATE_MULTI_WORKER_URL = new URL('../../__tests__/fixtures/create-multi.worker.ts', import.meta.url);

type Mode = 'main-thread' | 'worker';
const MODES: Array<Mode> = ['main-thread', 'worker'];

function flush(): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, 0));
}

class CreateMultiSystem extends ComponentSystem<Components, { movement: Float32Array }> {
	constructor(world: TestWorld, mode: Mode) {
		super(world, {
			name: 'CreateMultiSystem',
			required: ['movement'],
			updateFunction: createMultiUpdate,
			createsEntities: true,
			forceMainThread: mode === 'main-thread',
			getWorker: () => new Worker(CREATE_MULTI_WORKER_URL, { type: 'module' }),
		});
	}
}

describe.each(MODES)('worker createEntity (%s)', (mode) => {
	it('builds an entity from a factory config off-thread and adopts it on the main thread', async () => {
		// The 'ship' template contributes maxHealth + isStatic; the update overrides speed.
		const factory = new EntityFactory<Components, Config>({
			ship: { type: 'ship', maxHealth: 100, isStatic: true },
		});
		const world = createTestWorld(factory);
		const system: System<Components> = new CreateMultiSystem(world, mode);
		world.addSystem(system);

		const trigger = world.loadEntity({ speed: 1 });
		await system.init();
		await system.finishLoading();

		system.run(16);
		await flush();

		expect(world.entities.size).toEqual(2);
		const created = listOf(world.entities).find(other => other !== trigger)!;
		expect(created).toBeDefined();

		// Template value (maxHealth 100) came from the factory; speed 9 overrode the template - both blocks were built
		// + written in the worker via toBlock and adopted on the main thread.
		expect(created.components.health?.maxHealth).toEqual(100);
		expect(created.components.health?.health).toEqual(100);
		expect(created.components.movement?.speed).toEqual(9);
		// The entity component was built on the main thread with the type + the template's isStatic flag.
		expect(created.components.entity.type).toEqual('ship');
		expect(created.components.entity.isStatic).toEqual(true);
		// The id was minted from the shared counter, so it is a real, unique eid.
		expect(created.eid).toBeGreaterThan(0);
		expect(created.eid).not.toEqual(trigger.eid);

		system.destroy();
	});
});
