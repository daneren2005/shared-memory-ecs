import { BaseWorld, ConflictScheduler, EntitySystem, EntityWorkerSystem, IterableSystem, System, WorkerSystem } from '../../index';
import type { BaseEntity, EntityWorkerSystemQuery, EntityWorkerSystemConfig, Scheduler, SystemConfig, WorkerCreatedEntity } from '../../index';
import { registry, type Components, type TestWorld } from '../../__tests__/fixtures/components';
import NodeWorkerAdapter from '../../__tests__/fixtures/node-worker-adapter';

const CREATOR_URL = new URL('../../__tests__/fixtures/controlled-creator-node-worker.mjs', import.meta.url);

class Reader extends System<Components> {
	busy = false;
	runs = 0;
	seen: Array<number> = [];

	constructor(world: TestWorld, options: SystemConfig<Components>, private readonly deferred = false) {
		super(world, options);
	}
	run(): void {
		this.runs++;
		this.seen.push(this.world.entities.size);
		this.busy = this.deferred;
	}
	isCurrentlyRunning(): boolean {
		return this.busy;
	}
	update(delta: number): boolean {
		return this.busy ? false : super.update(delta);
	}
	protected onRunFinished(): void {
		if(!this.busy) {
			super.onRunFinished();
		}
	}
	complete(): void {
		this.busy = false;
		super.onRunFinished();
	}
}

function createWorld(): TestWorld {
	return new BaseWorld(registry, { scheduler: new ConflictScheduler<Components>(), heapSize: 4 * 1024 * 1024 });
}

function fallbackCreator(world: TestWorld, name = 'Creator', createsEntities: EntityWorkerSystemConfig<Components, {}>['createsEntities'] = ['health'], reads: ReadonlyArray<keyof Components> = []) {
	const descriptors: Array<WorkerCreatedEntity> = [];
	const system = world.addSystem(new WorkerSystem<Components>(world, {
		name, reads, writes: [], createsEntities, forceMainThread: true,
		updateFunction: (workerWorld, queries, callbacks) => {
			const descriptor = workerWorld.buildEntityDescriptor!({ type: 'spawn', maxHealth: 25 });
			descriptors.push(descriptor);
			callbacks.createEntity(descriptor);
		},
		getWorker: () => {
			throw new Error('fallback');
		},
	}));
	return { system, descriptors };
}

function threadedCreator(world: TestWorld, name: string, count = 1, value = 10, queries?: EntityWorkerSystemConfig<Components, {}>['queries']) {
	const control = new Int32Array(new SharedArrayBuffer(12));
	const system = world.addSystem(new WorkerSystem<Components>(world, {
		name, writes: [], createsEntities: ['health'], queries, updateFunction: () => {},
		getInitData: () => ({ control, count, value }),
		getWorker: () => new NodeWorkerAdapter(CREATOR_URL) as unknown as Worker,
	}));
	return { system, control };
}


class HeldCreator extends Reader {
	private finishEffects: ReturnType<NonNullable<Scheduler<Components>['prepareEffects']>> | undefined;
	constructor(world: TestWorld, name: string, private readonly components: ReadonlyArray<keyof Components>) {
		super(world, { name, reads: [], writes: [] }, true);
	}
	get createdComponents(): ReadonlyArray<PropertyKey> {
		return ['entity', ...this.components];
	}
	run(): void {
		super.run();
		this.finishEffects = this.world.scheduler.prepareEffects?.(this.world, this);
	}
	publish(): void {
		this.finishEffects?.({ apply: () => this.complete(), discard: () => {
			this.busy = false;
		} });
	}
}

