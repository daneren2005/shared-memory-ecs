import MemoryHeap from '@daneren2005/shared-memory-objects/memory-heap';
import { MemoryComponent } from '../index';

describe('memory component', () => {
	it('basic', () => {
		let heap = new MemoryHeap({ bufferSize: 100 * 1024 });
		let component = new MemoryComponent(heap, Float32Array, 5);

		let index = component.create([5, 10, 12, 14, 6]);
		expect([...component.getBlock(index)]).toEqual([5, 10, 12, 14, 6]);
		expect(component.get(index, 0)).toEqual(5);
		expect(component.get(index, 2)).toEqual(12);
		expect(component.get(index, 4)).toEqual(6);
	});

	it('recycle indexes', () => {
		let heap = new MemoryHeap({ bufferSize: 100 * 1024 });
		let component = new MemoryComponent(heap, Float32Array, 2);

		component.create([1, 1]);
		component.create([2, 2]);
		component.create([3, 3]);
		let startDataBlock = component.getBlock(2);

		component.delete(1);
		component.create([4, 4]);
		component.delete(0);
		expect([...component.getBlock(0)]).toEqual([1, 1]);
		expect([...component.getBlock(1)]).toEqual([4, 4]);
		expect([...component.getBlock(2)]).toEqual([3, 3]);

		component.delete(0);
		expect([...component.getBlock(2)]).toEqual([3, 3]);
		// Components cache data views, so block memory locations must stay stable across deletes.
		expect(component.getBlock(2).byteOffset).toEqual(startDataBlock.byteOffset);
	});

	it('reconstructs a handle over an existing pool from getSharedMemory', () => {
		let heap = new MemoryHeap({ bufferSize: 100 * 1024 });
		let owner = new MemoryComponent(heap, Int32Array, 2);
		let index = owner.create([7, 8]);

		// Same heap, second handle over the same pool - mirrors a worker rebuilding from the shipped SharedPoolMemory.
		let reconstructed = MemoryComponent.fromSharedMemory<Int32Array>(heap, owner.getSharedMemory());
		expect([...reconstructed.getBlock(index)]).toEqual([7, 8]);

		// A block allocated through the reconstructed handle is visible to the owner, and vice versa.
		let workerIndex = reconstructed.create([11, 12]);
		expect([...owner.getBlock(workerIndex)]).toEqual([11, 12]);
		owner.set(workerIndex, 0, 99);
		expect(reconstructed.get(workerIndex, 0)).toEqual(99);
	});

	it('reconstructs across a heap cloned from shared buffers', () => {
		let heap = new MemoryHeap({ bufferSize: 100 * 1024 });
		let owner = new MemoryComponent(heap, Int32Array, 2);
		let index = owner.create([1, 2]);

		// A cloned heap over the same SharedArrayBuffers is what a real worker holds.
		let cloneHeap = new MemoryHeap(heap.getSharedMemory());
		let reconstructed = MemoryComponent.fromSharedMemory<Int32Array>(cloneHeap, owner.getSharedMemory());
		expect([...reconstructed.getBlock(index)]).toEqual([1, 2]);

		let workerIndex = reconstructed.create([3, 4]);
		expect([...owner.getBlock(workerIndex)]).toEqual([3, 4]);
	});

	it('multiple internal vectors for large number of entities', () => {
		let heap = new MemoryHeap({ bufferSize: 10 * 1024 });
		let component = new MemoryComponent(heap, Float32Array, 5);

		for(let i = 0; i < 1_000; i++) {
			component.create([i]);
		}

		for(let i = 0; i < 1_000; i++) {
			expect(component.get(i, 0)).toEqual(i);
		}

		component.set(100, 0, 10);
		component.set(200, 0, 20);
		component.set(300, 0, 30);
		component.set(400, 0, 40);

		expect(component.get(100, 0)).toEqual(10);
		expect(component.get(200, 0)).toEqual(20);
		expect(component.get(300, 0)).toEqual(30);
		expect(component.get(400, 0)).toEqual(40);
	});
});
