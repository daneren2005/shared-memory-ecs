import type BaseWorld from '../world';
import type { ComponentDefinitionMap, ComponentMap } from '../component-definition';
import System, { type SystemConfig } from './system';

export default abstract class IterableSystem<C extends ComponentMap, T> extends System<C> {
	remainingInstancesToRun: Array<T> = [];
	remainingInstancesStartTime: number | null = null;
	iterationsPerCheck: number;
	maxMsPerFrame: number;

	constructor(world: BaseWorld<ComponentDefinitionMap, C>, options: IterableSystemConfig) {
		super(world, options);

		this.iterationsPerCheck = options.iterationsPerCheck ?? 1;
		this.maxMsPerFrame = options.maxMsPerFrame ?? 10;
	}

	clear() {
		super.clear();

		this.remainingInstancesToRun = [];
		this.remainingInstancesStartTime = null;
	}

	update(elapsedTime: number): boolean {
		if(this.remainingInstancesToRun.length) {
			this.runIterables(this.remainingInstancesToRun, this.remainingInstancesStartTime ?? 0);
			this.currentDelta += elapsedTime;
			if(!this.remainingInstancesToRun.length) {
				this.onRunFinished();
			}

			return true;
		} else {
			return super.update(elapsedTime);
		}
	}
	run(elapsedTime: number): void {
		let iterables = this.getIterables();
		this.runIterables(iterables, elapsedTime);
	}
	// A run that overflowed onto a later frame isn't finished yet; only count it once the queue drains (handled
	// by update() when it empties remainingInstancesToRun).
	protected onRunFinished() {
		if(this.remainingInstancesToRun.length) {
			return;
		}

		super.onRunFinished();
	}
	isCurrentlyRunning(): boolean {
		return this.remainingInstancesToRun.length > 0;
	}

	runIterables(iterables: Array<T>, elapsedTime: number) {
		let started = performance.now();
		try {
			this.beforeRunIterables();
		} catch(e) {
			// preRun failed: skip the iteration this frame rather than run over half-prepared state.
			this.onError(e as Error, { phase: 'preRun' });
			this.remainingInstancesToRun = [];
			this.remainingInstancesStartTime = null;
			return;
		}
		for(let i = 0; i < iterables.length; i++) {
			try {
				this.updateIterable(iterables[i], elapsedTime);
			} catch(e) {
				// One iterable failing must not stop the rest of the run.
				this.onError(e as Error, { phase: 'update', entityId: this.getIterableEntityId(iterables[i]) });
			}

			if(i % this.iterationsPerCheck === 0) {
				let now = performance.now();
				if(now - started >= this.maxMsPerFrame) {
					this.remainingInstancesToRun = iterables.slice(i + 1);
					this.remainingInstancesStartTime = elapsedTime;
					return;
				}
			}
		}

		this.remainingInstancesToRun = [];
		this.remainingInstancesStartTime = null;
	}
	beforeRunIterables() {}
	// Best-effort eid for a failed iterable, so `system-error` can name it. Subclasses whose T carries an eid override.
	protected getIterableEntityId(_iterable: T): number | undefined {
		return undefined;
	}

	abstract getIterables(): Array<T>;
	abstract updateIterable(iterable: T, elapsedTime: number): void;
}

export interface IterableSystemConfig extends SystemConfig {
	iterationsPerCheck?: number
	maxMsPerFrame?: number
}
