import type BaseEntity from '../../entity';
import type { ComponentMap } from '../../component-definition';

// Converts the eid-keyed Maps the world/systems use into ordered lists for assertions.
export function listOf<T>(entities: Map<number, T>): Array<T> {
	return Array.from(entities.values());
}

export function eidsOf<C extends ComponentMap>(entities: Map<number, BaseEntity<C>>): Array<number> {
	return listOf(entities).map(entity => entity.eid);
}
