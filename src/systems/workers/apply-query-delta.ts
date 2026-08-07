import type { EntityUpdateComponents, QueryDelta, UpdateEntityConfigObject } from '../component-system';

// Applies a run's delta to a query's persistent list: drop the entities that left, upsert those that joined or
// changed. A steady-state run carries empty arrays and returns the list untouched. Returns the list (removals
// rebuild it via filter), so callers must store the returned reference back.
export function applyQueryDelta<T extends EntityUpdateComponents>(
	list: Array<UpdateEntityConfigObject<T>>,
	delta: QueryDelta<T>,
): Array<UpdateEntityConfigObject<T>> {
	if(delta.removed.length) {
		const removedSet = new Set(delta.removed);
		list = list.filter(entry => !removedSet.has(entry.entityId));
	}

	if(delta.added.length) {
		// Index existing members so a re-added entity replaces its entry in place instead of duplicating.
		const indexByEid = new Map<number, number>();
		list.forEach((entry, index) => indexByEid.set(entry.entityId, index));

		for(let entity of delta.added) {
			const existing = indexByEid.get(entity.entityId);
			if(existing !== undefined) {
				list[existing] = entity;
			} else {
				indexByEid.set(entity.entityId, list.length);
				list.push(entity);
			}
		}
	}

	return list;
}
