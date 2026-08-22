import { ComponentSystem, TYPE_INDEX } from '../../index';
import type { BaseEntity, ComponentSystemQuery, System } from '../../index';
import { createTestWorld, type Components, type TestWorld } from '../../__tests__/fixtures/components';
import { eidsOf, listOf } from '../../__tests__/fixtures/entity-collections';
import { damageUpdate, DAMAGED_ENTITIES_EVENT, type DamageWorld, type DamageInitData } from '../../__tests__/fixtures/damage-update';
import { killUpdate, KILLED_ENTITIES_EVENT } from '../../__tests__/fixtures/kill-update';
import { spawnUpdate } from '../../__tests__/fixtures/spawn-update';
import { queryTargetUpdate } from '../../__tests__/fixtures/query-target-update';
import { typeReadUpdate, TYPE_READ_EVENT } from '../../__tests__/fixtures/type-read-update';
import { errorUpdate, POISON_MAX_HEALTH, type ErrorWorld } from '../../__tests__/fixtures/error-update';
import type { SystemError } from '../../index';

// Worker entry points loaded by @vitest/web-worker for the 'worker' mode below.
const NOOP_WORKER_URL = new URL('../../__tests__/fixtures/noop.worker.ts', import.meta.url);
const DAMAGE_WORKER_URL = new URL('../../__tests__/fixtures/damage.worker.ts', import.meta.url);
const KILL_WORKER_URL = new URL('../../__tests__/fixtures/kill.worker.ts', import.meta.url);
const SPAWN_WORKER_URL = new URL('../../__tests__/fixtures/spawn.worker.ts', import.meta.url);
const QUERY_TARGET_WORKER_URL = new URL('../../__tests__/fixtures/query-target.worker.ts', import.meta.url);
const TYPE_READ_WORKER_URL = new URL('../../__tests__/fixtures/type-read.worker.ts', import.meta.url);
const ERROR_WORKER_URL = new URL('../../__tests__/fixtures/error.worker.ts', import.meta.url);

// Every test runs against both backends: 'main-thread' (ComponentWebWorker) and 'worker' (a real worker
// module). Both must produce identical observable behavior.
type Mode = 'main-thread' | 'worker';
const MODES: Array<Mode> = ['main-thread', 'worker'];

interface StubOptions {
	required: Array<keyof Components>
	not?: Array<keyof Components>
	queries?: { [key: string]: ComponentSystemQuery<Components> }
}

// Waits a macrotask for a worker-mode run-complete message; a noop wait in main-thread mode.
function flush(): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, 0));
}

// Mirrors world.init(): boot the worker, then hand it its init data (finishLoading runs updateFunction.init).
async function initSystem(system: System<Components>): Promise<void> {
	await system.init();
	await system.finishLoading();
}

