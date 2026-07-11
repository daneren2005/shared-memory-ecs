import type { ComponentSystemWorld, UpdateEntityConfig } from '../component-system';

interface InitMessage {
	type: 'init'
}

interface LoadedMessage {
	type: 'loaded'
}

interface RunUpdateMessage {
	type: 'run'
	world: ComponentSystemWorld
	entities: Array<UpdateEntityConfig>
	queries: { [key: string]: Array<UpdateEntityConfig> }
	removed: Array<number>
}

interface EntityEventsMessage {
	type: 'run-complete'
	runTime: number
	events: Array<{ entityId: number, event: string, args: Array<any> }>
}

type ComponentWorkerMessage = InitMessage | LoadedMessage | RunUpdateMessage | EntityEventsMessage;
export default ComponentWorkerMessage;
