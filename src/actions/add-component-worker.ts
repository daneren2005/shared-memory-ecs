import type { ComponentMap } from '../component-definition';
import type { EntityWorkerSystemCallbacks, EntityWorkerSystemWorld } from '../systems/entity-worker-system';

// Allocates a component block in the worker and asks the main thread to attach it after the run. The entity's
// current query snapshot is intentionally unchanged until the next run.
export default function addComponentWorker<C extends ComponentMap, K extends keyof C>(
	world: EntityWorkerSystemWorld,
	entityId: number,
	componentName: K,
	config: Record<string, unknown>,
	callbacks: EntityWorkerSystemCallbacks<C>,
): void {
	if(!world.buildComponentDescriptor) {
		throw new Error('addComponentWorker requires addsComponents: true and the component registry passed to createEntitySystemWorker');
	}

	callbacks.addComponent(entityId, world.buildComponentDescriptor(String(componentName), config));
}
