import type { ComponentMap } from '../component-definition';
import type { Scheduler, SchedulerContext, SchedulerUpdateResult } from './scheduler';

export default class DefaultScheduler<C extends ComponentMap = ComponentMap> implements Scheduler<C> {
	update(context: SchedulerContext<C>, elapsedTime: number): SchedulerUpdateResult {
		let lastSystemError: Error | null = null;
		context.systems.forEach(system => {
			let shouldRun = true;
			let ran = false;
			let failed = false;
			context.emit(`system-${system.name}-started`);
			try {
				shouldRun = system.shouldRun();
				if(shouldRun) {
					ran = system.update(elapsedTime);
				}
			} catch(e) {
				const error = e as Error;
				console.error(error.message, error);
				failed = true;
				lastSystemError = error;
				context.emit('system-error', { system: system.name, error, phase: 'run' });
			}
			context.emit(`system-${system.name}-finished`, {
				ran,
				shouldRun,
				failed,
			});
		});

		return { lastSystemError };
	}
}
