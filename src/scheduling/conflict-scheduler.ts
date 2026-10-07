import type { ComponentMap } from '../component-definition';
import type System from '../systems/system';
import IterableSystem from '../systems/iterable-system';
import type { Scheduler, SchedulerContext, SchedulerEffects, SchedulerUpdateResult } from './scheduler';

export interface ConflictSchedule<C extends ComponentMap = ComponentMap> {
	readonly order: ReadonlyArray<System<C>>
	readonly batches: ReadonlyArray<ReadonlyArray<System<C>>>
}

interface SystemAccess {
	reads: Set<PropertyKey>
	creationReads: Set<PropertyKey>
	creationQueries?: ReadonlyArray<ReadonlyArray<PropertyKey>>
	writes: Set<PropertyKey>
	creates: Set<PropertyKey>
	exclusive: boolean
}

type RunState = 'pending' | 'running' | 'complete';

interface ScheduledUpdate<C extends ComponentMap> {
	system: System<C>
	access: SystemAccess
	elapsedTime: number
	gameTime: number
	state: RunState
	dependencies: number
	dependents: Array<ScheduledUpdate<C>>
	publicationDependencies: number
	publicationDependents: Array<ScheduledUpdate<C>>
	effects?: SchedulerEffects
}

interface ComponentFrontier<C extends ComponentMap> {
	writer?: ScheduledUpdate<C>
	creator?: ScheduledUpdate<C>
	readers: Map<System<C>, ScheduledUpdate<C>>
}

export default class ConflictScheduler<C extends ComponentMap = ComponentMap> implements Scheduler<C> {
	private compiled: ConflictSchedule<C> = Object.freeze({ order: Object.freeze([]), batches: Object.freeze([]) });
	private registeredSystems: Array<System<C>> = [];
	private access = new Map<System<C>, SystemAccess>();
	private nodes = new Set<ScheduledUpdate<C>>();
	private tails = new Map<System<C>, ScheduledUpdate<C>>();
	private frontiers = new Map<PropertyKey, ComponentFrontier<C>>();
	private creators = new Map<SystemAccess, ScheduledUpdate<C>>();
	private creationReaders = new Map<SystemAccess, ScheduledUpdate<C>>();
	private exclusiveTail: ScheduledUpdate<C> | undefined;
	private running = new Map<System<C>, ScheduledUpdate<C>>();
	private ready: Array<ScheduledUpdate<C>> = [];
	private readyIndex = 0;
	private gameTime = 0;
	private pumping = false;
	private resumeQueued = false;
	private continuationTimer: ReturnType<typeof setTimeout> | undefined;
	private generation = 0;
	private publications = new Set<ScheduledUpdate<C>>();
	private publicationReady: Array<ScheduledUpdate<C>> = [];
	private publishing = false;

	get schedule(): ConflictSchedule<C> {
		return this.compiled;
	}

	rebuild(context: SchedulerContext<C>): ConflictSchedule<C> {
		const systems = Array.from(new Set(context.systems));
		const access = systems.map(system => {
			const reads = system.readComponents;
			const queries = system.creationReadQueries;
			return {
				reads: new Set(reads),
				creationReads: new Set(queries === undefined ? system.creationReadComponents : system.reads),
				creationQueries: queries?.map(query => Array.from(query)),
				writes: new Set(system.writes),
				creates: new Set(system.createdComponents),
				exclusive: system.requiresExclusiveScheduling || reads === undefined || system.writes === undefined,
			};
		});
		this.access = new Map(systems.map((system, index) => [system, access[index]]));
		const batches: Array<Array<System<C>>> = [];
		const levels: Array<number> = [];
		for(let i = 0; i < systems.length; i++) {
			let level = 0;
			for(let j = 0; j < i; j++) {
				if(this.conflicts(access[j], access[i])) {
					level = Math.max(level, levels[j] + 1);
				}
			}
			levels.push(level);
			(batches[level] ??= []).push(systems[i]);
		}
		this.registeredSystems = context.systems.slice();
		this.compiled = Object.freeze({
			order: Object.freeze(batches.flat()),
			batches: Object.freeze(batches.map(batch => Object.freeze(batch))),
		});
		return this.compiled;
	}

