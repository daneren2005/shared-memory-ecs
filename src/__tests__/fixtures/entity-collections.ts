import type BaseEntity from '../../entity';
import type { ComponentMap } from '../../component-definition';

// The world and the systems keep their entities in eid-keyed Maps, which is what makes a removal constant
// time - but an assertion usually wants a list, and most of them want the eids in the order they went in.
// These two keep that conversion out of the tests themselves.
export function listOf<T>(entities: Map<number, T>): Array<T> {
	return Array.from(entities.values());
}

export function eidsOf<C extends ComponentMap>(entities: Map<number, BaseEntity<C>>): Array<number> {
	return listOf(entities).map(entity => entity.eid);
}
