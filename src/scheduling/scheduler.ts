import type { EventEmitter } from 'eventemitter3';
import type { ComponentMap } from '../component-definition';
import type System from '../systems/system';

export interface SchedulerContext<C extends ComponentMap = ComponentMap> extends Pick<EventEmitter, 'emit'> {
	// Read on each dispatch so direct assignment and live array mutations retain their legacy behavior.
	readonly systems: Array<System<C>>
}

export interface SchedulerUpdateResult {
	lastSystemError?: Error | null
}

export interface Scheduler<C extends ComponentMap = ComponentMap> {
	// elapsedTime is already scaled; returning from dispatch does not imply every run has completed.
	update(context: SchedulerContext<C>, elapsedTime: number): SchedulerUpdateResult
	systemAdded?(context: SchedulerContext<C>, system: System<C>): void
	systemRemoved?(context: SchedulerContext<C>, system: System<C>): void
	reset?(context: SchedulerContext<C>): void
	destroy?(context: SchedulerContext<C>): void
	// Effects are applied; this can fire inside update() for synchronous systems and worker fallback.
	runCompleted?(context: SchedulerContext<C>, system: System<C>): void
}
