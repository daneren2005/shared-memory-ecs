import { System, EntityWorkerSystem } from '../index';
import { createTestWorld, type Components, type TestWorld } from './fixtures/components';
import { damageUpdate, type DamageWorld, type DamageInitData } from './fixtures/damage-update';

class CountingSystem extends System<Components> {
	runs = 0;

	constructor(world: TestWorld, name = 'Counting') {
		super(world, { name });
	}

	run(): void {
		this.runs++;
	}
	shouldRun(): boolean {
		return true;
	}
}

// forceMainThread keeps the worker round-trip synchronous so the test stays deterministic.
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

function healthLength(world: TestWorld): number {
	return world.registry.health.memoryComponent.length;
}

describe('world clear', () => {
	it('starts pristine and turns non-pristine after a load', () => {
		let world = createTestWorld();
		expect(world.pristine).toEqual(true);

		world.load({ entities: [{ maxHealth: 20 }] });
		expect(world.pristine).toEqual(false);
	});

	it('resolves immediately and skips system teardown while pristine', async () => {
		let world = createTestWorld();
		let system = new CountingSystem(world);
		world.addSystem(system);
		let clearSpy = vi.spyOn(system, 'clear');

		await world.clear();

		expect(clearSpy).not.toHaveBeenCalled();
		expect(world.pristine).toEqual(true);
	});

	it('removes every entity, frees their memory and leaves the world pristine', async () => {
		let world = createTestWorld();
		world.loadEntity({ maxHealth: 20 });
		world.loadEntity({ maxHealth: 10 });
		expect(healthLength(world)).toEqual(2);

		await world.clear();

		expect(world.entities.size).toEqual(0);
		expect(healthLength(world)).toEqual(0);
		expect(world.pristine).toEqual(true);
	});

	it('frees a block that was still deferred when clear was called', async () => {
		let world = createTestWorld();
		let system = new DamageSystem(world);
		world.addSystem(system);

		let removed = world.loadEntity({ maxHealth: 20 });
		world.loadEntity({ maxHealth: 30 });
		removed.removeComponent('health');
		// The block is held, not freed, until a system finishes a run over it.
		expect(healthLength(world)).toEqual(2);

		await world.clear();
		expect(healthLength(world)).toEqual(0);
		expect(world.entities.size).toEqual(0);

		system.destroy();
	});

	it('skips per-system teardown on the first load, runs it on later loads, and skips it again after clear', async () => {
		let world = createTestWorld();
		let system = new CountingSystem(world);
		world.addSystem(system);
		let clearSpy = vi.spyOn(system, 'clear');

		// First load into a pristine world: nothing to tear down.
		world.load({ entities: [{ maxHealth: 20 }] });
		expect(clearSpy).not.toHaveBeenCalled();

		// Second load into a dirty world: every system is cleared.
		world.load({ entities: [{ maxHealth: 10 }] });
		expect(clearSpy).toHaveBeenCalledTimes(1);

		// clear() also tears the systems down, then leaves the world pristine.
		await world.clear();
		expect(clearSpy).toHaveBeenCalledTimes(2);
		expect(world.pristine).toEqual(true);

		// Loading a just-cleared world skips teardown again.
		clearSpy.mockClear();
		world.load({ entities: [{ maxHealth: 5 }] });
		expect(clearSpy).not.toHaveBeenCalled();
	});

	it('can be reused normally after a clear', async () => {
		let world = createTestWorld();
		world.loadEntity({ maxHealth: 20 });

		await world.clear();

		world.load({ entities: [{ maxHealth: 40 }, { maxHealth: 50 }] });
		expect(world.entities.size).toEqual(2);
		expect(healthLength(world)).toEqual(2);
	});
});