	systemAdded(context: SchedulerContext<C>): void {
		this.rebuild(context);
	}
	systemRemoved(context: SchedulerContext<C>): void {
		this.rebuild(context);
	}

	update(context: SchedulerContext<C>, elapsedTime: number): SchedulerUpdateResult {
		if(this.pumping) {
			throw new Error('ConflictScheduler does not support reentrant updates');
		}
		this.refreshMembership(context);
		this.gameTime = context.gameTime ?? this.gameTime + elapsedTime;
		for(const system of new Set(context.systems)) {
			this.enqueue(system, this.access.get(system)!, elapsedTime, this.gameTime);
		}
		return this.pump(context, true);
	}

	runCompleted(context: SchedulerContext<C>, system: System<C>): void {
		const node = this.running.get(system);
		if(!node) {
			return;
		}
		this.complete(node);
		if(this.pumping || this.resumeQueued) {
			return;
		}
		this.resumeQueued = true;
		const generation = this.generation;
		// Let the worker settle its completion promise before dispatching another run on that worker.
		queueMicrotask(() => {
			if(generation !== this.generation) {
				return;
			}
			this.resumeQueued = false;
			this.pump(context, false);
		});
	}

	pause(context: SchedulerContext<C>): void {
		this.scheduleContinuation(context);
	}

	private scheduleContinuation(context: SchedulerContext<C>): void {
		if(this.continuationTimer !== undefined || !context.paused || !this.dispatchAllowed(context)
			|| !Array.from(this.running.values()).some(node => this.isSliced(node))) {
			return;
		}
		const generation = this.generation;
		// Yield between slices so draining cannot starve worker replies or lifecycle calls.
		this.continuationTimer = setTimeout(() => {
			if(generation !== this.generation) {
				return;
			}
			this.continuationTimer = undefined;
			if(context.paused) {
				this.pump(context, 'sliced');
			}
		}, 0);
	}

	private isSliced(node: ScheduledUpdate<C>): boolean {
		return node.system instanceof IterableSystem && node.system.remainingInstancesToRun.length > 0;
	}

	reset(): void {
		if(this.continuationTimer !== undefined) {
			clearTimeout(this.continuationTimer);
			this.continuationTimer = undefined;
		}
		const effects = Array.from(this.publications, node => node.effects!);
		this.publications.clear();
		this.publicationReady = [];
		this.nodes.clear();
		this.tails.clear();
		this.frontiers.clear();
		this.creators.clear();
		this.creationReaders.clear();
		this.exclusiveTail = undefined;
		this.running.clear();
		this.ready = [];
		this.readyIndex = 0;
		this.gameTime = 0;
		this.resumeQueued = false;
		this.generation++;
		effects.forEach(effect => effect.discard());
	}

	beforeClear(): void {
		this.reset();
	}

	prepareEffects(context: SchedulerContext<C>, system: System<C>): (effects: SchedulerEffects) => void {
		const node = this.running.get(system);
		const generation = this.generation;
		return effects => {
			if(!node || generation !== this.generation || !this.nodes.has(node)) {
				effects.discard();
				return;
			}
			node.effects = effects;
			this.publications.add(node);
			if(node.publicationDependencies === 0) {
				this.publicationReady.push(node);
			}
			this.publish();
		};
	}

	private publish(): void {
		if(this.publishing) {
			return;
		}
		this.publishing = true;
		const generation = this.generation;
		try {
			while(this.publicationReady.length && generation === this.generation) {
				const node = this.publicationReady.pop()!;
				this.publications.delete(node);
				const effects = node.effects!;
				node.effects = undefined;
				effects.apply();
			}
		} finally {
			this.publishing = false;
		}
	}

	destroy(): void {
		this.reset();
	}

	private refreshMembership(context: SchedulerContext<C>): void {
		if(context.systems.length !== this.registeredSystems.length
			|| context.systems.some((system, i) => system !== this.registeredSystems[i])) {
			this.rebuild(context);
		}
	}