function queryReader(world: TestWorld, query: EntityWorkerSystemConfig<Components, {}>['queries'], reads: ReadonlyArray<keyof Components> = [], writes: ReadonlyArray<keyof Components> = []) {
	const seen: Array<Array<number>> = [];
	const system = world.addSystem(new WorkerSystem<Components>(world, {
		name: 'QueryReader', queries: query, reads, writes, forceMainThread: true,
		updateFunction: (_workerWorld, queries) => seen.push((queries.selected ?? []).map(entity => entity.entityId)),
		getWorker: () => {
			throw new Error('fallback');
		},
	}));
	return { system, seen };
}

async function started(control: Int32Array): Promise<void> {
	await Atomics.waitAsync(control, 0, 0, 2000).value;
	expect(Atomics.load(control, 0)).toBe(1);
}

function release(control: Int32Array): void {
	Atomics.store(control, 1, 1);
	Atomics.notify(control, 1);
}

describe('conflict scheduler entity creation', () => {
	it('runs creators on two OS threads against the same pool and publishes in scheduling order', async () => {
		const world = createWorld();
		const first = threadedCreator(world, 'First', 250, 11);
		const second = threadedCreator(world, 'Second', 250, 22);
		const reader = world.addSystem(new Reader(world, { name: 'Reader', reads: ['health'], writes: [] }));
		const adopted: Array<number> = [];
		world.on('entity-added', entity => adopted.push(entity.components.health.health));
		try {
			await Promise.all([first.system.init(), second.system.init()]);
			await Promise.all([first.system.finishLoading(), second.system.finishLoading()]);
			world.update(16);
			await Promise.all([started(first.control), started(second.control)]);
			expect(world.entities.size).toBe(0);
			expect(world.registry.health.memoryComponent.length).toBe(500);
			expect(reader.runs).toBe(0);
			const firstCompletion = first.system.waitForRunToComplete();
			const secondCompletion = second.system.waitForRunToComplete();
			const received = vi.fn<() => void>();
			world.on('system-Second-worker-finished', received);
			release(second.control);
			await vi.waitFor(() => expect(received).toHaveBeenCalledOnce());
			expect(world.entities.size).toBe(0);
			expect(second.system.isCurrentlyRunning()).toBe(true);
			release(first.control);
			await Promise.all([firstCompletion, secondCompletion]);
			await Promise.resolve();
			expect(adopted).toEqual([...Array<number>(250).fill(11), ...Array<number>(250).fill(22)]);
			expect(reader.seen).toEqual([500]);
			expect(new Set(world.entities.keys()).size).toBe(500);
			expect(new Set(Array.from(world.entities.values(), entity => entity.components.health?.index)).size).toBe(500);
			expect(world.getEntityByEid(Atomics.load(first.control, 2))?.components.health?.health).toBe(11);
			expect(world.getEntityByEid(Atomics.load(second.control, 2))?.components.health?.health).toBe(22);
		} finally {
			release(first.control);
			release(second.control);
			world.destroy();
		}
	});

	it('prepares creations beside an earlier reader and holds both publication and later readers', async () => {
		const world = createWorld();
		const earlier = world.addSystem(new Reader(world, { name: 'Earlier', reads: ['health'], writes: [] }, true));
		const creator = fallbackCreator(world);
		const later = world.addSystem(new Reader(world, { name: 'Later', reads: ['health'], writes: [] }));
		world.update(16);
		expect(creator.descriptors).toHaveLength(1);
		expect(world.entities.size).toBe(0);
		expect(later.runs).toBe(0);
		let settled = false;
		const completion = Promise.resolve(creator.system.waitForRunToComplete()).then(() => {
			settled = true;
			return undefined;
		});
		await Promise.resolve();
		expect(settled).toBe(false);
		earlier.complete();
		await completion;
		await Promise.resolve();
		expect(later.seen).toEqual([1]);
		expect(world.getEntityByEid(creator.descriptors[0].eid)).toBeDefined();
		world.destroy();
	});

	it('drains a paused sliced reader before publishing buffered creations and dispatching later readers', async () => {
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
		const world = createWorld();
		const seen: Array<number> = [];
		const earlier = world.addSystem(new (class extends IterableSystem<Components, number> {
			constructor() {
				super(world, { name: 'Earlier', reads: ['health'], writes: [], maxMsPerFrame: -1 });
			}
			getIterables(): Array<number> {
				return [1, 2, 3];
			}
			updateIterable(): void {
				seen.push(world.entities.size);
			}
		})());
		const creator = fallbackCreator(world);
		const later = world.addSystem(new Reader(world, { name: 'Later', reads: ['health'], writes: [] }));
		try {
			world.update(16);
			expect(creator.descriptors).toHaveLength(1);
			expect(world.entities.size).toBe(0);
			let settled = false;
			const completion = Promise.resolve(creator.system.waitForRunToComplete()).then(() => {
				settled = true;
				return undefined;
			});
			await Promise.resolve();
			expect(settled).toBe(false);
			world.pause();
			await vi.runAllTimersAsync();
			await completion;
			expect(seen).toEqual([0, 0, 0]);
			expect(earlier.isCurrentlyRunning()).toBe(false);
			expect(creator.system.isCurrentlyRunning()).toBe(false);
			expect(later.seen).toEqual([1]);
			expect(world.getEntityByEid(creator.descriptors[0].eid)).toBeDefined();
			expect(world.gameTime).toBe(16);
			expect(world.playerTime).toBe(16);
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			world.destroy();
			vi.useRealTimers();
		}
	});

	it('keeps a creator that reads the created component behind previous publication', async () => {
		const world = createWorld();
		const earlier = world.addSystem(new Reader(world, { name: 'Earlier', reads: ['health'], writes: [] }, true));
		const first = fallbackCreator(world, 'First');
		const second = fallbackCreator(world, 'Second', ['health'], ['health']);
		world.update(16);
		expect(first.descriptors).toHaveLength(1);
		expect(second.descriptors).toHaveLength(0);
		earlier.complete();
		await Promise.resolve();
		expect(second.descriptors).toHaveLength(1);
		expect(world.entities.size).toBe(2);
		world.destroy();
	});

	it('keeps automatic dead-flag reads from blocking unrelated queries, but orders all-entity queries', async () => {
		const world = createWorld();
		const blocker = world.addSystem(new Reader(world, { name: 'Blocker', reads: ['health'], writes: [] }, true));
		fallbackCreator(world);
		world.loadEntity({ speed: 2 });
		const unrelated = world.addSystem(new (class extends EntityWorkerSystem<Components, { movement: Float32Array }> {})(world, {
			name: 'Unrelated', required: ['movement', 'entity'], writes: [], forceMainThread: true,
			updateFunction: vi.fn<() => void>(), getWorker: () => {
				throw new Error('fallback');
			},
		}));
		const all = world.addSystem(new (class extends EntityWorkerSystem<Components, {}> {})(world, {
			name: 'All', required: [], writes: [], forceMainThread: true,
			updateFunction: vi.fn<() => void>(), getWorker: () => {
				throw new Error('fallback');
			},
		}));
		world.update(16);
		expect(unrelated.options.updateFunction).toHaveBeenCalledOnce();
		expect(all.options.updateFunction).not.toHaveBeenCalled();
		blocker.complete();
		await Promise.resolve();
		expect(all.options.updateFunction).toHaveBeenCalledTimes(2);
		world.destroy();
	});

	it('skips unrelated optional and excluded queries but still orders unrestricted main-thread membership', async () => {
		const world = createWorld();
		world.loadEntity({ speed: 1 });
		const earlier = world.addSystem(new Reader(world, { name: 'Earlier', reads: ['health'], writes: [] }, true));
		fallbackCreator(world);
		const calls: Array<string> = [];
		for(const [name, query] of [
			['Optional', { required: ['movement'], optional: ['health'] }],
			['Excluded', { required: ['movement'], not: ['health'] }],
		] satisfies Array<[string, { required: Array<keyof Components>, optional?: Array<keyof Components>, not?: Array<keyof Components> }]>) {
			world.addSystem(new (class extends EntityWorkerSystem<Components, {}> {})(world, {
				name, ...query, writes: [], forceMainThread: true,
				updateFunction: () => {
					calls.push(name);
				},
				getWorker: () => {
					throw new Error('fallback');
				},
			}));
		}
		world.addSystem(new (class extends EntitySystem<Components> {
			updateEntity(): void {
				calls.push('Main');
			}
		})(world, { name: 'Main', components: [], writes: [] }));
		world.update(16);
		expect(calls).toEqual(['Optional', 'Excluded']);
		earlier.complete();
		await Promise.resolve();
		expect(calls).toEqual(['Optional', 'Excluded', 'Main', 'Main']);
		world.destroy();
	});

	it.each(['main', 'named', 'entity'] as const)('allows a %s query to run before a creator missing one of its requirements publishes', async kind => {
		const world = createWorld();
		const existing = world.loadEntity({ maxHealth: 10, speed: 1 });
		const blocker = world.addSystem(new Reader(world, { name: 'Blocker', reads: ['health'], writes: [] }, true));
		const creator = fallbackCreator(world);
		const seen: Array<number> = [];
		if(kind === 'main') {
			world.addSystem(new (class extends EntityWorkerSystem<Components, {}> {})(world, {
				name: 'QueryReader', required: ['health', 'movement'], optional: ['neighbors'], not: ['neighbors'], writes: [], forceMainThread: true,
				updateFunction: (_workerWorld, eid) => seen.push(eid),
				getWorker: () => {
					throw new Error('fallback');
				},
			}));
		} else if(kind === 'named') {
			world.addSystem(new WorkerSystem<Components>(world, {
				name: 'QueryReader', queries: { selected: { required: ['health', 'movement'], optional: ['neighbors'], not: ['neighbors'] } }, writes: [], forceMainThread: true,
				updateFunction: (_workerWorld, queries) => seen.push(...queries.selected.map(entity => entity.entityId)),
				getWorker: () => {
					throw new Error('fallback');
				},
			}));
		} else {
			world.addSystem(new (class extends EntitySystem<Components> {
				updateEntity(entity: BaseEntity<Components>): void {
					seen.push(entity.eid);
				}
			})(world, { name: 'QueryReader', components: ['health', 'movement'], writes: [] }));
		}
		try {
			world.update(16);
			expect(creator.descriptors).toHaveLength(1);
			expect(world.entities.size).toBe(1);
			expect(seen).toEqual([existing.eid]);
			const scheduler = world.scheduler as ConflictScheduler<Components>;
			expect(scheduler.schedule.batches[0].map(system => system.name)).toContain('QueryReader');
			blocker.complete();
			await creator.system.waitForRunToComplete();
			expect(world.entities.size).toBe(2);
			expect(seen).toEqual([existing.eid]);
		} finally {
			world.destroy();
		}
	});

	it('lets two real creators run together when a shared query requires a component neither can create', async () => {
		const world = createWorld();
		const first = threadedCreator(world, 'First');
		const second = threadedCreator(world, 'Second', 1, 20, { selected: { required: ['health', 'movement'] } });
		try {
			await Promise.all([first.system.init(), second.system.init()]);
			await Promise.all([first.system.finishLoading(), second.system.finishLoading()]);
			world.update(16);
			await Promise.all([started(first.control), started(second.control)]);
			expect(world.registry.health.memoryComponent.length).toBe(2);
			const completions = [first.system.waitForRunToComplete(), second.system.waitForRunToComplete()];
			release(second.control);
			release(first.control);
			await Promise.all(completions.map(completion => Promise.resolve(completion)));
			expect([...world.entities.values()].map(entity => entity.components.health?.health)).toEqual([10, 20]);
		} finally {
			release(first.control);
			release(second.control);
			world.destroy();
		}
	});

	it('publishes creation beside an earlier sliced query that cannot contain the new entity', () => {
		const world = createWorld();
		world.loadEntity({ maxHealth: 10, speed: 1 });
		world.loadEntity({ maxHealth: 10, speed: 1 });
		const earlier = world.addSystem(new (class extends EntitySystem<Components> {
			updateEntity(): void {}
		})(world, { name: 'Earlier', components: ['health', 'movement'], writes: [], maxMsPerFrame: -1, iterationsPerCheck: 1 }));
		const creator = fallbackCreator(world);
		try {
			world.update(16);
			expect(earlier.isCurrentlyRunning()).toBe(true);
			expect(world.getEntityByEid(creator.descriptors[0].eid)).toBeDefined();
			expect(creator.system.isCurrentlyRunning()).toBe(false);
		} finally {
			world.destroy();
		}
	});

	it.each([
		{ required: ['health'], optional: ['movement'] },
		{ required: ['health'], not: ['movement'] },
		{ required: [], optional: ['movement'] },
		{ required: [], not: ['health'] },
	] satisfies Array<{ required: Array<keyof Components>, optional?: Array<keyof Components>, not?: Array<keyof Components> }>)('orders potentially matching queries: %j', async query => {
		const world = createWorld();
		const blocker = world.addSystem(new Reader(world, { name: 'Blocker', reads: ['health'], writes: [] }, true));
		const creator = fallbackCreator(world, 'Creator', ['health', 'movement']);
		const reader = queryReader(world, { selected: query });
		try {
			world.update(16);
			expect(reader.seen).toEqual([]);
			blocker.complete();
			await creator.system.waitForRunToComplete();
			await Promise.resolve();
			expect(reader.seen).toHaveLength(1);
			const excluded: ReadonlyArray<keyof Components> = query.not ?? [];
			expect(reader.seen[0]).toEqual(excluded.includes('health') ? [] : [creator.descriptors[0].eid]);
		} finally {
			world.destroy();
		}
	});

	it.each(['reads', 'writes'] as const)('preserves explicit %s outside an unrelated query', async access => {
		const world = createWorld();
		const blocker = world.addSystem(new Reader(world, { name: 'Blocker', reads: ['health'], writes: [] }, true));
		const creator = fallbackCreator(world);
		const reader = queryReader(world, { selected: { required: ['movement'], optional: ['health'] } }, access === 'reads' ? ['health'] : [], access === 'writes' ? ['health'] : []);
		try {
			world.update(16);
			expect(reader.seen).toEqual([]);
			blocker.complete();
			await creator.system.waitForRunToComplete();
			await Promise.resolve();
			expect(reader.seen).toEqual([[]]);
		} finally {
			world.destroy();
		}
	});

	it('does not let later creators with partial component sets hide an earlier matching creator', async () => {
		const world = createWorld();
		const matching = world.addSystem(new HeldCreator(world, 'Matching', ['health', 'movement']));
		const healthOnly = world.addSystem(new HeldCreator(world, 'HealthOnly', ['health']));
		const movementOnly = world.addSystem(new HeldCreator(world, 'MovementOnly', ['movement']));
		const reader = queryReader(world, { selected: { required: ['health', 'movement'] } });
		try {
			world.update(16);
			expect(matching.runs).toBe(1);
			expect(healthOnly.runs).toBe(1);
			expect(movementOnly.runs).toBe(1);
			expect(reader.seen).toEqual([]);
			matching.publish();
			await Promise.resolve();
			expect(reader.seen).toEqual([[]]);
			expect(healthOnly.isCurrentlyRunning()).toBe(true);
			expect(movementOnly.isCurrentlyRunning()).toBe(true);
			healthOnly.publish();
			movementOnly.publish();
		} finally {
			world.destroy();
		}
	});

	it('uses every named query and keeps requirements separate instead of combining unrelated queries', async () => {
		const world = createWorld();
		const blocker = world.addSystem(new Reader(world, { name: 'Blocker', reads: ['health'], writes: [] }, true));
		fallbackCreator(world);
		const reader = queryReader(world, { selected: { required: ['movement'] }, other: { required: ['health'] } });
		try {
			world.update(16);
			expect(reader.seen).toEqual([]);
			blocker.complete();
			await Promise.resolve();
			expect(reader.seen).toEqual([[]]);
		} finally {
			world.destroy();
		}
	});

	it('retains an earlier reader requirement snapshot across a rebuild with unrelated new requirements', async () => {
		const world = createWorld();
		for(let i = 0; i < 3; i++) {
			world.loadEntity({ maxHealth: 10, speed: 1 });
		}
		const earlier = world.addSystem(new (class extends EntitySystem<Components> {
			updateEntity(): void {}
		})(world, { name: 'Earlier', components: ['health', 'movement'], writes: [], maxMsPerFrame: -1, iterationsPerCheck: 1 }));
		try {
			world.update(16);
			earlier.options.components = ['movement', 'neighbors'];
			const creator = fallbackCreator(world, 'Creator', ['health', 'movement']);
			creator.system.firstRun = true;
			creator.system.deltaBetweenRuns = 1_000;
			world.update(16);
			expect(earlier.isCurrentlyRunning()).toBe(true);
			expect(creator.descriptors).toHaveLength(1);
			expect(world.entities.size).toBe(3);
			world.update(16);
			await creator.system.waitForRunToComplete();
			expect(world.entities.size).toBe(4);
		} finally {
			world.destroy();
		}
	});

	it('retains an earlier creator bound across rebuilds even when its later bound cannot match', async () => {
		const world = createWorld();
		let components: Array<keyof Components> = ['health', 'movement'];
		const creator = world.addSystem(new (class extends HeldCreator {
			get createdComponents(): ReadonlyArray<PropertyKey> {
				return ['entity', ...components];
			}
		})(world, 'Creator', components));
		try {
			world.update(16);
			components = ['health'];
			const reader = queryReader(world, { selected: { required: ['health', 'movement'] } });
			world.update(16);
			expect(creator.runs).toBe(1);
			expect(reader.seen).toEqual([]);
			creator.publish();
			await Promise.resolve();
			expect(reader.seen).toEqual([[]]);
			expect(creator.runs).toBe(2);
			expect(creator.isCurrentlyRunning()).toBe(true);
			creator.publish();
		} finally {
			world.destroy();
		}
	});

	it('retains conservative creation access for custom membership overrides', async () => {
		const world = createWorld();
		const blocker = world.addSystem(new Reader(world, { name: 'Blocker', reads: ['health'], writes: [] }, true));
		fallbackCreator(world);
		const called = vi.fn<() => void>();
		const worker = world.addSystem(new (class extends EntityWorkerSystem<Components, {}> {
			protected matchesQuery(entity: BaseEntity<Components>, query: EntityWorkerSystemQuery<Components>): boolean {
				return super.matchesQuery(entity, query);
			}
		})(world, {
			name: 'CustomWorker', required: ['movement'], optional: ['health'], writes: [], forceMainThread: true,
			updateFunction: called, getWorker: () => {
				throw new Error('fallback');
			},
		}));
		world.loadEntity({ speed: 1 });
		try {
			expect(worker.creationReadQueries).toBeUndefined();
			world.update(16);
			expect(called).not.toHaveBeenCalled();
			blocker.complete();
			await Promise.resolve();
			expect(called).toHaveBeenCalledOnce();
		} finally {
			world.destroy();
		}
	});

	it('retains publication dependencies across host updates and does not release the next run early', async () => {
		const world = createWorld();
		const earlier = world.addSystem(new Reader(world, { name: 'Earlier', reads: ['health'], writes: [] }, true));
		const creator = fallbackCreator(world);
		const later = world.addSystem(new Reader(world, { name: 'Later', reads: ['health'], writes: [] }));
		world.update(16);
		world.update(16);
		expect(creator.descriptors).toHaveLength(1);
		earlier.complete();
		await Promise.resolve();
		expect(later.seen).toEqual([1]);
		expect(earlier.seen).toEqual([0, 1]);
		expect(creator.descriptors).toHaveLength(2);
		expect(world.entities.size).toBe(1);
		earlier.complete();
		await Promise.resolve();
		expect(later.seen).toEqual([1, 2]);
		expect(world.entities.size).toBe(2);
		world.destroy();
	});

	it.each(['reset', 'reload', 'clear', 'destroy'] as const)('reclaims unpublished allocations and settles completion on %s', async action => {
		const world = createWorld();
		world.loadEntity({ speed: 1 });
		world.addSystem(new Reader(world, { name: 'Earlier', reads: ['health'], writes: [] }, true));
		const creator = fallbackCreator(world);
		world.update(16);
		const completion = creator.system.waitForRunToComplete();
		expect(world.registry.health.memoryComponent.length).toBe(1);
		if(action === 'reset') {
			world.scheduler.reset?.(world);
		} else if(action === 'reload') {
			world.load({ entities: [] });
		} else if(action === 'clear') {
			await world.clear();
		} else {
			world.destroy();
		}
		await completion;
		await Promise.resolve();
		expect(world.registry.health.memoryComponent.length).toBe(0);
		expect(world.getEntityByEid(creator.descriptors[0].eid)).toBeUndefined();
		expect(creator.system.isCurrentlyRunning()).toBe(false);
		world.destroy();
	});

	it('awaits a creator in an otherwise pristine world during clear and discards its result', async () => {
		const world = createWorld();
		const creator = threadedCreator(world, 'Creator');
		try {
			await creator.system.init();
			await creator.system.finishLoading();
			world.update(16);
			await started(creator.control);
			let cleared = false;
			const clearing = world.clear().then(() => {
				cleared = true;
				return undefined;
			});
			await Promise.resolve();
			expect(cleared).toBe(false);
			release(creator.control);
			await clearing;
			expect(world.entities.size).toBe(0);
			expect(world.registry.health.memoryComponent.length).toBe(0);
		} finally {
			release(creator.control);
			world.destroy();
		}
	});

	it('reclaims a stale creator reply after reloading a world with no published entities', async () => {
		const world = createWorld();
		const creator = threadedCreator(world, 'Creator');
		try {
			await creator.system.init();
			await creator.system.finishLoading();
			world.update(16);
			await started(creator.control);
			world.load({ entities: [] });
			release(creator.control);
			await vi.waitFor(() => expect(world.registry.health.memoryComponent.length).toBe(0));
			expect(world.entities.size).toBe(0);
		} finally {
			release(creator.control);
			world.destroy();
		}
	});

	it.each([true, ['health']] as const)('preserves immediate default-scheduler adoption with createsEntities: %j', createsEntities => {
		const world = new BaseWorld(registry);
		world.addSystem(new Reader(world, { name: 'Earlier', reads: ['health'], writes: [] }, true));
		const creator = fallbackCreator(world, 'Creator', createsEntities);
		world.update(16);
		expect(world.getEntityByEid(creator.descriptors[0].eid)).toBeDefined();
		expect(creator.system.isCurrentlyRunning()).toBe(false);
		world.destroy();
	});

	it('keeps creation lists typed and effect interception optional', () => {
		expectTypeOf<EntityWorkerSystemConfig<Components, {}>['createsEntities']>().toEqualTypeOf<boolean | ReadonlyArray<keyof Components> | undefined>();
		expectTypeOf<Scheduler<Components>['prepareEffects']>().toBeNullable();
	});
});
