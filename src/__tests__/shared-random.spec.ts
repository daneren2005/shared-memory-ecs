import MemoryHeap from '@daneren2005/shared-memory-objects/memory-heap';
import SharedRandom, { RANDOM_STATE_LENGTH, philox4x32 } from '../shared-random';
import { createTestWorld } from './fixtures/components';

function localRandom(seed: number): SharedRandom {
	const random = new SharedRandom(new Uint32Array(RANDOM_STATE_LENGTH));
	random.setState({ seed });
	return random;
}

describe('SharedRandom', () => {
	it('matches the Random123 Philox4x32-10 known-answer vectors', () => {
		const out = new Uint32Array(4);
		philox4x32(0, 0, 0, 0, out);
		expect(Array.from(out)).toEqual([0x6627E8D5, 0xE169C58D, 0xBC57AC4C, 0x9B00DBD8]);
		expect(localRandom(0).uint32()).toEqual(0x6627E8D5);
	});

	it('round-trips seeds above 32 bits and normalizes out-of-range seeds', () => {
		const random = localRandom(2 ** 40 + 3);
		expect(random.getState()).toEqual({ seed: 2 ** 40 + 3, position: 0 });
		expect(random.uint32()).not.toEqual(localRandom(3).uint32());
		expect(localRandom(-1).getState().seed).toEqual(2 ** 53 - 1);
		expect(localRandom(1.7).getState().seed).toEqual(1);
	});

	it('is deterministic for a seed and differs across seeds', () => {
		const a = localRandom(42);
		const b = localRandom(42);
		const c = localRandom(43);
		const aValues = Array.from({ length: 20 }, () => a.uint32());
		expect(Array.from({ length: 20 }, () => b.uint32())).toEqual(aValues);
		expect(Array.from({ length: 20 }, () => c.uint32())).not.toEqual(aValues);
	});

	it('returns floats in [0, 1) and ints in [min, max)', () => {
		const random = localRandom(1);
		for(let i = 0; i < 1000; i++) {
			const value = random.next();
			expect(value).toBeGreaterThanOrEqual(0);
			expect(value).toBeLessThan(1);
			const int = random.int(-3, 4);
			expect(Number.isInteger(int)).toBe(true);
			expect(int).toBeGreaterThanOrEqual(-3);
			expect(int).toBeLessThan(4);
		}
	});

	it('never repeats across handles sharing the same memory', () => {
		const world = createTestWorld();
		const cloneHeap = new MemoryHeap(world.heap.getSharedMemory());
		const workerRandom = SharedRandom.fromSharedMemory(cloneHeap, world.getSharedComponentMemory().random);

		// 53-bit floats: 32-bit outputs of distinct counters can legitimately collide at this sample size.
		const values = new Set<number>();
		for(let i = 0; i < 5000; i++) {
			values.add(world.random.next());
			values.add(workerRandom.next());
		}
		expect(values.size).toEqual(10000);
		expect(world.random.getState().position).toEqual(10000);
		world.destroy();
	});

	it('picks up a reseed made by another handle', () => {
		const world = createTestWorld();
		const workerRandom = SharedRandom.fromSharedMemory(new MemoryHeap(world.heap.getSharedMemory()), world.getSharedComponentMemory().random);
		workerRandom.uint32();
		world.random.setState({ seed: 7 });
		expect(workerRandom.uint32()).toEqual(localRandom(7).uint32());
		world.destroy();
	});

	it('restores state across the 32-bit position boundary', () => {
		const random = localRandom(5);
		random.setState({ seed: 5, position: 0xFFFFFFFF });
		const beforeWrap = random.uint32();
		const afterWrap = random.uint32();
		expect(random.getState()).toEqual({ seed: 5, position: 0x100000001 });

		const replay = localRandom(0);
		replay.setState({ seed: 5, position: 0xFFFFFFFF });
		expect([replay.uint32(), replay.uint32()]).toEqual([beforeWrap, afterWrap]);
		expect(afterWrap).not.toEqual(localRandom(5).uint32());
	});
});

describe('world random', () => {
	it('seeds on load from a config seed, a saved state, or a fresh random seed', async() => {
		const world = createTestWorld();

		await world.load({ entities: [], random: { seed: 9 } });
		expect(world.random.getState()).toEqual({ seed: 9, position: 0 });
		expect(world.random.uint32()).toEqual(localRandom(9).uint32());

		const saved = world.random.getState();
		const expected = [world.random.next(), world.random.next()];
		await world.load({ entities: [], random: saved });
		expect([world.random.next(), world.random.next()]).toEqual(expected);

		await world.load({ entities: [] });
		const fresh = world.random.getState();
		expect(fresh.position).toEqual(0);
		await world.load({ entities: [] });
		expect(world.random.getState().seed).not.toEqual(fresh.seed);
		world.destroy();
	});

	it('restores the stream before entities load', async() => {
		const world = createTestWorld();
		const drawn: Array<number> = [];
		world.on('entity-added', () => drawn.push(world.random.uint32()));
		await world.load({ entities: [{ maxHealth: 10 }], random: { seed: 4, position: 2 } });

		const replay = localRandom(0);
		replay.setState({ seed: 4, position: 2 });
		expect(drawn).toEqual([replay.uint32()]);
		world.destroy();
	});
});
