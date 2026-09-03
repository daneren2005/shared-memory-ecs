import { BaseWorld, EntityWorkerSystem } from '../../index';
import { registry, type Components } from '../../__tests__/fixtures/components';
import { growUpdate, GROW_COUNT } from '../../__tests__/fixtures/grow-update';

const GROW_WORKER_URL = new URL('../../__tests__/fixtures/grow.worker.ts', import.meta.url);

// Waits a macrotask for worker messages (grow-buffer-from-worker, run-complete) to arrive.
function flush(): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, 0));
}

class GrowSystem extends EntityWorkerSystem<Components, { health: Int32Array }> {
	constructor(world: BaseWorld<typeof registry>) {
		super(world, {
			name: 'GrowSystem',
			required: ['health'],
			updateFunction: growUpdate,
			getWorker: () => new Worker(GROW_WORKER_URL, { type: 'module' }),
		});
	}
}

describe('worker buffer-growth propagation', () => {
	it('adopts buffers a worker grew and reads back values written into them', async () => {
		// A small heap so the worker's batch allocation forces the heap to grow past the first buffer.
		const world = new BaseWorld(registry, { heapSize: 16 * 1024 });
		const system = new GrowSystem(world);
		world.addSystem(system);

		world.loadEntity({ maxHealth: 100 });
		await system.init();
		await system.finishLoading();

		const healthComponent = world.registry.health.memoryComponent;
		const buffersBefore = world.heap.buffers.length;
		const lengthBefore = healthComponent.length;

		world.update(16);
		for(let i = 0; i < 5; i++) {
			await flush();
		}

		// The worker allocated into the shared pool off-thread; the main thread sees the new blocks...
		expect(healthComponent.length).toEqual(lengthBefore + GROW_COUNT);
		// ...and the heap it grew reached the main thread...
		expect(world.heap.buffers.length).toBeGreaterThan(buffersBefore);
		// ...and the last block (which lives in a grown buffer) reads back the sentinel the worker wrote, proving the
		// SharedArrayBuffer is genuinely shared, not copied.
		expect(healthComponent.get(healthComponent.length - 1, 0)).toEqual(GROW_COUNT - 1);

		system.destroy();
	});

	it('allocates through the main-thread fallback without a worker', () => {
		const world = new BaseWorld(registry, { heapSize: 16 * 1024 });
		const system = new (class extends EntityWorkerSystem<Components, { health: Int32Array }> {
			constructor() {
				super(world, {
					name: 'GrowSystemMain',
					required: ['health'],
					updateFunction: growUpdate,
					forceMainThread: true,
					getWorker: () => new Worker(GROW_WORKER_URL, { type: 'module' }),
				});
			}
		})();
		world.addSystem(system);

		world.loadEntity({ maxHealth: 100 });

		const healthComponent = world.registry.health.memoryComponent;
		const lengthBefore = healthComponent.length;

		world.update(16);

		expect(healthComponent.length).toEqual(lengthBefore + GROW_COUNT);
		expect(healthComponent.get(healthComponent.length - 1, 0)).toEqual(GROW_COUNT - 1);

		system.destroy();
	});
});
