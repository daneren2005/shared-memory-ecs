import SharedPool from '@daneren2005/shared-memory-objects/shared-pool';
import type { SharedPoolMemory } from '@daneren2005/shared-memory-objects/shared-pool';
import type MemoryHeap from '@daneren2005/shared-memory-objects/memory-heap';
import type { TypedArrayConstructor } from '@daneren2005/shared-memory-objects/interfaces/typed-array-constructor';

export type ComponentTypedArray = Uint32Array | Int32Array | Float32Array | Float64Array;

// Backed by a SharedPool: all bookkeeping lives in the shared heap, so a worker can reconstruct a handle over
// the same pool (pass the owner's getSharedMemory() as `memory`) and allocate/read blocks off-thread.
export default class MemoryComponent<T extends ComponentTypedArray = ComponentTypedArray> {
	heap: MemoryHeap;
	pool: SharedPool<T>;

	constructor(heap: MemoryHeap, type: TypedArrayConstructor<T>, dataLength: number, memory?: SharedPoolMemory) {
		this.heap = heap;
		this.pool = memory
			? new SharedPool<T>(heap, memory)
			: new SharedPool<T>(heap, {
				type,
				dataLength,
			});
	}

	// Reconstructs a handle over an existing pool (from the owner's getSharedMemory()) — used in a worker, where the
	// pool's type/dataLength are already recorded in the heap header, so no definition is needed.
	static fromSharedMemory<T extends ComponentTypedArray = ComponentTypedArray>(heap: MemoryHeap, memory: SharedPoolMemory): MemoryComponent<T> {
		return new MemoryComponent<T>(heap, Uint32Array as unknown as TypedArrayConstructor<T>, 1, memory);
	}

	getSharedMemory(): SharedPoolMemory {
		return this.pool.getSharedMemory();
	}

	get length() {
		return this.pool.length;
	}
	get rawLength() {
		return this.pool.bufferLength;
	}

	create(values: Array<number>): number {
		return this.pool.push(values);
	}

	getBlock(index: number): T {
		return this.pool.at(index);
	}
	get(index: number, dataIndex: number): number {
		return this.pool.get(index, dataIndex);
	}
	set(index: number, dataIndex: number, value: number) {
		let array = this.pool.at(index);
		array[dataIndex] = value;
	}

	delete(index: number) {
		this.pool.deleteIndex(index);
	}
	clear() {
		this.pool.clear();
	}
}
