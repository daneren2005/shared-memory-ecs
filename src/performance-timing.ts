import { EventEmitter } from 'eventemitter3';
import type BaseWorld from './world';
import type { ComponentDefinitionMap, ComponentMap } from './component-definition';
import type System from './systems/system';

export const DEFAULT_TICKS_BETWEEN_UPDATES = 1_000;

export interface TimingStats {
	avg: number
	min: number
	max: number
	samples: number
}

export interface SystemTimingStats {
	name: string
	run: TimingStats
	events: TimingStats
}

export interface PerformanceStats {
	update: TimingStats
	systems: Array<SystemTimingStats>
	events: TimingStats
}

export interface PerformanceTimingOptions {
	ticksBetweenUpdates?: number
}

interface SystemTiming {
	run: Array<number>
	events: Array<number>
	// -1 when no run is being dispatched.
	eventStart: number
	onRunFinished: (runTime: number) => void
	onEventsFinished: () => void
}

const EMPTY_TIMING: TimingStats = { avg: 0, min: 0, max: 0, samples: 0 };

// An empty window reads as zeroes (not an infinite min) so a snapshot is always safe to render.
function summarize(samples: Array<number>): TimingStats {
	if(!samples.length) {
		return { ...EMPTY_TIMING };
	}

	let total = 0;
	let min = Infinity;
	let max = 0;
	for(let sample of samples) {
		total += sample;
		if(sample < min) {
			min = sample;
		}
		if(sample > max) {
			max = sample;
		}
	}

	return {
		avg: total / samples.length,
		min,
		max,
		samples: samples.length,
	};
}

// Watches a world and reports what it costs to run, driven off events the world emits. Emits `stats-updated`
// every `ticksBetweenUpdates`; paused frames are skipped.
export default class PerformanceTiming<C extends ComponentMap = ComponentMap> extends EventEmitter {
	world: BaseWorld<ComponentDefinitionMap, C>;
	ticksBetweenUpdates: number;
	stats: PerformanceStats = {
		update: { ...EMPTY_TIMING },
		systems: [],
		events: { ...EMPTY_TIMING },
	};

	private ticks = 0;
	private updateStart = 0;
	private updateTimes: Array<number> = [];
	private systemTimings = new Map<string, SystemTiming>();
	private destroyed = false;

	constructor(world: BaseWorld<ComponentDefinitionMap, C>, options: PerformanceTimingOptions = {}) {
		super();

		this.world = world;
		this.ticksBetweenUpdates = options.ticksBetweenUpdates ?? DEFAULT_TICKS_BETWEEN_UPDATES;

		world.on('update-started', this.onUpdateStarted);
		world.on('update-finished', this.onUpdateFinished);
		world.on('system-added', this.onSystemAdded);
		world.on('system-removed', this.onSystemRemoved);
		world.systems.forEach(system => this.trackSystem(system));
	}

	getSystemStats(name: string): SystemTimingStats | undefined {
		return this.stats.systems.find(system => system.name === name);
	}

	reset() {
		this.ticks = 0;
		this.updateTimes = [];
		this.systemTimings.forEach(timing => {
			timing.run = [];
			timing.events = [];
			timing.eventStart = -1;
		});
		this.stats = {
			update: { ...EMPTY_TIMING },
			systems: [],
			events: { ...EMPTY_TIMING },
		};
	}

	destroy() {
		if(this.destroyed) {
			return;
		}
		this.destroyed = true;

		this.world.off('update-started', this.onUpdateStarted);
		this.world.off('update-finished', this.onUpdateFinished);
		this.world.off('system-added', this.onSystemAdded);
		this.world.off('system-removed', this.onSystemRemoved);
		Array.from(this.systemTimings.keys()).forEach(name => this.untrackSystem(name));
		this.removeAllListeners();
	}

	private onUpdateStarted = () => {
		this.updateStart = performance.now();
	};

	private onUpdateFinished = (elapsedTime: number) => {
		if(this.world.paused) {
			return;
		}

		this.updateTimes.push(performance.now() - this.updateStart);

		this.ticks += elapsedTime;
		if(this.ticks >= this.ticksBetweenUpdates) {
			this.recalculate();
		}
	};

	private onSystemAdded = (system: System<C>) => {
		this.trackSystem(system);
	};

	private onSystemRemoved = (system: System<C>) => {
		this.untrackSystem(system.name);
	};

	// The gap between `-worker-finished` (before events dispatch) and `-worker-events-finished` (after) is what
	// that run cost this thread. Both fire for the main-thread fallback too.
	private trackSystem(system: System<C>) {
		if(this.systemTimings.has(system.name)) {
			return;
		}

		const timing: SystemTiming = {
			run: [],
			events: [],
			eventStart: -1,
			onRunFinished: (runTime: number) => {
				timing.run.push(runTime);
				timing.eventStart = performance.now();
			},
			onEventsFinished: () => {
				if(timing.eventStart < 0) {
					return;
				}

				timing.events.push(performance.now() - timing.eventStart);
				timing.eventStart = -1;
			},
		};

		this.world.on(`system-${system.name}-worker-finished`, timing.onRunFinished);
		this.world.on(`system-${system.name}-worker-events-finished`, timing.onEventsFinished);
		this.systemTimings.set(system.name, timing);
	}

	private untrackSystem(name: string) {
		const timing = this.systemTimings.get(name);
		if(!timing) {
			return;
		}

		this.world.off(`system-${name}-worker-finished`, timing.onRunFinished);
		this.world.off(`system-${name}-worker-events-finished`, timing.onEventsFinished);
		this.systemTimings.delete(name);
	}

	private recalculate() {
		const systems = this.world.systems.map(system => {
			const timing = this.systemTimings.get(system.name);
			return {
				name: system.name,
				run: summarize(timing?.run ?? []),
				events: summarize(timing?.events ?? []),
			};
		});

		const events: TimingStats = { ...EMPTY_TIMING };
		systems.forEach(system => {
			events.avg += system.events.avg;
			events.min += system.events.min;
			events.max += system.events.max;
			events.samples += system.events.samples;
		});

		this.stats = {
			update: summarize(this.updateTimes),
			systems,
			events,
		};

		this.ticks = 0;
		this.updateTimes = [];
		this.systemTimings.forEach(timing => {
			timing.run = [];
			timing.events = [];
		});

		this.emit('stats-updated', this.stats);
	}
}
