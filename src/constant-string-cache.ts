import ConstantString from '@daneren2005/shared-memory-objects/constant-string';
import { getPointer } from '@daneren2005/shared-memory-objects/utils/pointer';
import type MemoryHeap from '@daneren2005/shared-memory-objects/memory-heap';

// Interns immutable strings in the heap and resolves them back from a pointer. Every distinct value is allocated
// once as a single ConstantString shared by all users (15 "Space Ship" entities point at one allocation), and a
// pointer resolves to its string through a Map hit before ever rebuilding it from memory. Both sides of the
// worker boundary hold one: the main thread creates + interns; a worker (with a heap reconstructed from the same
// SharedArrayBuffers) only ever resolves pointers and caches the results.
export default class ConstantStringCache {
	private heap: MemoryHeap;
	// value -> the one interned allocation. Only the creating (main) thread populates this; it owns the memory.
	private byValue = new Map<string, ConstantString>();
	// pointer -> value: the fast lookup every thread checks before touching memory.
	private byPointer = new Map<number, string>();

	constructor(heap: MemoryHeap) {
		this.heap = heap;
	}

	// Dedupes on value, so repeated types share a single ConstantString. Main-thread only.
	getOrCreate(value: string): ConstantString {
		let existing = this.byValue.get(value);
		if(existing) {
			return existing;
		}

		const string = new ConstantString(this.heap, value);
		this.byValue.set(value, string);
		this.byPointer.set(string.pointer, value);

		return string;
	}

	// pointer -> string, checking the cache before rebuilding from memory. A pointer of 0 is the empty string; a
	// pointer into a buffer that has not synced to this thread yet returns undefined.
	getString(pointer: number): string | undefined {
		if(pointer === 0) {
			return '';
		}

		let cached = this.byPointer.get(pointer);
		if(cached !== undefined) {
			return cached;
		}

		const memory = getPointer(pointer);
		if(this.heap.buffers[memory.bufferPosition] === undefined) {
			return undefined;
		}

		const value = new ConstantString(this.heap, memory).value;
		this.byPointer.set(pointer, value);

		return value;
	}

	// Frees every allocation this cache owns and empties the lookups. A worker's cache owns nothing (it only ever
	// resolved views), so this just drops its pointer lookups.
	clear() {
		this.byValue.forEach(string => string.free());
		this.byValue.clear();
		this.byPointer.clear();
	}
}
