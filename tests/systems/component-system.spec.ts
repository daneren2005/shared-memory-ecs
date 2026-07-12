import { ComponentSystem } from '../../src';
import type { BaseEntity, BaseWorld, ComponentSystemQuery, ComponentSystemWorld } from '../../src';
import { createTestWorld, type Components } from '../fixtures/components';
import { damageUpdate } from '../fixtures/damage-update';

// Worker entry points loaded by @vitest/web-worker for the 'worker' mode below.  The noop worker backs
// the membership tests (which never call run()); the damage worker backs the run() flow tests.
const NOOP_WORKER_URL = new URL('../fixtures/noop.worker.ts', import.meta.url);
const DAMAGE_WORKER_URL = new URL('../fixtures/damage.worker.ts', import.meta.url);

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
	let world: BaseWorld<Components>;
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

		let entity1 = createEntity({ health: { maxHealth: 100 }, movement: { speed: 100 } });
		let entity2 = createEntity({ health: { maxHealth: 100 } });
		createEntity({ movement: { speed: 100 } });
		expect(system.entities.map(e => e.eid)).toEqual([entity1.eid, entity2.eid]);
	});

	it('with multiple component', () => {
		let system = useSystem(new StubSystem(world, mode, { required: ['health', 'movement'] }));

		let entity1 = createEntity({ health: { maxHealth: 100 }, movement: { speed: 100 } });
		createEntity({ health: { maxHealth: 100 } });
		createEntity({ movement: { speed: 100 } });
		expect(system.entities.map(e => e.eid)).toEqual([entity1.eid]);
	});

	it('with not components', () => {
		let system = useSystem(new StubSystem(world, mode, { required: ['health'], not: ['movement'] }));

		createEntity({ health: { maxHealth: 100 }, movement: { speed: 100 } });
		let entity2 = createEntity({ health: { maxHealth: 100 } });
		createEntity({ movement: { speed: 100 } });
		expect(system.entities.map(e => e.eid)).toEqual([entity2.eid]);
	});

	it('with dynamically added components in required list', () => {
		let system = useSystem(new StubSystem(world, mode, { required: ['health', 'movement'] }));

		let entity1 = createEntity({ health: { maxHealth: 100 }, movement: { speed: 100 } });
		createEntity({ health: { maxHealth: 100 } });
		let otherEntity = createEntity({ health: { maxHealth: 100 } });
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

		createEntity({ health: { maxHealth: 100 }, movement: { speed: 100 } });
		let entity2 = createEntity({ health: { maxHealth: 100 } });
		let otherEntity = createEntity({ health: { maxHealth: 100 }, movement: { speed: 100 } });
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

		let movingEntity = createEntity({ health: { maxHealth: 100 }, movement: { speed: 100 } });
		createEntity({ health: { maxHealth: 100 } });

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

		let movingEntity = createEntity({ health: { maxHealth: 100 }, movement: { speed: 100 } });
		let staticEntity = createEntity({ health: { maxHealth: 100 } });

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

		createEntity({ health: { maxHealth: 100 }, movement: { speed: 100 } });
		let staticEntity = createEntity({ health: { maxHealth: 100 } });

		expect(system.getQueryEntityEids('noMovement')).toEqual([staticEntity.eid]);

		staticEntity.loadComponent('movement', { speed: 100 });
		expect(system.getQueryEntityEids('noMovement')).toEqual([]);

		staticEntity.removeComponent('movement');
		expect(system.getQueryEntityEids('noMovement')).toEqual([staticEntity.eid]);
	});

	it('removing an entity adds its eid to removedEntityBuffer', () => {
		let system = useSystem(new StubSystem(world, mode, { required: ['health'] }));

		let entity = createEntity({ health: { maxHealth: 100 } });
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

			let entity = createEntity({ health: { maxHealth: 100 } });
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

			let entity = createEntity({ health: { maxHealth: 100 } });

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

			let entity = createEntity({ health: { maxHealth: 100 } });

			system.run(16);
			await flush();

			expect(entity.components.health?.health).toEqual(95);
		});

		it('only runs the update for entities matching the system', async () => {
			let system = useSystem(new DamageSystem(world, mode));
			await system.init();

			let matching = createEntity({ health: { maxHealth: 100 } });
			let ignored = createEntity({ movement: { speed: 100 } });

			system.run(16);
			await flush();

			expect(matching.components.health?.health).toEqual(99);
			expect(ignored.components.health).toBeUndefined();
		});
	});
});

class StubSystem extends ComponentSystem<Components> {
	constructor(world: BaseWorld<Components>, mode: Mode, options: StubOptions) {
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

	constructor(world: BaseWorld<Components>, mode: Mode) {
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
