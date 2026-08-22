import type { WorkerAllocator, WorkerCreateEntityConfig, WorkerCreatedEntity } from '../systems/component-system';

// The slice of a component definition worker-side creation needs. Both the game's ComponentDefinitionMap and the
// world's RegisteredComponentRegistry satisfy it.
export interface WorkerCreatableComponent {
	loadProperties: Array<string>
	loadInFinishLoading?: boolean
	toBlock(config: Record<string, unknown>): Array<number>
}
export type WorkerCreateRegistry = { [name: string]: WorkerCreatableComponent };
export type FactoryConfigs = { [type: string]: Record<string, unknown> };

// Turns a factory-style config ({ type, ...overrides }) into a WorkerCreatedEntity, off-thread: layers the type's
// factory template under the overrides, mints an id, and allocates + writes each triggered component's block via its
// toBlock(). The always-present `entity` component is NOT built here - the main thread builds it on adopt (interning
// the type is main-thread-only), reading `type`/`isStatic` off this descriptor. Shared by the real worker and the
// main-thread fallback so both behave identically.
export function buildWorkerEntity(
	config: WorkerCreateEntityConfig,
	factoryConfigs: FactoryConfigs,
	registry: WorkerCreateRegistry,
	allocator: WorkerAllocator,
): WorkerCreatedEntity {
	const template = factoryConfigs[config.type] ?? {};
	const merged: Record<string, unknown> = { ...template, ...config };

	const eid = allocator.allocateEid();
	const components: { [name: string]: number } = {};
	for(let name of Object.keys(registry)) {
		// The entity component is always built on the main thread when the descriptor is adopted (interning the type),
		// never off-thread - skip it here whether or not the registry includes it.
		if(name === 'entity') {
			continue;
		}
		const definition = registry[name];
		// Deferred components need the whole world (other entities) that a worker doesn't have; skip them.
		if(definition.loadInFinishLoading) {
			continue;
		}
		if(definition.loadProperties.some(prop => prop in merged)) {
			components[name] = allocator.allocateComponentBlock(name, definition.toBlock(merged));
		}
	}

	return {
		eid,
		type: config.type,
		isStatic: merged.isStatic as boolean | undefined,
		components,
	};
}
