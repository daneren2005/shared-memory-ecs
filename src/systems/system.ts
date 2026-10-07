import { EventEmitter } from 'eventemitter3';
import type BaseWorld from '../world';
import type BaseEntity from '../entity';
import type { ComponentDefinitionMap, ComponentMap } from '../component-definition';

// Base system: runs on an optional fixed timestep (deltaBetweenRuns), driven by BaseWorld#update.
export default abstract class System<C extends ComponentMap = ComponentMap> extends EventEmitter {
	world: BaseWorld<ComponentDefinitionMap, C>;
	name: string;
	currentDelta: number = 0;
	deltaBetweenRuns: number;
	firstRun: boolean;
	readonly reads?: ReadonlyArray<PropertyKey>;
	readonly writes?: ReadonlyArray<PropertyKey>;
	private readonly exclusive: boolean;
	private scheduledGameTime: number | undefined;

	constructor(world: BaseWorld<ComponentDefinitionMap, C>, options: SystemConfig<C> = { name: 'System' }) {
		super();

		this.name = options.name;
		this.world = world;
		this.reads = options.reads;
		this.writes = options.writes;
		this.exclusive = options.exclusive ?? false;

		this.deltaBetweenRuns = options.deltaBetweenRuns ?? 0;
		this.firstRun = options.firstRun !== undefined ? options.firstRun : false;
	}

	init(): void | Promise<void> {}

	clear() {
		this.currentDelta = 0;
	}
	// Called once the world's entities all exist: the point a system hands its startup data off (see EntityWorkerSystem).
	finishLoading(): void | Promise<void> {}
	// world.load() joins its whole batch here instead of one entity-added at a time.
	addEntities(batch: EntityBatch<C>): void {}

	get gameTime(): number {
		return this.scheduledGameTime ?? this.world.gameTime;
	}
	withGameTime<T>(gameTime: number, update: () => T): T {
		const previous = this.scheduledGameTime;
		this.scheduledGameTime = gameTime;
		try {
			return update();
		} finally {
			this.scheduledGameTime = previous;
		}
	}
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
	get readComponents(): ReadonlyArray<PropertyKey> | undefined {
		return this.reads;
	}
	get requiresExclusiveScheduling(): boolean {
		return this.exclusive;
	}
	get createdComponents(): ReadonlyArray<PropertyKey> {
		return [];
	}
	get creationReadComponents(): ReadonlyArray<PropertyKey> | undefined {
		return this.readComponents;
	}
	get creationReadQueries(): ReadonlyArray<ReadonlyArray<PropertyKey>> | undefined {
		return undefined;
	}

	destroy() {
		this.removeAllListeners();
	}
}

// A load batch in load order. Entities with identical component keys share a group, so a query's component test is
// answered once per group rather than once per entity.
export interface EntityBatch<C extends ComponentMap = ComponentMap> {
	entities: Array<BaseEntity<C>>
	// Per entity, its index into `groups`.
	groupIndexes: Array<number>
	// One representative entity per distinct component-key set.
	groups: Array<BaseEntity<C>>
}

// Visits, in load order, each entity whose group passes `matchesGroup`.
export function forEachInMatchingGroups<C extends ComponentMap>(batch: EntityBatch<C>, matchesGroup: (representative: BaseEntity<C>) => boolean, callback: (entity: BaseEntity<C>) => void) {
	const matches = batch.groups.map(matchesGroup);
	for(let i = 0; i < batch.entities.length; i++) {
		if(matches[batch.groupIndexes[i]]) {
			callback(batch.entities[i]);
		}
	}
}

export interface SystemConfig<C extends ComponentMap = ComponentMap> {
	name: string
	deltaBetweenRuns?: number
	firstRun?: boolean
	reads?: ReadonlyArray<keyof C>
	writes?: ReadonlyArray<keyof C>
	exclusive?: boolean
}

// Which part of a run threw, for the `system-error` event.
export type SystemErrorPhase = 'queryChanged' | 'preRun' | 'update' | 'entityRemoved' | 'run' | 'died';
export interface SystemError {
	system: string
	error: Error
	entityId?: number
	phase?: SystemErrorPhase
}
