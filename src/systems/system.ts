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
	// Called once the world's entities all exist: the point a system hands its startup data off (see EntityWorkerSystem).
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

	// Logs and surfaces an error thrown by user code (an update body, preRun, etc.) on the main thread: a
	// `system-error` event carrying the system name, so a run keeps going past one failure instead of aborting.
	protected onError(error: Error, context: { entityId?: number, phase?: SystemErrorPhase } = {}) {
		const where = context.entityId !== undefined ? ` (entity ${context.entityId})` : '';
		console.error(`Error in system ${this.name}${where}: ${error.message}`, error);
		const payload: SystemError = { system: this.name, error, entityId: context.entityId, phase: context.phase };
		this.world.emit('system-error', payload);
	}

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

// Which part of a run threw, for the `system-error` event.
export type SystemErrorPhase = 'preRun' | 'update' | 'entityRemoved' | 'run' | 'died';
export interface SystemError {
	system: string
	error: Error
	entityId?: number
	phase?: SystemErrorPhase
}
