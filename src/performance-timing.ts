import { EventEmitter } from 'eventemitter3';
import type BaseWorld from './world';
import type { ComponentDefinitionMap, ComponentMap } from './component-definition';
import type System from './systems/system';

// How much elapsed time piles up before a new set of stats is worked out.  Matches the millisecond scale most
// games drive `update` with, so the default is one snapshot a second.
export const DEFAULT_TICKS_BETWEEN_UPDATES = 1_000;

// One measurement collapsed over a reporting window.  `samples` is how many measurements went into it, which is
// what tells a system that genuinely cost nothing apart from one that never reported in the first place - a
// plain System (one that isn't a ComponentSystem) never reports, and so sits at zero across the board.
export interface TimingStats {
	avg: number
	min: number
	max: number
	samples: number
}

// One system's cost, split across the two threads it runs on.
export interface SystemTimingStats {
	name: string
	// The run itself, as the thing that ran it measured it: the system's worker, or - for a forceMainThread
	// system, or one on a browser without Workers / SharedArrayBuffer - the main-thread fallback, in which case
	// this is time already counted inside `update` as well.
	run: TimingStats
	// The other half of the bill: what handling that run's results cost the thread the world lives on - the
	// events it reported onto entities, and the entities it asked to be created.
	events: TimingStats
}

// A full snapshot, replaced wholesale once per reporting window.
export interface PerformanceStats {
	// One whole `world.update` call: every system's dispatch plus whatever the main thread does inline.
	update: TimingStats
	systems: Array<SystemTimingStats>
	// Every system's event handling added together.  Workers finish on their own schedule rather than on a frame
	// boundary, so there is no per-frame combined sample to take - a frame carries however many runs happened to
	// land in it.  These are instead the per-system figures summed at the end of the window, so `avg` is what a
	// run of every system costs the main thread between them, and `min` / `max` are the matching best and worst
	// cases.
	events: TimingStats
}

export interface PerformanceTimingOptions {
	// Elapsed time - in whatever unit the world is driven with, so milliseconds for most games - to accumulate
	// before recalculating.  Defaults to DEFAULT_TICKS_BETWEEN_UPDATES.
	ticksBetweenUpdates?: number
}

// The open samples for one system, plus the handlers holding them, kept together so a system can be dropped
// without hunting for its listeners.
interface SystemTiming {
	run: Array<number>
	events: Array<number>
	// When the current run's event dispatch started, or -1 when no run is being dispatched.
	eventStart: number
	onRunFinished: (runTime: number) => void
	onEventsFinished: () => void
}

const EMPTY_TIMING: TimingStats = { avg: 0, min: 0, max: 0, samples: 0 };

// Collapses a window's worth of samples into the numbers that get reported.  An empty window reads as zeroes
// rather than an infinite min, so a snapshot is always safe to render.
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

// Watches a world and reports what it costs to run: how long `world.update` takes on the calling thread, how
// long each system's run takes on its worker, and what handling each of those runs costs back on the calling
// thread.  Nothing is hooked into the hot path - it is all driven off events the world already emits - so a
// game only pays for what it measures, and only while it has one of these alive.
//
// Samples are gathered every frame and collapsed into a fresh `stats` snapshot once `ticksBetweenUpdates` worth
// of elapsed time has gone by, at which point `stats-updated` fires with it.  Frames the world was paused for
// are skipped entirely: the world does no work on them, so counting them would only drag every average down.
export default class PerformanceTiming<C extends ComponentMap = ComponentMap> extends EventEmitter {
	world: BaseWorld<ComponentDefinitionMap, C>;
	ticksBetweenUpdates: number;
	// The most recent snapshot.  Zeroed until the first window elapses, so it can be rendered right away.
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
		// Systems are normally all in place before this is built, but a world can gain or lose one at any point -
		// so follow them rather than taking a one-off copy of the list.
		world.on('system-added', this.onSystemAdded);
		world.on('system-removed', this.onSystemRemoved);
		world.systems.forEach(system => this.trackSystem(system));
	}

	// The stats for a single system by name, or undefined if the world has no such system.
	getSystemStats(name: string): SystemTimingStats | undefined {
		return this.stats.systems.find(system => system.name === name);
	}

	// Throws away everything collected so far, including the current snapshot, and starts a fresh window.  Worth
	// calling after anything that makes the samples either side of it incomparable - loading a new scene, say.
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
		// A paused world only accrues its player clock, so there is nothing here worth measuring.
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

	// The world emits `-worker-finished` immediately before it dispatches a run's events onto entities and
	// `-worker-events-finished` immediately after, so the gap between the two is exactly what that run cost this
	// thread.  Both fire for a system running in the main-thread fallback too - it reports the run it just did
	// inline - so a forceMainThread system is measured the same way as one on a worker.
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
		// Driven off the world's list rather than the map so the snapshot is in the order the systems run, and so
		// a system added part way through a window still gets a (partial) entry.
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
