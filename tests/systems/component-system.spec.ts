import { ComponentSystem } from '../../src';
import type { BaseEntity, ComponentSystemQuery, ComponentSystemWorld } from '../../src';
import { createTestWorld, type Components, type TestWorld } from '../fixtures/components';
import { damageUpdate } from '../fixtures/damage-update';
import { killUpdate } from '../fixtures/kill-update';
import { spawnUpdate } from '../fixtures/spawn-update';
import { queryTargetUpdate } from '../fixtures/query-target-update';

// Worker entry points loaded by @vitest/web-worker for the 'worker' mode below.  The noop worker backs
// the membership tests (which never call run()); the damage worker backs the run() flow tests; the kill
// worker backs the death tests; the spawn worker backs the creation tests; the query-target worker backs
// the sub-query event-routing tests.
const NOOP_WORKER_URL = new URL('../fixtures/noop.worker.ts', import.meta.url);
const DAMAGE_WORKER_URL = new URL('../fixtures/damage.worker.ts', import.meta.url);
const KILL_WORKER_URL = new URL('../fixtures/kill.worker.ts', import.meta.url);
const SPAWN_WORKER_URL = new URL('../fixtures/spawn.worker.ts', import.meta.url);
const QUERY_TARGET_WORKER_URL = new URL('../fixtures/query-target.worker.ts', import.meta.url);

// Every test runs against both backends: 'main-thread' uses the in-process ComponentWebWorker
// (forceMainThread), 'worker' uses a real worker module driven through createComponentWorker.  Both must
// produce identical observable behavior.
type Mode = 'main-thread' | 'worker';
const MODES: Array<Mode> = ['main-thread', 'worker'];

interface StubOptions {
	required: Array<keyof Components>
	not?: Array<keyof Components>
	queries?: { [key: string]: ComponentSystemQuery<Components> }
}

// Lets a worker-mode run() settle: postMessage to a real worker is async, so we wait a macrotask for the
// run-complete message to come back.  In main-thread mode the work is synchronous and this is a noop wait.
function flush(): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, 0));
}

