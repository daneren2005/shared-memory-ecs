import NodeWorkerAdapter from '../node-worker-adapter';
import { NodeWorkerSelf } from '../worker-self';

interface FakePort {
	on(event: 'message', listener: (data: unknown) => void): void
	postMessage(message: unknown): void
	emit(data: unknown): void
	sent: Array<unknown>
}

function createFakePort(): FakePort {
	let listener: ((data: unknown) => void) | undefined;
	const sent: Array<unknown> = [];
	return {
		on(_event, handler) {
			listener = handler;
		},
		postMessage(message) {
			sent.push(message);
		},
		emit(data) {
			listener?.(data);
		},
		sent,
	};
}

describe('NodeWorkerSelf', () => {
	it('buffers messages that arrive before onmessage is assigned, then flushes in order', () => {
		const port = createFakePort();
		const self = new NodeWorkerSelf(port);
		port.emit({ type: 'init' });
		port.emit({ type: 'load' });

		const received: Array<unknown> = [];
		self.onmessage = event => received.push(event.data);

		expect(received).toEqual([{ type: 'init' }, { type: 'load' }]);
	});

	it('forwards messages received after onmessage is assigned', () => {
		const port = createFakePort();
		const self = new NodeWorkerSelf(port);
		const received: Array<unknown> = [];
		self.onmessage = event => received.push(event.data);

		port.emit({ type: 'run' });

		expect(received).toEqual([{ type: 'run' }]);
	});

	it('delegates postMessage to the underlying port', () => {
		const port = createFakePort();
		const self = new NodeWorkerSelf(port);
		self.postMessage({ type: 'run-complete' });
		expect(port.sent).toEqual([{ type: 'run-complete' }]);
	});
});

describe('NodeWorkerAdapter', () => {
	it('bridges onmessage/postMessage to a real worker thread and terminates it', async () => {
		const worker = new NodeWorkerAdapter(new URL('./echo.worker.mjs', import.meta.url));
		const reply = await new Promise<unknown>((res, rej) => {
			const timer = setTimeout(() => rej(new Error('worker did not reply')), 5000);
			worker.onmessage = event => {
				clearTimeout(timer);
				res(event.data);
			};
			worker.postMessage({ hello: 'thread' });
		});

		expect(reply).toEqual({ echo: { hello: 'thread' } });
		worker.terminate();
	});
});
