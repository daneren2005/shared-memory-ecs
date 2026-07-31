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
	// Membership changes since the last run rather than the full entity set: the worker keeps its own persistent
	// lists and applies these deltas (see applyQueryDelta), so a steady-state run carries near-empty arrays.
	entities: QueryDelta
	queries: { [key: string]: QueryDelta }
}

// One event a worker asks the main thread to emit on an entity once the run completes.  The whole thing
// crosses the worker boundary by structured clone, so everything in `args` has to be cloneable - a plain
// number, string, or object, never a function or a class instance.
export interface EntityEvent {
	entityId: number
	event: string
	args: Array<unknown>
}

interface EntityEventsMessage {
	type: 'run-complete'
	runTime: number
	events: Array<EntityEvent>
	// Flat configs the worker asked to be created; the main thread fulfills each through world.loadEntity on
	// run-complete.  Kept as plain records so they structured-clone across the worker boundary.
	created: Array<Record<string, unknown>>
}

type ComponentWorkerMessage<W extends ComponentSystemWorld = ComponentSystemWorld> = InitMessage | LoadedMessage | RunUpdateMessage<W> | EntityEventsMessage;
export default ComponentWorkerMessage;
