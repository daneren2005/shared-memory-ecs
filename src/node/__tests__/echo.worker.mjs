import { parentPort } from 'node:worker_threads';

if(!parentPort) {
	throw new Error('echo.worker must run in a worker thread');
}

// Minimal real-thread worker: echoes each message back so NodeWorkerAdapter's onmessage/postMessage bridge can
// be verified end to end.
parentPort.on('message', message => {
	parentPort.postMessage({ echo: message });
});
