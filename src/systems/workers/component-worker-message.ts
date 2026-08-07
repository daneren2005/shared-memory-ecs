import type { ComponentSystemWorld, QueryDelta } from '../component-system';

interface InitMessage {
	type: 'init'
}

interface LoadedMessage {
	type: 'loaded'
}

interface RunUpdateMessage<W extends ComponentSystemWorld = ComponentSystemWorld> {
	type: 'run'
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
	runTime: number
	events: Array<EntityEvent>
	systemEvents: SystemEvents
	created: Array<Record<string, unknown>>
}

type ComponentWorkerMessage<W extends ComponentSystemWorld = ComponentSystemWorld> = InitMessage | LoadedMessage | RunUpdateMessage<W> | EntityEventsMessage;
export default ComponentWorkerMessage;