describe.each(MODES)('component-system (%s)', (mode) => {
	let world: TestWorld;
	let systems: Array<ComponentSystem<Components>>;
	beforeEach(() => {
		world = createTestWorld();
		systems = [];
	});
	afterEach(() => {
		// Terminate any real workers spun up during the test.
		systems.forEach(system => system.destroy());
	});

	// Registers the system with the world and tracks it for teardown.
	function useSystem<S extends ComponentSystem<Components>>(system: S): S {
		systems.push(system);
		world.addSystem(system);
		return system;
	}
	function createEntity(config: any): BaseEntity<Components> {
		return world.loadEntity(config);
	}

	it('with single component', () => {
		let system = useSystem(new StubSystem(world, mode, { required: ['health'] }));

		let entity1 = createEntity({ maxHealth: 100, speed: 100 });
		let entity2 = createEntity({ maxHealth: 100 });
		createEntity({ speed: 100 });
		expect(system.entities.map(e => e.eid)).toEqual([entity1.eid, entity2.eid]);
	});

	it('with multiple component', () => {
		let system = useSystem(new StubSystem(world, mode, { required: ['health', 'movement'] }));

		let entity1 = createEntity({ maxHealth: 100, speed: 100 });
		createEntity({ maxHealth: 100 });
		createEntity({ speed: 100 });
		expect(system.entities.map(e => e.eid)).toEqual([entity1.eid]);
	});

	it('with not components', () => {
		let system = useSystem(new StubSystem(world, mode, { required: ['health'], not: ['movement'] }));

		createEntity({ maxHealth: 100, speed: 100 });
		let entity2 = createEntity({ maxHealth: 100 });
		createEntity({ speed: 100 });
		expect(system.entities.map(e => e.eid)).toEqual([entity2.eid]);
	});

	it('with dynamically added components in required list', () => {
		let system = useSystem(new StubSystem(world, mode, { required: ['health', 'movement'] }));

		let entity1 = createEntity({ maxHealth: 100, speed: 100 });
		createEntity({ maxHealth: 100 });
		let otherEntity = createEntity({ maxHealth: 100 });
		expect(system.entities.map(e => e.eid)).toEqual([entity1.eid]);

		// Do add from correct component being added
		otherEntity.loadComponent('movement', { speed: 100 });
		expect(system.entities.map(e => e.eid)).toEqual([entity1.eid, otherEntity.eid]);

		// Do remove from correct component being removed
		otherEntity.removeComponent('movement');
		expect(system.entities.map(e => e.eid)).toEqual([entity1.eid]);
	});
	it('with dynamically added components in not list', () => {
		let system = useSystem(new StubSystem(world, mode, { required: ['health'], not: ['movement'] }));

		createEntity({ maxHealth: 100, speed: 100 });
		let entity2 = createEntity({ maxHealth: 100 });
		let otherEntity = createEntity({ maxHealth: 100, speed: 100 });
		expect(system.entities.map(e => e.eid)).toEqual([entity2.eid]);

		otherEntity.removeComponent('movement');
		expect(system.entities.map(e => e.eid)).toEqual([entity2.eid, otherEntity.eid]);

		otherEntity.loadComponent('movement', { speed: 100 });
		expect(system.entities.map(e => e.eid)).toEqual([entity2.eid]);
	});

	it('query entity list only contains matching entities', () => {
		let system = useSystem(new StubSystem(world, mode, {
			required: ['health'],
			queries: {
				onlyMovement: {
					required: ['movement'],
				},
			},
		}));

		let movingEntity = createEntity({ maxHealth: 100, speed: 100 });
		createEntity({ maxHealth: 100 });

		expect(system.getQueryEntityEids('onlyMovement')).toEqual([movingEntity.eid]);
	});

	it('query entity list updates when required query component is added/removed', () => {
		let system = useSystem(new StubSystem(world, mode, {
			required: ['health'],
			queries: {
				onlyMovement: {
					required: ['movement'],
				},
			},
		}));

		let movingEntity = createEntity({ maxHealth: 100, speed: 100 });
		let staticEntity = createEntity({ maxHealth: 100 });

		expect(system.getQueryEntityEids('onlyMovement')).toEqual([movingEntity.eid]);

		staticEntity.loadComponent('movement', { speed: 100 });
		expect(system.getQueryEntityEids('onlyMovement')).toEqual([movingEntity.eid, staticEntity.eid]);

		staticEntity.removeComponent('movement');
		expect(system.getQueryEntityEids('onlyMovement')).toEqual([movingEntity.eid]);
	});

	it('query entity list updates when not query component is added/removed', () => {
		let system = useSystem(new StubSystem(world, mode, {
			required: ['health'],
			queries: {
				noMovement: {
					required: ['health'],
					not: ['movement'],
				},
			},
		}));

		createEntity({ maxHealth: 100, speed: 100 });
		let staticEntity = createEntity({ maxHealth: 100 });

		expect(system.getQueryEntityEids('noMovement')).toEqual([staticEntity.eid]);

		staticEntity.loadComponent('movement', { speed: 100 });
		expect(system.getQueryEntityEids('noMovement')).toEqual([]);

		staticEntity.removeComponent('movement');
		expect(system.getQueryEntityEids('noMovement')).toEqual([staticEntity.eid]);
	});

	it('removing an entity adds its eid to removedEntityBuffer', () => {
		let system = useSystem(new StubSystem(world, mode, { required: ['health'] }));

		let entity = createEntity({ maxHealth: 100 });
		expect(system.getRemovedEntityBuffer()).toEqual([]);

		world.removeEntity(entity);

		expect(system.getRemovedEntityBuffer()).toContain(entity.eid);
	});

	// These drive the actual update pipeline - the part that genuinely differs between the two backends
	// (ComponentWebWorker passes components straight through; the real worker caches them by entity id and
	// only receives the id on later runs).  Both must reach identical results.
	describe('run', () => {
		it('runs the update, mutating shared memory and emitting events', async () => {
			let system = useSystem(new DamageSystem(world, mode));
			await system.init();

			let entity = createEntity({ maxHealth: 100 });
			let events: Array<number> = [];
			entity.on('component-property-updated', (_component, _prop, value: number) => {
				events.push(value);
			});

			system.run(16);
			await flush();

			expect(entity.components.health?.health).toEqual(99);
			expect(events).toEqual([99]);
		});

		it('caches components across repeated runs', async () => {
			let system = useSystem(new DamageSystem(world, mode));
			await system.init();

			let entity = createEntity({ maxHealth: 100 });

			system.run(16);
			await flush();
			system.run(16);
			await flush();

			// In worker mode the second run only sends the entity id and relies on the worker's cached
			// shared-memory block, so a correct result here proves that caching path works.
			expect(entity.components.health?.health).toEqual(98);
		});

		it('passes per-run data through addDataToWorld', async () => {
			let system = useSystem(new DamageSystem(world, mode));
			system.damagePerRun = 5;
			await system.init();

			let entity = createEntity({ maxHealth: 100 });

			system.run(16);
			await flush();

			expect(entity.components.health?.health).toEqual(95);
		});

		it('only runs the update for entities matching the system', async () => {
			let system = useSystem(new DamageSystem(world, mode));
			await system.init();

			let matching = createEntity({ maxHealth: 100 });
			let ignored = createEntity({ speed: 100 });

			system.run(16);
			await flush();

			expect(matching.components.health?.health).toEqual(99);
			expect(ignored.components.health).toBeUndefined();
		});

		it('killEntityWorker removes the entity from the world', async () => {
			let system = useSystem(new KillSystem(world, mode));
			await system.init();

			let entity = createEntity({ maxHealth: 100 });
			expect(world.entities).toContain(entity);

			system.run(16);
			await flush();

			// The worker flagged it dead in shared memory and reported the death back, so the world removed it.
			expect(world.entities).not.toContain(entity);
			expect(system.isEntityInSystem(entity)).toEqual(false);
		});

		it('createEntityWorker adds the requested entity to the world', async () => {
			let system = useSystem(new SpawnSystem(world, mode));
			await system.init();

			let entity = createEntity({ maxHealth: 100 });
			expect(world.entities).toHaveLength(1);

			system.run(16);
			await flush();

			// The worker can't create the entity itself, so it asked the main thread to; loadEntity ran on
			// run-complete, leaving the original entity plus the one it spawned.
			expect(world.entities).toHaveLength(2);
			let spawned = world.entities.find(other => other !== entity);
			expect(spawned?.components.health?.maxHealth).toEqual(10);
			expect(spawned?.components.health?.health).toEqual(10);

			// The spawned entity only exists after the run, so the system that requested it picks it up on the
			// next run rather than the one that created it.
			expect(system.isEntityInSystem(spawned!)).toEqual(true);
		});

		// Regression: events for entities the system only knows through a sub-query (never its main query)
		// must still route back to the entity.  These entities are absent from the main query component cache,
		// so routing them relies on the world's getEntityByEid fallback.
		it('routes a death event to an entity only present in a sub-query', async () => {
			let system = useSystem(new QueryTargetSystem(world, mode));
			await system.init();

			// The killer is the only main-query (movement) entity; the target has health but no movement, so it
			// lives in the `targets` sub-query and is never part of the system's main query.
			createEntity({ speed: 100 });
			let target = createEntity({ maxHealth: 100 });
			expect(system.isEntityInSystem(target)).toEqual(false);

			let died = false;
			target.on('death', () => {
				died = true;
			});

			system.run(16);
			await flush();

			expect(died).toEqual(true);
			// The death event ran the world's cleanup, removing the sub-query-only entity.
			expect(world.entities).not.toContain(target);
		});

		it('routes a component-property-updated event to an entity only present in a sub-query', async () => {
			let system = useSystem(new QueryTargetSystem(world, mode));
			await system.init();

			createEntity({ speed: 100 });
			let target = createEntity({ maxHealth: 100 });
			expect(system.isEntityInSystem(target)).toEqual(false);

			let events: Array<number> = [];
			target.on('component-property-updated', (_component, _prop, value: number) => {
				events.push(value);
			});

			system.run(16);
			await flush();

			expect(events).toEqual([50]);
		});
	});
});

