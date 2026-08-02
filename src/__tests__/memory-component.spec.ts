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
		// If we stop having stable memory locations we have to stop using cached data views in components!
		expect(component.getBlock(2).byteOffset).toEqual(startDataBlock.byteOffset);
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
