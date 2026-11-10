import type BaseEntity from '../../entity';
import type { ComponentMap } from '../../component-definition';
import type MemoryComponent from '../../memory-component';
import type { EntityUpdateComponents, UpdateEntityConfigObject } from '../entity-worker-system';
import type { LoadQueryDelta, PackedEntities } from './entity-system-worker-message';

const ABSENT_COMPONENT = -1;

export function packEntities<C extends ComponentMap>(
	members: { size: number, values(): Iterable<BaseEntity<C>> },
	componentNames: ReadonlyArray<keyof C>,
): PackedEntities {
	const entityIds = new Uint32Array(members.size);
	const columns = componentNames.map(() => new Int32Array(members.size));
	let row = 0;
	for(const entity of members.values()) {
		entityIds[row] = entity.eid;
		for(let column = 0; column < columns.length; column++) {
			const component = entity.components[componentNames[column]];
			columns[column][row] = component?.block ? component.index : ABSENT_COMPONENT;
		}
		row++;
	}

	const components: PackedEntities['components'] = {};
	componentNames.forEach((name, column) => {
		components[name as string] = columns[column];
	});
	return { entityIds, components };
}

export function getPackedTransferables(packed: PackedEntities): Array<Transferable> {
	return [packed.entityIds.buffer, ...Object.values(packed.components).map(column => column.buffer)];
}

export function unpackEntities<T extends EntityUpdateComponents>(
	packed: PackedEntities,
	pools: { [name: string]: MemoryComponent },
): Array<UpdateEntityConfigObject<T>> {
	const names = Object.keys(packed.components) as Array<keyof T & string>;
	const columns = names.map(name => packed.components[name]);
	const columnPools = names.map(name => pools[name]);
	const entities: Array<UpdateEntityConfigObject<T>> = [];
	for(let row = 0; row < packed.entityIds.length; row++) {
		const components = {} as T;
		for(let column = 0; column < names.length; column++) {
			const index = columns[column][row];
			if(index !== ABSENT_COMPONENT) {
				components[names[column]] = columnPools[column].getBlock(index) as T[keyof T & string];
			}
		}
		entities.push({ entityId: packed.entityIds[row], components });
	}
	return entities;
}

export function expandPackedAdded(delta: LoadQueryDelta, pools: { [name: string]: MemoryComponent }): void {
	if(delta.packedAdded) {
		delta.added = unpackEntities(delta.packedAdded, pools);
	}
}
