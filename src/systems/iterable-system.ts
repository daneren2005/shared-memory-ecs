import type BaseWorld from '../world';
import type { ComponentDefinitionMap, ComponentMap } from '../component-definition';
import System, { type SystemConfig } from './system';

// A system that iterates a list of instances, spreading the work across multiple frames if a single
// pass would exceed maxMsPerFrame.
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

			return true;
		} else {
			return super.update(elapsedTime);
		}
	}
	run(elapsedTime: number): void {
		let iterables = this.getIterables();
		this.runIterables(iterables, elapsedTime);
	}
	runIterables(iterables: Array<T>, elapsedTime: number) {
		let started = performance.now();
		this.beforeRunIterables();
		for(let i = 0; i < iterables.length; i++) {
			this.updateIterable(iterables[i], elapsedTime);

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

	abstract getIterables(): Array<T>;
	abstract updateIterable(iterable: T, elapsedTime: number): void;
}

export interface IterableSystemConfig extends SystemConfig {
	iterationsPerCheck?: number
	maxMsPerFrame?: number
}
