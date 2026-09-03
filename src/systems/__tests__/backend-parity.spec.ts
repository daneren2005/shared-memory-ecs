import { EntityWorkerSystem } from '../../index';
import { createTestWorld, type Components, type TestWorld } from '../../__tests__/fixtures/components';
import { damageUpdate, type DamageInitData, type DamageWorld } from '../../__tests__/fixtures/damage-update';

const DAMAGE_WORKER_URL = new URL('../../__tests__/fixtures/damage.worker.ts', import.meta.url);

type Mode = 'main-thread' | 'worker';

class ParitySystem extends EntityWorkerSystem<Components, { health: Int32Array }, DamageWorld, DamageInitData> {
	constructor(world: TestWorld, mode: Mode) {
		super(world, {
			name: 'ParitySystem',
			required: ['health'],
			updateFunction: damageUpdate,
			getInitData: () => ({ damage: 2 }),
			forceMainThread: mode === 'main-thread',
			getWorker: () => new Worker(DAMAGE_WORKER_URL, { type: 'module' }),
		});
	}
}

interface ScenarioResult {
	health: Array<number | undefined>
	changed: Array<[number, number]>
}

async function flush(): Promise<void> {
	await new Promise(resolve => setTimeout(resolve, 0));
}

async function runScenario(mode: Mode): Promise<ScenarioResult> {
	const world = createTestWorld();
	const system = new ParitySystem(world, mode);
	world.addSystem(system);
	const entities = [
		world.loadEntity({ maxHealth: 10 }),
		world.loadEntity({ maxHealth: 20 }),
	];
	const changed: Array<[number, number]> = [];
	entities.forEach(entity => {
		entity.on('component-property-updated', (_component: string, _prop: string, value: number) => {
			changed.push([entity.eid, value]);
		});
	});

	await system.init();
	await system.finishLoading();
	world.update(16);
	await flush();

	entities[1].removeComponent('health');
	world.update(16);
	await flush();
	entities[1].loadComponent('health', { maxHealth: 30 });
	world.update(16);
	await flush();

	const result = {
		health: entities.map(entity => entity.components.health?.health),
		changed,
	};
	system.destroy();
	return result;
}

describe('EntityWorkerSystem backend parity', () => {
	it('matches fallback and worker behavior across query churn and callbacks', async () => {
		const fallback = await runScenario('main-thread');
		const worker = await runScenario('worker');

		expect(worker).toEqual(fallback);
	});
});
