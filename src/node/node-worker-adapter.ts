import { Worker as NodeWorker, type WorkerOptions } from 'node:worker_threads';

export { installWorkerSelf } from './worker-self';

// Web Worker-compatible wrapper over a Node worker_threads Worker. The ECS worker runtime drives its worker
// through the browser `worker.onmessage` / `worker.postMessage` API; Node exposes messages as EventEmitter
// events instead, so bridge the two. Lets worker systems run on real OS threads under Node (headless sim).
export default class NodeWorkerAdapter {
	onmessage: ((event: { data: unknown }) => void) | null = null;
	private worker: NodeWorker;

	constructor(url: string | URL, options?: WorkerOptions) {
		this.worker = new NodeWorker(url, options);
		this.worker.on('message', data => this.onmessage?.({ data }));
	}

	postMessage(message: unknown): void {
		this.worker.postMessage(message);
	}

	terminate(): void {
		void this.worker.terminate();
	}
}
