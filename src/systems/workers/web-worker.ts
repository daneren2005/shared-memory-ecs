// Minimal Worker-like base used for the main-thread fallback when real Web Workers / SharedArrayBuffer
// are unavailable.  Params are intentionally loose since this is the (serialization) boundary that
// mirrors the DOM Worker interface.
export default abstract class WebWorker {
	abstract postMessage(message: any): void | Promise<void>;
	onmessage(message: any, transferrables: Array<any> = []): void {

	}
}