describe.each(MODES)('component-system (%s)', (mode) => {
	let world: TestWorld;
	let systems: Array<System<Components>>;
	beforeEach(() => {
		world = createTestWorld();
		systems = [];
	});
	afterEach(() => {
		systems.forEach(system => system.destroy());
	});

	// Bounded on the non-generic `System` base so it accepts systems that narrow `T` (invariant on
	// ComponentSystem), which aren't assignable to the wide default.
	function useSystem<S extends System<Components>>(system: S): S {
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
		expect(eidsOf(system.entities)).toEqual([entity1.eid, entity2.eid]);
	});

	it('with multiple component', () => {
		let system = useSystem(new StubSystem(world, mode, { required: ['health', 'movement'] }));

		let entity1 = createEntity({ maxHealth: 100, speed: 100 });
		createEntity({ maxHealth: 100 });
		createEntity({ speed: 100 });
		expect(eidsOf(system.entities)).toEqual([entity1.eid]);
	});

	it('with not components', () => {
		let system = useSystem(new StubSystem(world, mode, { required: ['health'], not: ['movement'] }));

		createEntity({ maxHealth: 100, speed: 100 });
		let entity2 = createEntity({ maxHealth: 100 });
		createEntity({ speed: 100 });
		expect(eidsOf(system.entities)).toEqual([entity2.eid]);
	});

	it('with dynamically added components in required list', () => {
		let system = useSystem(new StubSystem(world, mode, { required: ['health', 'movement'] }));

		let entity1 = createEntity({ maxHealth: 100, speed: 100 });
		createEntity({ maxHealth: 100 });
		let otherEntity = createEntity({ maxHealth: 100 });
		expect(eidsOf(system.entities)).toEqual([entity1.eid]);

		// Do add from correct component being added
		otherEntity.loadComponent('movement', { speed: 100 });
		expect(eidsOf(system.entities)).toEqual([entity1.eid, otherEntity.eid]);

		// Do remove from correct component being removed
		otherEntity.removeComponent('movement');
		expect(eidsOf(system.entities)).toEqual([entity1.eid]);
	});
	it('with dynamically added components in not list', () => {
		let system = useSystem(new StubSystem(world, mode, { required: ['health'], not: ['movement'] }));

		createEntity({ maxHealth: 100, speed: 100 });
		let entity2 = createEntity({ maxHealth: 100 });
		let otherEntity = createEntity({ maxHealth: 100, speed: 100 });
		expect(eidsOf(system.entities)).toEqual([entity2.eid]);

		otherEntity.removeComponent('movement');
		expect(eidsOf(system.entities)).toEqual([entity2.eid, otherEntity.eid]);

		otherEntity.loadComponent('movement', { speed: 100 });
		expect(eidsOf(system.entities)).toEqual([entity2.eid]);
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

	// The main-thread bookkeeping that produces each run's delta; applyQueryDelta covers the worker side.
	describe('membership delta', () => {
		it('queues a newly matched entity as an add until the next run flushes it', () => {
			let system = useSystem(new StubSystem(world, mode, { required: ['health'] }));

			let entity = createEntity({ maxHealth: 100 });
			expect(system.getPendingDelta()).toEqual({ added: [entity.eid], removed: [] });

			system.run(0);

			expect(system.getPendingDelta()).toEqual({ added: [], removed: [] });
		});

		it('queues a removed entity so the worker drops it from its persistent list', () => {
			let system = useSystem(new StubSystem(world, mode, { required: ['health'] }));

			let entity = createEntity({ maxHealth: 100 });
			system.run(0);

			world.removeEntity(entity);

			expect(system.getPendingDelta()).toEqual({ added: [], removed: [entity.eid] });
		});

		it('cancels out an entity added and removed before it is ever sent', () => {
			let system = useSystem(new StubSystem(world, mode, { required: ['health'] }));

			let entity = createEntity({ maxHealth: 100 });
			world.removeEntity(entity);

			expect(system.getPendingDelta()).toEqual({ added: [], removed: [] });
		});

		it('re-queues an entity as an add (not a remove) when its components change after being sent', () => {
			let system = useSystem(new StubSystem(world, mode, {
				required: ['health'],
				queries: {
					moving: {
						required: ['movement'],
					},
				},
			}));

			let entity = createEntity({ maxHealth: 100 });
			system.run(0);

			entity.loadComponent('movement', { speed: 100 });

			expect(system.getPendingDelta().added).toEqual([entity.eid]);
			expect(system.getPendingDelta('moving').added).toEqual([entity.eid]);
		});
	});

	// The update pipeline, where the backends genuinely differ (the real worker caches blocks by id and gets
	// only the id on later runs). Both must reach identical results.
	describe('run', () => {
		it('runs the update, mutating shared memory and emitting events', async () => {
			let system = useSystem(new DamageSystem(world, mode));
			await initSystem(system);

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

		it('emits an update function\'s own event on the entity with its args', async () => {
			let system = useSystem(new DamageSystem(world, mode));
			await initSystem(system);

			let entity = createEntity({ maxHealth: 100 });
			let damaged: Array<Array<number>> = [];
			entity.on('damaged', (damage: number, health: number) => {
				damaged.push([damage, health]);
			});

			system.run(16);
			await flush();

			expect(damaged).toEqual([[1, 99]]);
		});

		it('resolves each entity\'s type from its shared block via world.getString', async () => {
			let system = useSystem(new TypeReadSystem(world, mode));
			await initSystem(system);

			// Two entities share a type (one interned ConstantString) and a third differs.
			let ship1 = createEntity({ type: 'Space Ship', maxHealth: 10 });
			let ship2 = createEntity({ type: 'Space Ship', maxHealth: 10 });
			let miner = createEntity({ type: 'Miner', maxHealth: 10 });

			// The interning promise: identical types point at the same allocation (equal pointers in the block).
			const typePointer = (entity: BaseEntity<Components>) =>
				world.registry.entity.memoryComponent.getBlock(entity.components.entity.index)[TYPE_INDEX];
			expect(typePointer(ship1)).toEqual(typePointer(ship2));
			expect(typePointer(ship1)).not.toEqual(typePointer(miner));

			let seen = new Map<number, string>();
			[ship1, ship2, miner].forEach(entity => {
				entity.on(TYPE_READ_EVENT, (type: string) => seen.set(entity.eid, type));
			});

			system.run(16);
			await flush();

			expect(seen.get(ship1.eid)).toEqual('Space Ship');
			expect(seen.get(ship2.eid)).toEqual('Space Ship');
			expect(seen.get(miner.eid)).toEqual('Miner');
		});

		// PerformanceTiming is driven off these two events, so both backends must report a run.
		it('reports the run to the world either side of dispatching its events', async () => {
			let system = useSystem(new DamageSystem(world, mode));
			await initSystem(system);

			let entity = createEntity({ maxHealth: 100 });
			let calls: Array<string> = [];
			let runTimes: Array<number> = [];
			world.on(`system-${system.name}-worker-finished`, (runTime: number) => {
				calls.push('run-finished');
				runTimes.push(runTime);
			});
			entity.on('component-property-updated', () => calls.push('events'));
			world.on(`system-${system.name}-worker-events-finished`, () => calls.push('events-finished'));

			system.run(16);
			await flush();

			expect(calls).toEqual(['run-finished', 'events', 'events-finished']);
			expect(runTimes.length).toEqual(1);
			expect(runTimes[0]).toBeGreaterThanOrEqual(0);
		});

		it('caches components across repeated runs', async () => {
			let system = useSystem(new DamageSystem(world, mode));
			await initSystem(system);

			let entity = createEntity({ maxHealth: 100 });

			system.run(16);
			await flush();
			system.run(16);
			await flush();

			// In worker mode the second run sends only the id, so this proves the cached-block path works.
			expect(entity.components.health?.health).toEqual(98);
		});

		// A removal sends a remove delta, so survivors must keep updating correctly across it.
		it('keeps updating the remaining entities after one is removed', async () => {
			let system = useSystem(new DamageSystem(world, mode));
			await initSystem(system);

			let survivor = createEntity({ maxHealth: 100 });
			let leaving = createEntity({ maxHealth: 100 });

			system.run(16);
			await flush();
			expect(survivor.components.health?.health).toEqual(99);
			expect(leaving.components.health?.health).toEqual(99);

			world.removeEntity(leaving);

			let survivorEvents = 0;
			survivor.on('component-property-updated', () => {
				survivorEvents++;
			});

			system.run(16);
			await flush();

			expect(survivor.components.health?.health).toEqual(98);
			expect(survivorEvents).toEqual(1);
			expect(system.isEntityInSystem(leaving)).toEqual(false);
		});

		it('passes per-run data through addDataToWorld', async () => {
			let system = useSystem(new DamageSystem(world, mode));
			system.damagePerRun = 5;
			await initSystem(system);

			let entity = createEntity({ maxHealth: 100 });

			system.run(16);
			await flush();

			expect(entity.components.health?.health).toEqual(95);
		});

		it('merges updateFunction.init\'s result onto the world on every run', async () => {
			let system = useSystem(new DamageSystem(world, mode, 7));
			await initSystem(system);

			let entity = createEntity({ maxHealth: 100 });

			system.run(16);
			await flush();
			expect(entity.components.health?.health).toEqual(93);

			system.run(16);
			await flush();
			expect(entity.components.health?.health).toEqual(86);
		});

		it('only runs the update for entities matching the system', async () => {
			let system = useSystem(new DamageSystem(world, mode));
			await initSystem(system);

			let matching = createEntity({ maxHealth: 100 });
			let ignored = createEntity({ speed: 100 });

			system.run(16);
			await flush();

			expect(matching.components.health?.health).toEqual(99);
			expect(ignored.components.health).toBeUndefined();
		});

		it('killEntityWorker removes the entity from the world', async () => {
			let system = useSystem(new KillSystem(world, mode));
			await initSystem(system);

			let entity = createEntity({ maxHealth: 100 });
			expect(world.entities.has(entity.eid)).toEqual(true);

			system.run(16);
			await flush();

			expect(world.entities.has(entity.eid)).toEqual(false);
			expect(system.isEntityInSystem(entity)).toEqual(false);
		});

		it('createEntityWorker adds the requested entity to the world', async () => {
			let system = useSystem(new SpawnSystem(world, mode));
			await initSystem(system);

			let entity = createEntity({ maxHealth: 100 });
			expect(world.entities.size).toEqual(1);

			system.run(16);
			await flush();

			expect(world.entities.size).toEqual(2);
			let spawned = listOf(world.entities).find(other => other !== entity);
			// The worker wrote the health block directly; the main thread adopted it (no re-allocation).
			expect(spawned?.components.health?.maxHealth).toEqual(10);
			expect(spawned?.components.health?.health).toEqual(10);
			// The entity component is built on the main thread when the descriptor is adopted, interning the type.
			expect(spawned?.components.entity.type).toEqual('Spawned');

			// It exists only after the run, so the system picks it up next run.
			expect(system.isEntityInSystem(spawned!)).toEqual(true);
		});

		// Regression: events for sub-query-only entities (absent from the main-query cache) must still route back
		// via the world's getEntityByEid fallback.
		it('routes a death event to an entity only present in a sub-query', async () => {
			let system = useSystem(new QueryTargetSystem(world, mode));
			await initSystem(system);

			// The killer is the only movement (main-query) entity; the target is health-only, so it lives in the
			// `targets` sub-query.
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
			expect(world.entities.has(target.eid)).toEqual(false);
		});

		it('routes a component-property-updated event to an entity only present in a sub-query', async () => {
			let system = useSystem(new QueryTargetSystem(world, mode));
			await initSystem(system);

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

		// An update that reports the same thing about most of its entities names it once and hands over ids; the
		// whole run arrives as one call on the system.
		describe('system events', () => {
			it('emits one event on the system carrying every entity id it happened to', async () => {
				let system = useSystem(new DamageSystem(world, mode));
				await initSystem(system);

				let first = createEntity({ maxHealth: 100 });
				let second = createEntity({ maxHealth: 100 });

				let batches: Array<Array<number>> = [];
				system.on(DAMAGED_ENTITIES_EVENT, (entityIds: Array<number>) => {
					batches.push(entityIds);
				});

				system.run(16);
				await flush();

				expect(batches).toEqual([[first.eid, second.eid]]);
				// Nothing travelled with the ids; the values are already in shared memory.
				expect(first.components.health?.health).toEqual(99);
				expect(second.components.health?.health).toEqual(99);
			});

			it('does not emit an event no entity reported this run', async () => {
				let system = useSystem(new DamageSystem(world, mode));
				await initSystem(system);

				createEntity({ speed: 100 });

				let called = 0;
				system.on(DAMAGED_ENTITIES_EVENT, () => {
					called++;
				});

				system.run(16);
				await flush();

				expect(called).toEqual(0);
			});

			it('reports a fresh batch each run rather than accumulating', async () => {
				let system = useSystem(new DamageSystem(world, mode));
				await initSystem(system);

				let entity = createEntity({ maxHealth: 100 });

				let batches: Array<Array<number>> = [];
				system.on(DAMAGED_ENTITIES_EVENT, (entityIds: Array<number>) => {
					batches.push(entityIds);
				});

				system.run(16);
				await flush();
				system.run(16);
				await flush();

				expect(batches).toEqual([[entity.eid], [entity.eid]]);
			});

			// System events dispatch ahead of per-entity ones, so a listener can still resolve an entity the same
			// run's `death` (a per-entity event) goes on to remove.
			it('emits before the per-entity events of the same run', async () => {
				let system = useSystem(new KillSystem(world, mode));
				await initSystem(system);

				let entity = createEntity({ maxHealth: 100 });

				let aliveWhenReported: boolean | undefined;
				system.on(KILLED_ENTITIES_EVENT, (entityIds: Array<number>) => {
					aliveWhenReported = entityIds.every(eid => !!world.getEntityByEid(eid));
				});

				system.run(16);
				await flush();

				expect(aliveWhenReported).toEqual(true);
				expect(world.entities.has(entity.eid)).toEqual(false);
			});
		});

		// User code throwing must not abort the run: surviving entities still update, and each failure is
		// logged + surfaced as a `system-error` event on the main thread.
		describe('error handling', () => {
			let errorSpy: ReturnType<typeof vi.spyOn>;
			beforeEach(() => {
				errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
			});
			afterEach(() => {
				errorSpy.mockRestore();
			});

			it('keeps updating the other entities when one entity update throws', async () => {
				let system = useSystem(new ErrorSystem(world, mode));
				await initSystem(system);

				let poison = createEntity({ maxHealth: POISON_MAX_HEALTH });
				let survivor = createEntity({ maxHealth: 100 });

				let errors: Array<SystemError> = [];
				world.on('system-error', (error: SystemError) => errors.push(error));

				system.run(16);
				await flush();

				// The survivor still ran; the poison entity was left untouched.
				expect(survivor.components.health?.health).toEqual(99);
				expect(poison.components.health?.health).toEqual(POISON_MAX_HEALTH);

				expect(errors.length).toEqual(1);
				expect(errors[0].system).toEqual('ErrorSystem');
				expect(errors[0].entityId).toEqual(poison.eid);
				expect(errors[0].phase).toEqual('update');
				expect(errors[0].error.message).toEqual(`entity ${poison.eid} update failed`);
				expect(errorSpy).toHaveBeenCalled();
			});

			it('skips the entity loop when preRun throws', async () => {
				let system = useSystem(new ErrorSystem(world, mode));
				system.failPreRun = true;
				await initSystem(system);

				let entity = createEntity({ maxHealth: 100 });

				let errors: Array<SystemError> = [];
				world.on('system-error', (error: SystemError) => errors.push(error));

				system.run(16);
				await flush();

				// preRun failed, so no entity ran.
				expect(entity.components.health?.health).toEqual(100);
				expect(errors.length).toEqual(1);
				expect(errors[0].phase).toEqual('preRun');
			});
		});
	});
});

class StubSystem extends ComponentSystem<Components, {}> {
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
		const queryEntities = Reflect.get(this, 'queryEntities') as { [key: string]: Map<number, BaseEntity<Components>> };
		const list = queryEntities[queryName];
		return list ? eidsOf(list) : [];
	}

	// The next run()'s pending delta, resolved to eids. Defaults to the main query (internal key '___main').
	getPendingDelta(queryName = '___main'): { added: Array<number>, removed: Array<number> } {
		const deltas = Reflect.get(this, 'queryDeltas') as { [key: string]: { added: Set<BaseEntity<Components>>, removed: Set<number> } };
		const delta = deltas[queryName];
		return {
			added: delta ? Array.from(delta.added, entity => entity.eid) : [],
			removed: delta ? Array.from(delta.removed) : [],
		};
	}
}

class DamageSystem extends ComponentSystem<Components, { health: Int32Array }, DamageWorld, DamageInitData> {
	damagePerRun?: number;

	constructor(world: TestWorld, mode: Mode, initDamage?: number) {
		super(world, {
			name: 'DamageSystem',
			required: ['health'],
			updateFunction: damageUpdate,
			forceMainThread: mode === 'main-thread',
			getWorker: () => new Worker(DAMAGE_WORKER_URL, { type: 'module' }),
			getInitData: initDamage === undefined ? undefined : () => ({ damage: initDamage }),
		});
	}

	addDataToWorld(world: DamageWorld): void {
		if(this.damagePerRun !== undefined) {
			world.damage = this.damagePerRun;
		}
	}
}

class KillSystem extends ComponentSystem<Components, { health: Int32Array, entity?: Uint32Array }> {
	constructor(world: TestWorld, mode: Mode) {
		super(world, {
			name: 'KillSystem',
			required: ['health'],
			// entity is pulled in so killEntityWorker can reach its block.
			optional: ['entity'],
			updateFunction: killUpdate,
			forceMainThread: mode === 'main-thread',
			getWorker: () => new Worker(KILL_WORKER_URL, { type: 'module' }),
		});
	}
}

class SpawnSystem extends ComponentSystem<Components, { health: Int32Array }> {
	constructor(world: TestWorld, mode: Mode) {
		super(world, {
			name: 'SpawnSystem',
			required: ['health'],
			updateFunction: spawnUpdate,
			createsEntities: true,
			forceMainThread: mode === 'main-thread',
			getWorker: () => new Worker(SPAWN_WORKER_URL, { type: 'module' }),
		});
	}
}

class QueryTargetSystem extends ComponentSystem<Components, { movement: Float32Array }> {
	constructor(world: TestWorld, mode: Mode) {
		super(world, {
			name: 'QueryTargetSystem',
			required: ['movement'],
			updateFunction: queryTargetUpdate,
			forceMainThread: mode === 'main-thread',
			getWorker: () => new Worker(QUERY_TARGET_WORKER_URL, { type: 'module' }),
			queries: {
				// entity is pulled in so killEntityWorker can reach the target's block.
				targets: {
					required: ['health'],
					not: ['movement'],
					optional: ['entity'],
				},
			},
		});
	}
}

class ErrorSystem extends ComponentSystem<Components, { health: Int32Array }, ErrorWorld> {
	failPreRun = false;

	constructor(world: TestWorld, mode: Mode) {
		super(world, {
			name: 'ErrorSystem',
			required: ['health'],
			updateFunction: errorUpdate,
			forceMainThread: mode === 'main-thread',
			getWorker: () => new Worker(ERROR_WORKER_URL, { type: 'module' }),
		});
	}

	addDataToWorld(world: ErrorWorld): void {
		world.failPreRun = this.failPreRun;
	}
}

class TypeReadSystem extends ComponentSystem<Components, { entity: Uint32Array }> {
	constructor(world: TestWorld, mode: Mode) {
		super(world, {
			name: 'TypeReadSystem',
			required: ['entity'],
			updateFunction: typeReadUpdate,
			forceMainThread: mode === 'main-thread',
			getWorker: () => new Worker(TYPE_READ_WORKER_URL, { type: 'module' }),
		});
	}
}