class StubSystem extends ComponentSystem<Components> {
	constructor(world: TestWorld, mode: Mode, options: StubOptions) {
		super(world, {
			name: 'StubSystem',
			updateFunction: () => {},
			forceMainThread: mode === 'main-thread',
			getWorker: () => new Worker(NOOP_WORKER_URL, { type: 'module' }),

			...options,
		});
	}

	getQueryEntityEids(queryName: string): Array<number> {
		const queryEntities = Reflect.get(this, 'queryEntities') as { [key: string]: Array<BaseEntity<Components>> };
		return (queryEntities[queryName] ?? []).map(entity => entity.eid);
	}

	getRemovedEntityBuffer(): Array<number> {
		return [...(Reflect.get(this, 'removedEntityBuffer') as Array<number>)];
	}
}

class DamageSystem extends ComponentSystem<Components> {
	damagePerRun?: number;

	constructor(world: TestWorld, mode: Mode) {
		super(world, {
			name: 'DamageSystem',
			required: ['health'],
			updateFunction: damageUpdate,
			forceMainThread: mode === 'main-thread',
			getWorker: () => new Worker(DAMAGE_WORKER_URL, { type: 'module' }),
		});
	}

	addDataToWorld(world: ComponentSystemWorld): void {
		if(this.damagePerRun !== undefined) {
			world.damage = this.damagePerRun;
		}
	}
}

class KillSystem extends ComponentSystem<Components> {
	constructor(world: TestWorld, mode: Mode) {
		super(world, {
			name: 'KillSystem',
			required: ['health'],
			// The entity component is pulled into the query so killEntityWorker can reach its shared block.
			optional: ['entity'],
			updateFunction: killUpdate,
			forceMainThread: mode === 'main-thread',
			getWorker: () => new Worker(KILL_WORKER_URL, { type: 'module' }),
		});
	}
}

class SpawnSystem extends ComponentSystem<Components> {
	constructor(world: TestWorld, mode: Mode) {
		super(world, {
			name: 'SpawnSystem',
			required: ['health'],
			updateFunction: spawnUpdate,
			forceMainThread: mode === 'main-thread',
			getWorker: () => new Worker(SPAWN_WORKER_URL, { type: 'module' }),
		});
	}
}

class QueryTargetSystem extends ComponentSystem<Components> {
	constructor(world: TestWorld, mode: Mode) {
		super(world, {
			// Main query is movement-only, so health entities acted on below are never part of it.
			name: 'QueryTargetSystem',
			required: ['movement'],
			updateFunction: queryTargetUpdate,
			forceMainThread: mode === 'main-thread',
			getWorker: () => new Worker(QUERY_TARGET_WORKER_URL, { type: 'module' }),
			queries: {
				// The entity component is pulled in so killEntityWorker can reach the target's shared block.
				targets: {
					required: ['health'],
					not: ['movement'],
					optional: ['entity'],
				},
			},
		});
	}
}
