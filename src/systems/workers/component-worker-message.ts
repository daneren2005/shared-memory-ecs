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

// A run's system events: for each event the update function named, the ids of the entities it happened to, in
// the order they were reported.  This is the cheap way to report something that happens to a great many
// entities every single run - a move, say - because it is what an EntityEvent has left once the two things
// that make that one expensive are taken away:
//
//   - no args.  The main thread can read whatever the worker wrote straight out of the entity's shared block,
//     so sending it a second time only pays to copy what it already has.
//   - nothing per entity but its id.  One array of numbers per event name structured-clones as a block,
//     where an event object apiece is an allocation apiece on both sides of the boundary.
//
// The main thread emits each of these on the *system* rather than on each entity (see ComponentSystem), so a
// run costs one listener call per event name instead of one per entity.
export type SystemEvents = { [event: string]: Array<number> };

interface EntityEventsMessage {
	type: 'run-complete'
	runTime: number
	events: Array<EntityEvent>
	systemEvents: SystemEvents
	// Flat configs the worker asked to be created; the main thread fulfills each through world.loadEntity on
	// run-complete.  Kept as plain records so they structured-clone across the worker boundary.
	created: Array<Record<string, unknown>>
}

type ComponentWorkerMessage<W extends ComponentSystemWorld = ComponentSystemWorld> = InitMessage | LoadedMessage | RunUpdateMessage<W> | EntityEventsMessage;
export default ComponentWorkerMessage;
