import { describe, it, expect } from 'vitest';
import MemoryHeap from '@daneren2005/shared-memory-objects/memory-heap';
import ConstantStringCache from '../constant-string-cache';

describe('ConstantStringCache', () => {
	it('interns by value: repeated strings share one allocation', () => {
		const heap = new MemoryHeap();
		const cache = new ConstantStringCache(heap);

		const first = cache.getOrCreate('Space Ship');
		const usedAfterFirst = heap.currentUsed;
		const second = cache.getOrCreate('Space Ship');

		expect(second).toBe(first);
		expect(second.pointer).toEqual(first.pointer);
		// No second allocation for the duplicate.
		expect(heap.currentUsed).toEqual(usedAfterFirst);

		const other = cache.getOrCreate('Miner');
		expect(other.pointer).not.toEqual(first.pointer);
	});

	it('resolves a pointer back to its string', () => {
		const heap = new MemoryHeap();
		const cache = new ConstantStringCache(heap);
		const string = cache.getOrCreate('Miner');

		expect(cache.getString(string.pointer)).toEqual('Miner');
		// A fresh cache over the same heap rebuilds it from memory (the worker's path).
		expect(new ConstantStringCache(heap).getString(string.pointer)).toEqual('Miner');
	});

	it('treats pointer 0 as the empty string', () => {
		const cache = new ConstantStringCache(new MemoryHeap());
		expect(cache.getString(0)).toEqual('');
	});

	it('returns undefined for a pointer into a not-yet-synced buffer', () => {
		const cache = new ConstantStringCache(new MemoryHeap());
		// bufferPosition 5 does not exist on this heap.
		const pointerIntoMissingBuffer = 5 + (64 << 12);
		expect(cache.getString(pointerIntoMissingBuffer)).toBeUndefined();
	});

	it('clear frees every interned allocation', () => {
		const heap = new MemoryHeap();
		const cache = new ConstantStringCache(heap);
		const startMemory = heap.currentUsed;

		cache.getOrCreate('Space Ship');
		cache.getOrCreate('Miner');
		expect(heap.currentUsed).toBeGreaterThan(startMemory);

		cache.clear();
		expect(heap.currentUsed).toEqual(startMemory);
		// After clear the same value re-interns fresh rather than returning a freed instance.
		expect(cache.getString(cache.getOrCreate('Space Ship').pointer)).toEqual('Space Ship');
	});
});
