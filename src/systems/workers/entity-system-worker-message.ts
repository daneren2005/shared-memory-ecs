import type { MemoryHeapMemory, GrowBufferData } from '@daneren2005/shared-memory-objects/memory-heap';
import type { WorldSharedMemory } from '../../world';
import type { EntityUpdateComponents, EntityWorkerSystemWorld, QueryDelta, WorkerComponentChange, WorkerCreatedEntity } from '../entity-worker-system';
import type { WorkerEntityClassRegistry } from '../../entity-class';

interface InitMessage {
	type: 'init'
}

interface UnhandledRejectionMessage {
	type: 'unhandled-rejection'
	error: Error
}

interface InitCompleteMessage {
	type: 'init-complete'
}

// Sent on every (re)load: carries the system's init data and runs updateFunction.init. `sharedMemory` lets a real
// worker reconstruct handles over the world's component pools + eid counter (for off-thread allocation).
interface LoadMessage<D = unknown> extends LoadDeltas {
	type: 'load'
	data?: D
	gameTime: number
	heap?: MemoryHeapMemory
	sharedMemory?: WorldSharedMemory
	// Factory templates by type, shipped only to systems registered with createsEntities, so the worker can merge a
	// type's template when creating an entity from a config.
	factoryConfigs?: { [type: string]: Record<string, unknown> }
	factoryClasses?: WorkerEntityClassRegistry
	addsComponents?: boolean
}

// Membership queued before load. Applied to the persistent lists on load; queryChanged never sees it.
export interface LoadDeltas {
	entities: LoadQueryDelta
	queries: { [key: string]: LoadQueryDelta }
}

// A real worker's load rows arrive here rather than in `added`: a load can carry millions of block views, and
// cloning those is what made seeding workers slow. The worker rebuilds them against its own pools.
export interface LoadQueryDelta<T extends EntityUpdateComponents = EntityUpdateComponents> extends QueryDelta<T> {
	packedAdded?: PackedEntities
}

export interface PackedEntities {
	entityIds: Uint32Array<ArrayBuffer>
	// Parallel to entityIds: each row's block index in that component's pool, -1 for an absent optional.
	components: { [name: string]: Int32Array<ArrayBuffer> }
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

interface RunUpdateMessage<W extends EntityWorkerSystemWorld = EntityWorkerSystemWorld> {
	type: 'run'
	generation: number
	world: W
	entities: QueryDelta
	queries: { [key: string]: QueryDelta }
	workBatch?: EntityWorkBatch
}

export interface EntityWorkBatch {
	entityIds: Array<number>
	first: boolean
	last: boolean
}

// An event a worker asks the main thread to emit on an entity. Structured-cloned, so `args` must be cloneable.
export interface EntityEvent {
	entityId: number
	event: string
	args: Array<unknown>
}

// An error thrown by user code (queryChanged / preRun / a per-entity update / entityRemoved) during a worker run, reported back
// so the main thread logs it and emits `system-error`. Error is structured-cloneable across the worker boundary.
export interface WorkerRunError {
	error: Error
	phase: 'queryChanged' | 'preRun' | 'preBatch' | 'update' | 'entityRemoved'
	entityId?: number
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
	componentChanges: Array<WorkerComponentChange>
	errors: Array<WorkerRunError>
	workFailed?: boolean
}

type EntitySystemWorkerMessage<W extends EntityWorkerSystemWorld = EntityWorkerSystemWorld, D = unknown> =
	InitMessage | InitCompleteMessage | UnhandledRejectionMessage | LoadMessage<D> | LoadedMessage | ResetMessage
	| GrowBufferMessage | GrowBufferFromWorkerMessage | RunUpdateMessage<W> | EntityEventsMessage;
export default EntitySystemWorkerMessage;
