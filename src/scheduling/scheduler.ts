import type { EventEmitter } from 'eventemitter3';
import type { ComponentMap } from '../component-definition';
import type System from '../systems/system';

export interface SchedulerContext<C extends ComponentMap = ComponentMap> extends Pick<EventEmitter, 'emit'> {
	// Read on each dispatch so direct assignment and live array mutations retain their legacy behavior.
	readonly systems: Array<System<C>>
	readonly gameTime?: number
	readonly paused?: boolean
	readonly dispatchAllowed?: boolean
	// Prepare shared memory for deferred dispatch; false suspends dispatch during teardown.
	prepareForSystemDispatch?(): boolean
}

export interface SchedulerUpdateResult {
	lastSystemError?: Error | null
}

export interface SchedulerEffects {
	apply(): void
	discard(): void
}

export interface Scheduler<C extends ComponentMap = ComponentMap> {
	// elapsedTime is already scaled; returning from dispatch does not imply every run has completed.
	update(context: SchedulerContext<C>, elapsedTime: number): SchedulerUpdateResult
	pause?(context: SchedulerContext<C>): void
	systemAdded?(context: SchedulerContext<C>, system: System<C>): void
	systemRemoved?(context: SchedulerContext<C>, system: System<C>): void
	reset?(context: SchedulerContext<C>): void
	destroy?(context: SchedulerContext<C>): void
	// Effects are applied; this can fire inside update() for synchronous systems and worker fallback.
	runCompleted?(context: SchedulerContext<C>, system: System<C>): void
	// Capture this run before dispatch; the returned handler must eventually apply or discard its effects.
	prepareEffects?(context: SchedulerContext<C>, system: System<C>): (effects: SchedulerEffects) => void
	// Cancel buffered effects before awaiting workers, without dispatching queued updates.
	beforeClear?(context: SchedulerContext<C>): void
}
