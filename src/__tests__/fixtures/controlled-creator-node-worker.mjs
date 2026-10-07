import { parentPort } from 'node:worker_threads';
import MemoryHeap from '@daneren2005/shared-memory-objects/memory-heap';
import SharedPool from '@daneren2005/shared-memory-objects/shared-pool';

if(!parentPort) {
	throw new Error('controlled-creator-node-worker must run in a worker thread');
}

let heap;
let pools;
let eidCounter;
let control;
let count;
let value;

parentPort.on('message', message => {
	if(message.type === 'init') {
		parentPort.postMessage({ type: 'init-complete' });
	} else if(message.type === 'load') {
		heap = new MemoryHeap(message.heap);
		heap.addOnGrowBufferHandlers(buffer => parentPort.postMessage({ type: 'grow-buffer-from-worker', buffer }));
		pools = Object.fromEntries(Object.entries(message.sharedMemory.components).map(([name, memory]) => [name, new SharedPool(heap, memory)]));
		eidCounter = heap.getSharedAlloc(message.sharedMemory.eidCounter);
		({ control, count, value } = message.data);
		parentPort.postMessage({ type: 'loaded' });
	} else if(message.type === 'grow-buffer') {
		if(!heap.buffers[message.buffer.bufferPosition]) {
			heap.addSharedBuffer(message.buffer);
		}
	} else if(message.type === 'run') {
		const created = [];
		for(let i = 0; i < count; i++) {
			const eid = Atomics.add(eidCounter.data, 0, 1) + 1;
			created.push({ eid, type: 'spawn', components: { health: pools.health.push([value, value]) } });
		}
		Atomics.store(control, 2, created[0].eid);
		Atomics.store(control, 0, 1);
		Atomics.notify(control, 0);
		Atomics.wait(control, 1, 0);
		parentPort.postMessage({
			type: 'run-complete', generation: message.generation, runTime: 0,
			events: [], systemEvents: {}, componentChanges: [], created, errors: [],
		});
	}
});
