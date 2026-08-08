import type { ComponentSystemWorld, QueryDelta } from '../component-system';

interface InitMessage {
	type: 'init'
}

interface InitCompleteMessage {
	type: 'init-complete'
}

// Sent on every (re)load: carries the system's init data and runs updateFunction.init.
interface LoadMessage<D = unknown> {
	type: 'load'
	data?: D
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
	created: Array<Record<string, unknown>>
}

type ComponentWorkerMessage<W extends ComponentSystemWorld = ComponentSystemWorld, D = unknown> =
	InitMessage | InitCompleteMessage | LoadMessage<D> | LoadedMessage | ResetMessage | RunUpdateMessage<W> | EntityEventsMessage;
export default ComponentWorkerMessage;
