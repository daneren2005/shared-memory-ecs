import type { EntityUpdateComponents, QueryDelta, UpdateEntityConfigObject } from '../entity-worker-system';

// A query's persistent member list on the worker side, kept from each run's delta. The eid index lives across runs so
// a delta costs only its own size: removal swaps the last member into the gap, so order is not kept across removals.
// `entries` is the same array for the membership's whole life; update functions are handed it directly.
export default class QueryMembership<T extends EntityUpdateComponents> {
	readonly entries: Array<UpdateEntityConfigObject<T>> = [];
	private readonly indexByEid = new Map<number, number>();

	// Removals first, so a remove+add of the same eid in one delta keeps the fresh entry.
	apply(delta: QueryDelta<T>): void {
		for(const entityId of delta.removed) {
			const index = this.indexByEid.get(entityId);
			if(index === undefined) {
				continue;
			}
			this.indexByEid.delete(entityId);
			const last = this.entries.pop()!;
			if(index < this.entries.length) {
				this.entries[index] = last;
				this.indexByEid.set(last.entityId, index);
			}
		}
		for(const entity of delta.added) {
			const existing = this.indexByEid.get(entity.entityId);
			if(existing !== undefined) {
				// Upsert: a re-added entity brings fresh block views.
				this.entries[existing] = entity;
			} else {
				this.indexByEid.set(entity.entityId, this.entries.length);
				this.entries.push(entity);
			}
		}
	}

	clear(): void {
		this.entries.length = 0;
		this.indexByEid.clear();
	}
}