	private pump(context: SchedulerContext<C>, continueRuns: boolean | 'sliced'): SchedulerUpdateResult {
		this.pumping = true;
		let lastSystemError: Error | null = null;
		const generation = this.generation;
		try {
			if(continueRuns) {
				for(const node of Array.from(this.running.values())) {
					if(!node.system.isCurrentlyRunning() || (continueRuns === 'sliced' && !this.isSliced(node))) {
						continue;
					}
					if(!this.prepare(context)) {
						return { lastSystemError };
					}
					const result = this.dispatch(context, node, true);
					lastSystemError = result?.lastSystemError ?? lastSystemError;
					if(!result || generation !== this.generation) {
						return { lastSystemError };
					}
				}
			}
			while(this.readyIndex < this.ready.length && generation === this.generation) {
				if(!this.prepare(context)) {
					break;
				}
				const node = this.ready[this.readyIndex++];
				const result = this.dispatch(context, node, false);
				lastSystemError = result?.lastSystemError ?? lastSystemError;
				if(!result) {
					if(this.nodes.has(node) && node.state === 'pending') {
						this.ready.push(node);
					}
					break;
				}
			}
		} finally {
			this.ready = this.ready.slice(this.readyIndex);
			this.readyIndex = 0;
			this.pumping = false;
			this.scheduleContinuation(context);
		}
		return { lastSystemError };
	}

	private enqueue(system: System<C>, access: SystemAccess, elapsedTime: number, gameTime: number): void {
		const node: ScheduledUpdate<C> = {
			system, access, elapsedTime, gameTime, state: 'pending', dependencies: 0, dependents: [],
			publicationDependencies: 0, publicationDependents: [],
		};
		const dependencies = new Set<ScheduledUpdate<C>>();
		const publicationDependencies = new Set<ScheduledUpdate<C>>();
		const dependOn = (previous: ScheduledUpdate<C> | undefined) => {
			if(previous && previous.state !== 'complete') {
				dependencies.add(previous);
			}
		};
		dependOn(this.tails.get(system));
		dependOn(this.exclusiveTail);
		if(access.exclusive) {
			this.tails.forEach(dependOn);
			this.exclusiveTail = node;
		} else {
			const publishAfter = (previous: ScheduledUpdate<C> | undefined) => {
				if(previous && previous.state !== 'complete') {
					publicationDependencies.add(previous);
				}
			};
			for(const component of access.creates) {
				const frontier = this.frontier(component);
				publishAfter(frontier.writer);
				publishAfter(frontier.creator);
			}
			if(access.creates.size) {
				for(const reader of this.creationReaders.values()) {
					if(this.observesCreation(access, reader.access)) {
						publishAfter(reader);
					}
				}
			}
			for(const component of access.reads) {
				if(!access.writes.has(component)) {
					const frontier = this.frontier(component);
					dependOn(frontier.writer);
					frontier.readers.set(system, node);
				}
			}
			for(const creator of this.creators.values()) {
				if(this.observesCreation(creator.access, access)) {
					dependOn(creator);
				}
			}
			if(access.creationReads.size || access.creationQueries?.length) {
				this.creationReaders.set(access, node);
			}
			for(const component of access.writes) {
				const frontier = this.frontier(component);
				dependOn(frontier.writer);
				dependOn(frontier.creator);
				frontier.readers.forEach(dependOn);
				frontier.readers.clear();
				frontier.writer = node;
			}
			for(const component of access.creates) {
				this.frontier(component).creator = node;
			}
			if(access.creates.size) {
				// Keep distinct creation bounds so an unrelated later creator cannot hide a matching one.
				this.creators.set(access, node);
			}
		}
		for(const dependency of dependencies) {
			dependency.dependents.push(node);
		}
		node.dependencies = dependencies.size;
		for(const dependency of publicationDependencies) {
			dependency.publicationDependents.push(node);
		}
		node.publicationDependencies = publicationDependencies.size;
		this.nodes.add(node);
		this.tails.set(system, node);
		if(!node.dependencies) {
			this.ready.push(node);
		}
	}

	private frontier(component: PropertyKey): ComponentFrontier<C> {
		let frontier = this.frontiers.get(component);
		if(!frontier) {
			frontier = { readers: new Map() };
			this.frontiers.set(component, frontier);
		}
		return frontier;
	}

