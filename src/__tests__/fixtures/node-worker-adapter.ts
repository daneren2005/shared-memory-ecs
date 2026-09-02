import { Worker as NodeWorker } from 'node:worker_threads';

// A real OS-thread worker for concurrency tests. The normal Vitest Worker shim deliberately runs in-process.
export default class NodeWorkerAdapter {
	onmessage: ((event: MessageEvent) => void) | null = null;
	private worker: NodeWorker;

	constructor(url: URL) {
		this.worker = new NodeWorker(url);
		this.worker.on('message', data => {
			this.onmessage?.({ data } as MessageEvent);
		});
	}

	postMessage(message: unknown): void {
		this.worker.postMessage(message);
	}

	terminate(): void {
		void this.worker.terminate();
	}
}
