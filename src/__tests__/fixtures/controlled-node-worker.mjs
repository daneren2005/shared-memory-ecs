import { parentPort } from 'node:worker_threads';
import MemoryHeap from '@daneren2005/shared-memory-objects/memory-heap';
import SharedPool from '@daneren2005/shared-memory-objects/shared-pool';

if(!parentPort) {
	throw new Error('controlled-node-worker must run in a worker thread');
}

const STARTED_INDEX = 0;
const RESUME_INDEX = 1;

let control;
let entities = [];

function applyDelta(delta) {
	if(delta.removed.length) {
		const removed = new Set(delta.removed);
		entities = entities.filter(entity => !removed.has(entity.entityId));
	}

	for(const added of delta.added) {
		const existing = entities.findIndex(entity => entity.entityId === added.entityId);
		if(existing === -1) {
			entities.push(added);
		} else {
			entities[existing] = added;
		}
	}
}

function expandPackedAdded(message) {
	const heap = new MemoryHeap(message.heap);
	const { entityIds, components } = message.entities.packedAdded;
	const names = Object.keys(components);
	const pools = names.map(name => new SharedPool(heap, message.sharedMemory.components[name]));
	message.entities.added = Array.from(entityIds, (entityId, row) => {
		const blocks = {};
		names.forEach((name, column) => {
			if(components[name][row] !== -1) {
				blocks[name] = pools[column].at(components[name][row]);
			}
		});
		return { entityId, components: blocks };
	});
}

parentPort.on('message', message => {
	if(message.type === 'init') {
		parentPort.postMessage({ type: 'init-complete' });
		return;
	}
	if(message.type === 'load') {
		control = message.data.control;
		expandPackedAdded(message);
		applyDelta(message.entities);
		parentPort.postMessage({ type: 'loaded' });
		return;
	}
	if(message.type === 'reset') {
		entities = [];
		return;
	}
	if(message.type !== 'run') {
		return;
	}

	applyDelta(message.entities);
	if(control.length >= 4) {
		Atomics.store(control, 2, message.world.gameTime);
		Atomics.store(control, 3, message.world.elapsedTime);
	}
	Atomics.store(control, STARTED_INDEX, 1);
	Atomics.notify(control, STARTED_INDEX);
	Atomics.wait(control, RESUME_INDEX, 0);

	for(const entity of entities) {
		if(entity.components.health) {
			entity.components.health[0] = 777;
		}
	}

	parentPort.postMessage({
		type: 'run-complete',
		generation: message.generation,
		runTime: 0,
		events: [],
		systemEvents: {},
		created: [],
		errors: [],
	});
});
