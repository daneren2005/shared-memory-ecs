import type { MemoryHeapMemory, GrowBufferData } from '@daneren2005/shared-memory-objects/memory-heap';
import type { WorldSharedMemory } from '../../world';
import type { ComponentSystemWorld, QueryDelta, WorkerCreatedEntity } from '../component-system';

interface InitMessage {
	type: 'init'
}

interface InitCompleteMessage {
	type: 'init-complete'
}

// Sent on every (re)load: carries the system's init data and runs updateFunction.init. `sharedMemory` lets a real
// worker reconstruct handles over the world's component pools + eid counter (for off-thread allocation).
interface LoadMessage<D = unknown> {
	type: 'load'
	data?: D
	heap?: MemoryHeapMemory
	sharedMemory?: WorldSharedMemory
	// Factory templates by type, shipped only to systems registered with createsEntities, so the worker can merge a
	// type's template when creating an entity from a config.
	factoryConfigs?: { [type: string]: Record<string, unknown> }
}

// A buffer the heap grew after load: forwarded so the worker's reconstructed heap keeps resolving new pointers.
interface GrowBufferMessage {
	type: 'grow-buffer'
	buffer: GrowBufferData
}

// A buffer a worker grew itself (allocating off-thread): reported back so the main thread adopts it and fans it out
// to sibling workers.
interface GrowBufferFromWorkerMessage {
	type: 'grow-buffer-from-worker'
	buffer: GrowBufferData
}

interface LoadedMessage {
	type: 'loaded'
}

// Tells the worker to drop its persistent entity/query lists so a reused world starts from empty
interface ResetMessage {
	type: 'reset'
}

interface RunUpdateMessage<W extends ComponentSystemWorld = ComponentSystemWorld> {
	type: 'run'
	generation: number
	world: W
	entities: QueryDelta
	queries: { [key: string]: QueryDelta }
}

// An event a worker asks the main thread to emit on an entity. Structured-cloned, so `args` must be cloneable.
export interface EntityEvent {
	entityId: number
	event: string
	args: Array<unknown>
}

// For each event the update function named, the ids it happened to. The cheap way to report something that
// happens to many entities every run: no args (values are already in shared memory), just ids. Emitted on the
// system, not per entity.
export type SystemEvents = { [event: string]: Array<number> };

interface EntityEventsMessage {
	type: 'run-complete'
	generation: number
	runTime: number
	events: Array<EntityEvent>
	systemEvents: SystemEvents
	created: Array<WorkerCreatedEntity>
}

type ComponentWorkerMessage<W extends ComponentSystemWorld = ComponentSystemWorld, D = unknown> =
	InitMessage | InitCompleteMessage | LoadMessage<D> | LoadedMessage | ResetMessage | GrowBufferMessage | GrowBufferFromWorkerMessage | RunUpdateMessage<W> | EntityEventsMessage;
export default ComponentWorkerMessage;
