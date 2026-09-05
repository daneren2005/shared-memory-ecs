import type { WorkerAllocator, WorkerCreateEntityConfig, WorkerCreatedComponent, WorkerCreatedEntity } from '../systems/entity-worker-system';
import type { WorkerEntityClassRegistry } from '../entity-class';

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
	classes?: WorkerEntityClassRegistry,
): WorkerCreatedEntity {
	const template = factoryConfigs[config.type] ?? {};
	if(classes && Object.prototype.hasOwnProperty.call(config, 'class')) {
		throw new Error('Entity class comes from its type template and cannot be supplied by a worker config');
	}
	const merged: Record<string, unknown> = { ...template, ...config };
	const entityClass = typeof template.class === 'string' ? template.class : undefined;
	let componentNames = Object.keys(registry);
	if(classes) {
		if(template.type !== config.type) {
			throw new Error(`Entity template ${config.type} must declare the same type`);
		}
		const definition = entityClass ? classes[entityClass] : undefined;
		if(!definition) {
			throw new Error(`Entity type ${config.type} has unknown class ${entityClass ?? ''}`);
		}
		componentNames = definition.components;
	}

	const eid = allocator.allocateEid();
	const components: { [name: string]: number } = {};
	for(let name of componentNames) {
		// The entity component is always built on the main thread when the descriptor is adopted (interning the type),
		// never off-thread - skip it here whether or not the registry includes it.
		if(name === 'entity') {
			continue;
		}
		const definition = registry[name];
		if(!definition) {
			throw new Error(`Entity class ${entityClass ?? ''} contains unknown component ${name}`);
		}
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
		class: entityClass,
		isStatic: merged.isStatic as boolean | undefined,
		components,
	};
}

export function buildWorkerComponent(
	name: string,
	config: Record<string, unknown>,
	registry: WorkerCreateRegistry,
	allocator: WorkerAllocator,
): WorkerCreatedComponent {
	if(name === 'entity') {
		throw new Error('The entity component cannot be added at runtime');
	}
	const definition = registry[name];
	if(!definition) {
		throw new Error(`Unknown component: ${name}`);
	}
	if(definition.loadInFinishLoading) {
		throw new Error(`Component ${name} requires main-thread finishLoading and cannot be added in a worker`);
	}

	return {
		name,
		index: allocator.allocateComponentBlock(name, definition.toBlock(config)),
	};
}
