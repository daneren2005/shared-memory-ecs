import type { ComponentSystemWorld, UpdateEntityConfig } from '../component-system';

interface InitMessage {
	type: 'init'
}

interface LoadedMessage {
	type: 'loaded'
}

interface RunUpdateMessage<W extends ComponentSystemWorld = ComponentSystemWorld> {
	type: 'run'
	world: W
	entities: Array<UpdateEntityConfig>
	queries: { [key: string]: Array<UpdateEntityConfig> }
	removed: Array<number>
}

interface EntityEventsMessage {
	type: 'run-complete'
	runTime: number
	events: Array<{ entityId: number, event: string, args: Array<any> }>
	// Flat configs the worker asked to be created; the main thread fulfills each through world.loadEntity on
	// run-complete.  Kept as plain records so they structured-clone across the worker boundary.
	created: Array<Record<string, unknown>>
}

type ComponentWorkerMessage<W extends ComponentSystemWorld = ComponentSystemWorld> = InitMessage | LoadedMessage | RunUpdateMessage<W> | EntityEventsMessage;
export default ComponentWorkerMessage;
