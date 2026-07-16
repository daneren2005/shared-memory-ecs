import type { EntityUpdateComponents, QueryDelta, UpdateEntityConfigObject } from '../component-system';

// A worker keeps one persistent list per query and applies the delta each run carries: drop the entities that
// left, then upsert the ones that joined (or whose component blocks changed).  Because the main thread only
// sends changes, a steady-state run - where membership is unchanged - carries empty arrays and this returns the
// existing list untouched with no allocation, which is the whole point of the delta protocol: we stop
// re-transmitting (and re-cloning) every entity id every single frame.
//
// The list is returned (rather than mutated in place) because removals rebuild it via filter; callers must store
// the returned reference back as their persistent list.
export function applyQueryDelta<T extends EntityUpdateComponents>(
	list: Array<UpdateEntityConfigObject<T>>,
	delta: QueryDelta<T>,
): Array<UpdateEntityConfigObject<T>> {
	if(delta.removed.length) {
		const removedSet = new Set(delta.removed);
		list = list.filter(entry => !removedSet.has(entry.entityId));
	}

	if(delta.added.length) {
		// Map existing members so a re-added entity (its component set changed) replaces its entry in place
		// instead of being duplicated; genuinely new entities are appended.
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
