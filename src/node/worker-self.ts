import { parentPort } from 'node:worker_threads';

// Node counterpart to a Web Worker's global `self`. The ECS worker runtime drives its worker through the
// browser onmessage/postMessage contract; under Node there is no `self`, so bridge that contract onto
// parentPort. Messages that arrive before onmessage is assigned are buffered so the initial `init` handshake
// is never dropped.
type MessageHandler = (event: { data: unknown }) => void;
interface WorkerPort {
	on(event: 'message', listener: (data: unknown) => void): void
	postMessage(message: unknown): void
}

export class NodeWorkerSelf {
	private handler: MessageHandler | null = null;
	private pending: Array<unknown> = [];

	constructor(private port: WorkerPort) {
		port.on('message', data => this.deliver(data));
	}

	set onmessage(handler: MessageHandler | null) {
		this.handler = handler;
		if(handler) {
			const buffered = this.pending;
			this.pending = [];
			for(const data of buffered) {
				handler({ data });
			}
		}
	}
	get onmessage(): MessageHandler | null {
		return this.handler;
	}

	postMessage(message: unknown): void {
		this.port.postMessage(message);
	}

	private deliver(data: unknown): void {
		if(this.handler) {
			this.handler({ data });
		} else {
			this.pending.push(data);
		}
	}
}

// Defines `globalThis.self` as the parentPort bridge so a bundled worker entry that calls
// createEntitySystemWorker(self, ...) works under Node. Call once, before importing the worker module.
export function installWorkerSelf(): void {
	if(!parentPort) {
		throw new Error('installWorkerSelf must be called inside a worker thread');
	}
	(globalThis as { self?: unknown }).self = new NodeWorkerSelf(parentPort);
}
