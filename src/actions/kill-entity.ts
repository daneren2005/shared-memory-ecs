import type BaseEntity from '../entity';

// Kills an entity on the main thread: flags it dead in shared memory and emits `death` so the world and
// any game listeners can react.  BaseWorld#addEntity listens for `death` to remove the entity.
export default function killEntity(entity: BaseEntity): void {
	entity.components.entity.dead = true;
	entity.emit('death');
}
