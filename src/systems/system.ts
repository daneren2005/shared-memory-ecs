import { EventEmitter } from 'eventemitter3';
import type BaseWorld from '../world';
import type { ComponentDefinitionMap, ComponentMap } from '../component-definition';

// Base system: runs on an optional fixed timestep (deltaBetweenRuns), driven by BaseWorld#update.
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
				// Carry the remainder so a run that overshoots its timestep doesn't drift the next one later.
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
	firstRun?: boolean
}
