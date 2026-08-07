import type BaseEntity from '../entity';

// Flags the entity dead in shared memory and emits `death`; BaseWorld listens for it to remove the entity.
export default function killEntity(entity: BaseEntity): void {
	entity.components.entity.dead = true;
	entity.emit('death');
}
