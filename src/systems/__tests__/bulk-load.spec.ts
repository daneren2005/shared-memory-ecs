import { EntitySystem, EntityWorkerSystem, WorkerSystem } from '../../index';
import type { BaseEntity, EntityWorkerSystemQuery } from '../../index';
import { createTestWorld, type Components, type Config, type TestWorld } from '../../__tests__/fixtures/components';
import { eidsOf, listOf } from '../../__tests__/fixtures/entity-collections';

const NOOP_WORKER_URL = new URL('../../__tests__/fixtures/noop.worker.ts', import.meta.url);

describe('world.load bulk membership', () => {
	let world: TestWorld;
	beforeEach(() => {
		world = createTestWorld();
	});
	afterEach(() => {
		world.destroy();
		vi.restoreAllMocks();
	});

	function loadedEids(filter: (entity: BaseEntity<Components>) => boolean): Array<number> {
		return listOf(world.entities).filter(filter).map(entity => entity.eid);
	}

	const ENTITIES: Array<Config> = [
		{ maxHealth: 10, speed: 1 },
		{ maxHealth: 20 },
		{ speed: 2 },
		{ maxHealth: 30, isStatic: true },
		{ maxHealth: 40, speed: 3 },
		{ countsNeighbors: true },
	];

	it('adds matching entities to an EntitySystem without checking each one', () => {
		const check = vi.spyOn(EntitySystem.prototype, 'checkAddEntity');
		const system = world.addSystem(new HealthSystem(world));

		world.load({ entities: ENTITIES });

		expect(check).not.toHaveBeenCalled();
		// The static entity has health but is filtered out.
		expect(eidsOf(system.entities)).toEqual(loadedEids(entity => !!entity.components.health && !entity.components.entity.isStatic));
		expect(system.updatedOnAdd).toEqual(eidsOf(system.entities));
	});

	it('fills an EntityWorkerSystem main query, sub-queries and pending delta', () => {
		const check = vi.spyOn(EntityWorkerSystem.prototype, 'checkAddEntity');
		const system = world.addSystem(new QuerySystem(world, {
			required: ['health'],
			not: ['movement'],
			queries: {
				fast: { required: ['movement'], filter: entity => (entity.components.movement?.speed ?? 0) > 1 },
			},
		}));

		world.load({ entities: ENTITIES });

		expect(check).not.toHaveBeenCalled();
		const main = loadedEids(entity => !!entity.components.health && !entity.components.movement);
		expect(eidsOf(system.entities)).toEqual(main);
		expect(system.pendingAdded('___main')).toEqual(main);
		const fast = loadedEids(entity => (entity.components.movement?.speed ?? 0) > 1);
		expect(system.queryEids('fast')).toEqual(fast);
		expect(system.pendingAdded('fast')).toEqual(fast);
	});

	it('includes components added in finishLoading', () => {
		const system = world.addSystem(new QuerySystem(world, { required: ['neighbors'] }));

		world.load({ entities: ENTITIES });

		expect(eidsOf(system.entities)).toEqual(loadedEids(entity => !!entity.components.neighbors));
	});

	it('leaves a WorkerSystem main query empty and fills its sub-queries', () => {
		const system = world.addSystem(new RunOnceSystem(world));

		world.load({ entities: ENTITIES });

		expect(system.entities.size).toEqual(0);
		expect(system.queryEids('moving')).toEqual(loadedEids(entity => !!entity.components.movement));
	});

	it('still checks each entity on a system with its own membership rule', () => {
		const system = world.addSystem(new EvenOnlySystem(world));

		world.load({ entities: ENTITIES });

		expect(system.checked).toEqual(loadedEids(() => true));
		expect(eidsOf(system.entities)).toEqual(loadedEids(entity => !!entity.components.health && entity.eid % 2 === 0));
	});

	it('emits entity-added for every entity and picks up entities created by a listener mid-load', () => {
		const system = world.addSystem(new QuerySystem(world, { required: ['health'] }));
		const added: Array<number> = [];
		let spawning = false;
		let spawned: BaseEntity<Components> | undefined;
		world.on('entity-added', (entity: BaseEntity<Components>) => {
			added.push(entity.eid);
			if(!spawning) {
				spawning = true;
				spawned = world.loadEntity({ maxHealth: 99 });
			}
		});

		world.load({ entities: ENTITIES });

		expect(added.sort((a, b) => a - b)).toEqual(loadedEids(() => true).sort((a, b) => a - b));
		expect(eidsOf(system.entities)).toContain(spawned?.eid);
	});

	it('goes back to per-entity checks once loading finishes', () => {
		const system = world.addSystem(new QuerySystem(world, { required: ['health'] }));
		world.load({ entities: [{ maxHealth: 10 }] });

		const later = world.loadEntity({ maxHealth: 20 });
		const other = world.loadEntity({ speed: 1 });
		other.loadComponent('health', { maxHealth: 5 });

		expect(eidsOf(system.entities)).toContain(later.eid);
		expect(eidsOf(system.entities)).toContain(other.eid);
	});
});

class HealthSystem extends EntitySystem<Components> {
	updatedOnAdd: Array<number> = [];

	constructor(world: TestWorld) {
		super(world, { name: 'HealthSystem', components: ['health'], updateEntityOnAdd: true });
	}

	updateEntity(entity: BaseEntity<Components>): void {
		this.updatedOnAdd.push(entity.eid);
	}
}

class QuerySystem extends EntityWorkerSystem<Components, {}> {
	constructor(world: TestWorld, query: EntityWorkerSystemQuery<Components> & { queries?: { [key: string]: EntityWorkerSystemQuery<Components> } }) {
		super(world, {
			name: 'QuerySystem',
			updateFunction: () => {},
			forceMainThread: true,
			getWorker: () => new Worker(NOOP_WORKER_URL, { type: 'module' }),
			...query,
		});
	}

	queryEids(queryName: string): Array<number> {
		return eidsOf(this.queryEntities[queryName] ?? new Map());
	}
	pendingAdded(queryName: string): Array<number> {
		const deltas = Reflect.get(this, 'queryDeltas') as { [key: string]: { added: Set<BaseEntity<Components>> } };
		return Array.from(deltas[queryName]?.added ?? [], entity => entity.eid);
	}
}

class EvenOnlySystem extends QuerySystem {
	checked: Array<number> = [];

	constructor(world: TestWorld) {
		super(world, { required: ['health'] });
	}

	checkAddEntity(entity: BaseEntity<Components>): boolean {
		this.checked.push(entity.eid);
		return entity.eid % 2 === 0 && super.checkAddEntity(entity);
	}
}

class RunOnceSystem extends WorkerSystem<Components> {
	constructor(world: TestWorld) {
		super(world, {
			name: 'RunOnceSystem',
			updateFunction: () => {},
			forceMainThread: true,
			getWorker: () => new Worker(NOOP_WORKER_URL, { type: 'module' }),
			queries: { moving: { required: ['movement'] } },
		});
	}

	queryEids(queryName: string): Array<number> {
		return eidsOf(this.queryEntities[queryName] ?? new Map());
	}
}
