import type MemoryHeap from '@daneren2005/shared-memory-objects/memory-heap';
import type { SharedAllocatedMemory } from '@daneren2005/shared-memory-objects/allocated-memory';

const SEED_LOW_INDEX = 0;
const SEED_HIGH_INDEX = 1;
const POSITION_LOW_INDEX = 2;
const POSITION_HIGH_INDEX = 3;
export const RANDOM_STATE_LENGTH = 4;
const UINT32_RANGE = 0x100000000;
const SEED_RANGE = 2 ** 53;
const FLOAT_SCALE = 2 ** -53;
const PHILOX_ROUNDS = 10;

export interface RandomConfig {
	// Integer in [0, 2^53).
	seed: number
	// Number of draws so far; defaults to 0.
	position?: number
}
export interface RandomState extends RandomConfig {
	position: number
}

// Philox4x32-10 (Random123) keyed by the seed: each draw atomically claims the next counter and encrypts it, so
// concurrent draws from any thread never share a counter and need no lock.
export default class SharedRandom {
	readonly data: Uint32Array;
	private readonly block = new Uint32Array(4);

	constructor(data: Uint32Array) {
		this.data = data;
	}

	static fromSharedMemory(heap: MemoryHeap, shared: SharedAllocatedMemory): SharedRandom {
		const memory = heap.getSharedAlloc(shared);
		if(!memory) {
			throw new Error('SharedRandom memory is not in this heap');
		}
		return new SharedRandom(memory.data);
	}

	// [0, 1) with 53 bits of precision, like Math.random.
	next(): number {
		const block = this.draw();
		return ((block[0] >>> 5) * 0x4000000 + (block[1] >>> 6)) * FLOAT_SCALE;
	}
	// Integer in [min, max).
	int(min: number, max: number): number {
		return min + Math.floor(this.next() * (max - min));
	}
	uint32(): number {
		return this.draw()[0];
	}

	getState(): RandomState {
		const data = this.data;
		return {
			seed: Atomics.load(data, SEED_HIGH_INDEX) * UINT32_RANGE + Atomics.load(data, SEED_LOW_INDEX),
			position: Atomics.load(data, POSITION_HIGH_INDEX) * UINT32_RANGE + Atomics.load(data, POSITION_LOW_INDEX),
		};
	}
	setState(state: RandomConfig) {
		const data = this.data;
		const seed = normalizeSeed(state.seed);
		const position = state.position ?? 0;
		Atomics.store(data, SEED_LOW_INDEX, seed % UINT32_RANGE);
		Atomics.store(data, SEED_HIGH_INDEX, Math.floor(seed / UINT32_RANGE));
		Atomics.store(data, POSITION_LOW_INDEX, position % UINT32_RANGE);
		Atomics.store(data, POSITION_HIGH_INDEX, Math.floor(position / UINT32_RANGE));
	}

	private draw(): Uint32Array {
		const data = this.data;
		const low = Atomics.add(data, POSITION_LOW_INDEX, 1);
		let high: number;
		if(low === 0xFFFFFFFF) {
			high = Atomics.add(data, POSITION_HIGH_INDEX, 1);
		} else {
			// A draw that wraps just before this one bumps high may still read the old value; one possible repeat per 2^32 draws.
			high = Atomics.load(data, POSITION_HIGH_INDEX);
		}
		philox4x32(low, high, Atomics.load(data, SEED_LOW_INDEX), Atomics.load(data, SEED_HIGH_INDEX), this.block);
		return this.block;
	}
}

export function randomSeed(): number {
	return Math.floor(Math.random() * SEED_RANGE);
}

function normalizeSeed(seed: number): number {
	const integer = Math.trunc(seed) % SEED_RANGE;
	if(!Number.isFinite(integer)) {
		return 0;
	}
	// Adding 2^53 to a non-negative seed would round away its low bit.
	return integer < 0 ? integer + SEED_RANGE : integer;
}

// Counter words 2 and 3 stay 0: the 64-bit position is the whole counter.
export function philox4x32(c0: number, c1: number, k0: number, k1: number, out: Uint32Array) {
	let c2 = 0;
	let c3 = 0;
	for(let i = 0; i < PHILOX_ROUNDS; i++) {
		const hi0 = mulhi(0xD2511F53, c0);
		const lo0 = Math.imul(0xD2511F53, c0) >>> 0;
		const hi1 = mulhi(0xCD9E8D57, c2);
		const lo1 = Math.imul(0xCD9E8D57, c2) >>> 0;
		c0 = (hi1 ^ c1 ^ k0) >>> 0;
		c1 = lo1;
		c2 = (hi0 ^ c3 ^ k1) >>> 0;
		c3 = lo0;
		k0 = (k0 + 0x9E3779B9) >>> 0;
		k1 = (k1 + 0xBB67AE85) >>> 0;
	}
	out[0] = c0;
	out[1] = c1;
	out[2] = c2;
	out[3] = c3;
}

// High 32 bits of a 32x32 product, built from 16-bit halves since doubles can't hold the full 64 bits exactly.
function mulhi(a: number, b: number): number {
	const a0 = a & 0xFFFF;
	const a1 = a >>> 16;
	const b0 = b & 0xFFFF;
	const b1 = b >>> 16;
	const p01 = a0 * b1;
	const p10 = a1 * b0;
	const mid = ((a0 * b0) >>> 16) + (p01 & 0xFFFF) + (p10 & 0xFFFF);
	return (a1 * b1 + (p01 >>> 16) + (p10 >>> 16) + (mid >>> 16)) >>> 0;
}
