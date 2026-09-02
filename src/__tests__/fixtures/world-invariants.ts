import type { ComponentDefinitionMap, ComponentMap } from '../../component-definition';
import type BaseWorld from '../../world';
import type MemoryComponent from '../../memory-component';

interface DeferredFree {
	memoryComponent: MemoryComponent
	index: number
}

interface FreeBuffer {
	frees: Array<DeferredFree>
}

interface InspectableDefinition {
	memoryComponent: MemoryComponent
}

// Intended for quiescent test points: in-flight worker allocations are temporarily neither live nor deferred.
export function findWorldInvariantViolations<R extends ComponentDefinitionMap, C extends ComponentMap, Cfg>(world: BaseWorld<R, C, Cfg>): Array<string> {
	const violations: Array<string> = [];
	const registry = world.registry as unknown as Record<string, InspectableDefinition>;
	const liveByPool = new Map<MemoryComponent, Set<number>>();

	world.entities.forEach((entity, eid) => {
		if(entity.eid !== eid) {
			violations.push(`entity map key ${eid} does not match entity eid ${entity.eid}`);
		}
		if(entity.world !== world) {
			violations.push(`entity ${eid} belongs to another world`);
		}

		for(const [name, component] of Object.entries(entity.components)) {
			if(!component) {
				continue;
			}
			const definition = registry[name];
			if(!definition) {
				violations.push(`entity ${eid} has unknown component ${name}`);
				continue;
			}

			const indexes = liveByPool.get(definition.memoryComponent) ?? new Set<number>();
			if(indexes.has(component.index)) {
				violations.push(`component ${name} index ${component.index} is owned by more than one live entity`);
			}
			indexes.add(component.index);
			liveByPool.set(definition.memoryComponent, indexes);
		}
	});

	const active = Reflect.get(world, 'activeFreeBuffer') as FreeBuffer;
	const next = Reflect.get(world, 'nextFreeBuffer') as FreeBuffer;
	const deferredByPool = new Map<MemoryComponent, Set<number>>();
	for(const deferred of [...active.frees, ...next.frees]) {
		const indexes = deferredByPool.get(deferred.memoryComponent) ?? new Set<number>();
		if(indexes.has(deferred.index)) {
			violations.push(`component index ${deferred.index} is queued for free more than once`);
		}
		if(liveByPool.get(deferred.memoryComponent)?.has(deferred.index)) {
			violations.push(`component index ${deferred.index} is both live and queued for free`);
		}
		indexes.add(deferred.index);
		deferredByPool.set(deferred.memoryComponent, indexes);
	}

	for(const [name, definition] of Object.entries(registry)) {
		const accounted = (liveByPool.get(definition.memoryComponent)?.size ?? 0)
			+ (deferredByPool.get(definition.memoryComponent)?.size ?? 0);
		if(definition.memoryComponent.length !== accounted) {
			violations.push(`${name} pool has ${definition.memoryComponent.length} allocations but ${accounted} are owned or deferred`);
		}
	}

	return violations;
}
