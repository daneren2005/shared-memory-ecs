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
	// Called once the world's entities all exist: the point a system hands its startup data off (see ComponentSystem).
	finishLoading(): void | Promise<void> {}

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
			this.onRunFinished();

			return true;
		} else {
			return false;
		}
	}
	abstract run(elapsedTime: number): void;

	// Marks one run as fully applied. Synchronous systems finish inside update(); subclasses whose work is
	// deferred (spread across frames, or off-thread) override this and call it at their real completion point.
	protected onRunFinished() {
		this.world.notifySystemRunCompleted(this);
	}
	// True while a run is still in progress between update() calls (a worker round-trip, or an iteration spread
	// across frames). Used by the world to keep waiting on a system that is mid-run over memory it may free.
	isCurrentlyRunning(): boolean {
		return false;
	}
	// Resolves once any in-flight run has finished, so the world's clear() knows nothing is still reading memory
	waitForRunToComplete(): void | Promise<void> {}

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
