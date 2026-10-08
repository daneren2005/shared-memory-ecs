import type { EntityUpdateComponents, EntityWorkerSystemWorld, QueryDelta, UpdateEntityConfigObject } from '../entity-worker-system';
import type { EntityWorkBatch } from './entity-system-worker-message';

export default class EntityWorkBatchState<T extends EntityUpdateComponents, W extends EntityWorkerSystemWorld> {
	private world: W | undefined;
	private entities = new Map<number, UpdateEntityConfigObject<T>>();

	getWorld(world: W, batch: EntityWorkBatch | undefined): W {
		if(!batch || batch.first || !this.world) {
			this.world = world;
		}
		return this.world;
	}
	getEntities(entities: Array<UpdateEntityConfigObject<T>>, delta: QueryDelta<T>, batch: EntityWorkBatch | undefined): Array<UpdateEntityConfigObject<T>> {
		if(!batch) {
			this.entities.clear();
			return entities;
		}
		if(!this.entities.size) {
			for(const entity of entities) {
				this.entities.set(entity.entityId, entity);
			}
		}
		delta.removed.forEach(eid => this.entities.delete(eid));
		delta.added.forEach(entity => this.entities.set(entity.entityId, entity));
		const selected: Array<UpdateEntityConfigObject<T>> = [];
		for(const eid of batch.entityIds) {
			const entity = this.entities.get(eid);
			if(entity) {
				selected.push(entity);
			}
		}
		return selected;
	}
	finish(batch: EntityWorkBatch | undefined, failed: boolean): void {
		if(!batch || batch.last || failed) {
			this.world = undefined;
		}
	}
	clear(): void {
		this.world = undefined;
		this.entities.clear();
	}
}
