import { EventEmitter } from 'eventemitter3';
import type BaseWorld from '../world';
import type { ComponentDefinitionMap, ComponentMap } from '../component-definition';

// Base system: runs on an optional fixed timestep (deltaBetweenRuns) and is driven by BaseWorld#update.
// Systems only care about the component map `C`, not the World's registry (`R`) or config (`Cfg`), so they
// reference the World through the widened `ComponentDefinitionMap` and let `Cfg` default.
//
// A system is an EventEmitter so it can report a whole run's worth of something in one go - see
// ComponentSystem's system events, where an update function names an event and the entity ids it happened to
// and the main thread gets one call with the lot rather than one per entity.
export default abstract class System<C extends ComponentMap = ComponentMap> extends EventEmitter {
	world: BaseWorld<ComponentDefinitionMap, C>;
	name: string;
	currentDelta: number = 0;
	deltaBetweenRuns: number;
	firstRun: boolean;

	constructor(world: BaseWorld<ComponentDefinitionMap, C>, options: SystemConfig = { name: 'System' }) {
		super();

		this.name = options.name;
		this.world = world;

		this.deltaBetweenRuns = options.deltaBetweenRuns ?? 0;
		this.firstRun = options.firstRun !== undefined ? options.firstRun : false;
	}

	init(): void | Promise<void> {}

	clear() {
		this.currentDelta = 0;
	}
	finishLoading() {}

	update(elapsedTime: number): boolean {
		this.currentDelta += elapsedTime;

		if(this.currentDelta >= this.deltaBetweenRuns || this.firstRun) {
			let leftOverDelta = 0;
			if(this.deltaBetweenRuns > 0) {
				// Without this if we take 100ms to run (ie: IterableSystem across multiple frames) then we will end up
				// actually running this in 300ms total instead of again in 100ms for a total of 200ms
				// With firstRun this ends up calling run(0) the first time - this makes it so things like events are
				// will trigger on the second instead of triggering a 1 second timer at 1.0166 seconds
				leftOverDelta = this.currentDelta % this.deltaBetweenRuns;
			}

			this.run(this.currentDelta - leftOverDelta);
			this.currentDelta = leftOverDelta;
			this.firstRun = false;

			return true;
		} else {
			return false;
		}
	}
	abstract run(elapsedTime: number): void;

	shouldRun(): boolean {
		return true;
	}

	destroy() {
		this.removeAllListeners();
	}
}

export interface SystemConfig {
	name: string
	deltaBetweenRuns?: number
	// Defaults to false
	firstRun?: boolean
}
