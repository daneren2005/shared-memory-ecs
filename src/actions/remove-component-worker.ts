import type { ComponentMap } from '../component-definition';
import type { EntityWorkerSystemCallbacks } from '../systems/entity-worker-system';

// Requests a main-thread detach after the worker run. Shared memory is freed only after every system that could
// still hold the old block has completed a run.
export default function removeComponentWorker<C extends ComponentMap, K extends keyof C>(
	entityId: number,
	componentName: K,
	callbacks: EntityWorkerSystemCallbacks<C>,
): void {
	callbacks.removeComponent(entityId, componentName);
}
