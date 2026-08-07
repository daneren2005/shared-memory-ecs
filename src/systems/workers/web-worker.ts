// Minimal Worker-like base for the main-thread fallback. Loose params: this mirrors the DOM Worker boundary.
export default abstract class WebWorker {
	abstract postMessage(message: any): void | Promise<void>;
	onmessage(message: any, transferrables: Array<any> = []): void {

	}
}