	private complete(node: ScheduledUpdate<C>): void {
		if(node.state === 'complete') {
			return;
		}
		node.state = 'complete';
		this.nodes.delete(node);
		this.running.delete(node.system);
		if(this.tails.get(node.system) === node) {
			this.tails.delete(node.system);
		}
		if(this.exclusiveTail === node) {
			this.exclusiveTail = undefined;
		}
		if(this.creators.get(node.access) === node) {
			this.creators.delete(node.access);
		}
		if(this.creationReaders.get(node.access) === node) {
			this.creationReaders.delete(node.access);
		}
		for(const component of new Set([...node.access.reads, ...node.access.writes, ...node.access.creates])) {
			const frontier = this.frontiers.get(component);
			if(frontier?.writer === node) {
				frontier.writer = undefined;
			}
			if(frontier?.creator === node) {
				frontier.creator = undefined;
			}
			if(frontier?.readers.get(node.system) === node) {
				frontier.readers.delete(node.system);
			}
			if(frontier && !frontier.writer && !frontier.creator && !frontier.readers.size) {
				this.frontiers.delete(component);
			}
		}
		for(const dependent of node.dependents) {
			if(--dependent.dependencies === 0) {
				this.ready.push(dependent);
			}
		}
		node.dependents.length = 0;
		for(const dependent of node.publicationDependents) {
			dependent.publicationDependencies--;
			if(dependent.publicationDependencies === 0 && dependent.effects) {
				this.publicationReady.push(dependent);
			}
		}
		node.publicationDependents.length = 0;
		this.publish();
	}

	private dispatch(context: SchedulerContext<C>, node: ScheduledUpdate<C>, continuation: boolean): SchedulerUpdateResult | undefined {
		const system = node.system;
		if(!continuation && !context.systems.includes(system)) {
			this.complete(node);
			return {};
		}
		const generation = this.generation;
		let shouldRun = true;
		let ran = false;
		let failed = false;
		let lastSystemError: Error | null = null;
		context.emit(`system-${system.name}-started`);
		if(!this.nodes.has(node) || !this.dispatchAllowed(context)) {
			return undefined;
		}
		try {
			const dispatched = system.withGameTime(node.gameTime, () => {
				shouldRun = continuation || system.shouldRun();
				if(!this.nodes.has(node) || !this.dispatchAllowed(context)) {
					return false;
				}
				if(shouldRun) {
					node.state = 'running';
					this.running.set(system, node);
					ran = system.update(continuation ? 0 : node.elapsedTime);
					if(generation === this.generation && !system.isCurrentlyRunning()) {
						this.complete(node);
					}
				} else {
					this.complete(node);
				}
				return true;
			});
			if(!dispatched) {
				return undefined;
			}
		} catch(e) {
			const error = e as Error;
			console.error(error.message, error);
			failed = true;
			lastSystemError = error;
			if(generation === this.generation) {
				if(system.isCurrentlyRunning()) {
					node.state = 'running';
					this.running.set(system, node);
				} else {
					this.complete(node);
				}
			}
			context.emit('system-error', { system: system.name, error, phase: 'run' });
		}
		context.emit(`system-${system.name}-finished`, { ran, shouldRun, failed });
		return { lastSystemError };
	}

	private prepare(context: SchedulerContext<C>): boolean {
		return this.dispatchAllowed(context) && context.prepareForSystemDispatch?.() !== false;
	}

	private dispatchAllowed(context: SchedulerContext<C>): boolean {
		return context.dispatchAllowed !== false;
	}
	private observesCreation(creator: SystemAccess, reader: SystemAccess): boolean {
		for(const component of reader.creationReads) {
			if(creator.creates.has(component)) {
				return true;
			}
		}
		return reader.creationQueries?.some(query => query.every(component => creator.creates.has(component))) ?? false;
	}

	private conflicts(a: SystemAccess, b: SystemAccess): boolean {
		if(a.exclusive || b.exclusive) {
			return true;
		}
		for(const component of a.writes) {
			if(b.reads.has(component) || b.writes.has(component)) {
				return true;
			}
		}
		for(const component of b.writes) {
			if(a.reads.has(component)) {
				return true;
			}
		}
		for(const component of a.creates) {
			if(b.writes.has(component)) {
				return true;
			}
		}
		return a.creates.size > 0 && this.observesCreation(a, b);
	}
}
