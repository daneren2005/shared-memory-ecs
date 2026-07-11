import { LocalPool, type MemoryHeap, type TypedArrayConstructor } from '@daneren2005/shared-memory-objects';

// The typed arrays a MemoryComponent can be backed by.  Kept narrower than the package's TypedArray
// union on purpose since these are the only types we allocate blocks of.
export type ComponentTypedArray = Uint32Array | Int32Array | Float32Array | Float64Array;

// A pool of same sized blocks living inside a shared MemoryHeap.  Each component instance owns one
// block (referenced by its index) so component data can be shared with worker threads.
export default class MemoryComponent<T extends ComponentTypedArray = ComponentTypedArray> {
	heap: MemoryHeap;
	pool: LocalPool<T>;

	constructor(heap: MemoryHeap, type: TypedArrayConstructor<T>, dataLength: number) {
		this.heap = heap;
		this.pool = new LocalPool(heap, {
			type,
			dataLength,
		});
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
