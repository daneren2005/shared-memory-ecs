import { EntityWorkerSystem, System } from '../index';
import type { WorldLoadProgress } from '../index';
import { createTestWorld, type Components, type Config, type TestWorld } from './fixtures/components';
import { damageUpdate, type DamageWorld, type DamageInitData } from './fixtures/damage-update';
import { listOf } from './fixtures/entity-collections';

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

class CountingSystem extends System<Components> {
	runs = 0;

	constructor(world: TestWorld) {
		super(world, { name: 'Counting' });
	}

	run(): void {
		this.runs++;
	}
}

function entityConfigs(count: number, maxHealth = 10): Array<Config> {
	return Array.from({ length: count }, (_, i) => ({ maxHealth: maxHealth + i }));
}

// Each yield parks until the test releases it, so a sliced load can be inspected between slices.
function manualYield() {
	let pending: Array<() => void> = [];
	return {
		yieldTo: () => new Promise<void>(resolve => pending.push(resolve)),
		get waiting() {
			return pending.length;
		},
		async release() {
			const resolves = pending;
			pending = [];
			resolves.forEach(resolve => resolve());
			await Promise.resolve();
		},
		async drain() {
			while(pending.length > 0) {
				await this.release();
			}
		},
	};
}

describe('world sliced load', () => {
	let world: TestWorld;
	beforeEach(() => {
		world = createTestWorld();
	});
	afterEach(() => {
		world.destroy();
	});

	it('reports every phase in order without slicing, ending at a fraction of 1', async () => {
		world.addSystem(new DamageSystem(world));
		const progress: Array<WorldLoadProgress> = [];
		let readyEntities = -1;

		const loading = world.load({ entities: entityConfigs(600) }, {
			onProgress: value => progress.push(value),
			onEntitiesReady: () => readyEntities = world.entities.size,
		});

		expect(readyEntities).toEqual(600);
		expect(world.isLoading).toEqual(false);
		await loading;
		expect(Array.from(new Set(progress.map(value => value.phase)))).toEqual(['entities', 'linking', 'systems', 'workers']);
		const fractions = progress.map(value => value.fraction);
		expect(fractions).toEqual([...fractions].sort((a, b) => a - b));
		expect(fractions.at(-1)).toEqual(1);
	});

	it('loads across yields and matches a synchronous load', async () => {
		const system = world.addSystem(new DamageSystem(world));
		const counting = world.addSystem(new CountingSystem(world));
		const slices = manualYield();
		let ready = false;

		const loading = world.load({ entities: entityConfigs(1000), gameTime: 50 }, {
			sliceMs: 0,
			yieldTo: slices.yieldTo,
			onEntitiesReady: () => ready = true,
		});

		expect(slices.waiting).toEqual(1);
		expect(world.entities.size).toBeLessThan(1000);
		expect(world.isLoading).toEqual(true);
		world.update(16);
		expect(counting.runs).toEqual(0);
		expect(world.playerTime).toEqual(0);

		await slices.drain();
		await loading;

		expect(ready).toEqual(true);
		expect(world.isLoading).toEqual(false);
		expect(world.isBulkLoading).toEqual(false);
		expect(world.gameTime).toEqual(50);
		expect(listOf(world.entities).map(entity => entity.components.health?.maxHealth)).toEqual(entityConfigs(1000).map(config => config.maxHealth));
		expect(system.entities.size).toEqual(1000);
	});

	it('aborts a sliced load when another load starts', async () => {
		world.addSystem(new DamageSystem(world));
		const slices = manualYield();
		const first = world.load({ entities: entityConfigs(1000) }, { sliceMs: 0, yieldTo: slices.yieldTo });
		const firstResult = first.catch((error: unknown) => error);

		const second = world.load({ entities: entityConfigs(3, 500) });
		await slices.drain();

		expect(await firstResult).toMatchObject({ name: 'AbortError' });
		await second;
		expect(listOf(world.entities).map(entity => entity.components.health?.maxHealth)).toEqual([500, 501, 502]);
		expect(world.isLoading).toEqual(false);
	});

	it('aborts a sliced load on clear and leaves the world pristine', async () => {
		const slices = manualYield();
		const loading = world.load({ entities: entityConfigs(1000) }, { sliceMs: 0, yieldTo: slices.yieldTo });
		const result = loading.catch((error: unknown) => error);

		const clearing = world.clear();
		await slices.drain();
		await clearing;

		expect(await result).toMatchObject({ name: 'AbortError' });
		expect(world.entities.size).toEqual(0);
		expect(world.pristine).toEqual(true);
		expect(world.isBulkLoading).toEqual(false);
	});

	it('aborts a sliced load when the world is destroyed', async () => {
		const slices = manualYield();
		const result = world.load({ entities: entityConfigs(1000) }, { sliceMs: 0, yieldTo: slices.yieldTo }).catch((error: unknown) => error);

		world.destroy();
		await slices.drain();

		expect(await result).toMatchObject({ name: 'AbortError' });
	});

	it('aborts on its signal', async () => {
		const slices = manualYield();
		const controller = new AbortController();
		const loading = world.load({ entities: entityConfigs(1000) }, { sliceMs: 0, yieldTo: slices.yieldTo, signal: controller.signal });
		const result = loading.catch((error: unknown) => error);

		controller.abort();
		await slices.drain();

		expect(await result).toMatchObject({ name: 'AbortError' });
		expect(world.isLoading).toEqual(false);
		expect(world.isBulkLoading).toEqual(false);
		await world.load({ entities: entityConfigs(2) });
		expect(world.entities.size).toEqual(2);
	});
});
