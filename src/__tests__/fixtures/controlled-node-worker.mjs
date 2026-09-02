import { parentPort } from 'node:worker_threads';

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

parentPort.on('message', message => {
	if(message.type === 'init') {
		parentPort.postMessage({ type: 'init-complete' });
		return;
	}
	if(message.type === 'load') {
		control = message.data.control;
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
