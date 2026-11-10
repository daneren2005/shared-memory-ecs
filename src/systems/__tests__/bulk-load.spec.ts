import { EntitySystem, EntityWorkerSystem, WorkerSystem } from '../../index';
import type { BaseEntity, EntityQueryComponents, EntityUpdateFunction, EntityWorkerSystemQuery, UpdateEntityConfigObject } from '../../index';
import createEntitySystemWorker, { type EntitySystemWorkerScope } from '../workers/create-entity-system-worker';
import type EntitySystemWorkerMessage from '../workers/entity-system-worker-message';
import { createTestWorld, type ComponentArrays, type Components, type Config, type TestWorld } from '../../__tests__/fixtures/components';
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

		void world.load({ entities: ENTITIES });

		expect(check).not.toHaveBeenCalled();
		// The static entity has health but is filtered out.
		expect(eidsOf(system.entities)).toEqual(loadedEids(entity => !!entity.components.health && !entity.components.entity.isStatic));
		expect(system.updatedOnAdd).toEqual(eidsOf(system.entities));
	});

	it('fills an EntityWorkerSystem main query, sub-queries and ships the delta with load', () => {
		const check = vi.spyOn(EntityWorkerSystem.prototype, 'checkAddEntity');
		const system = world.addSystem(new QuerySystem(world, {
			required: ['health'],
			not: ['movement'],
			queries: {
				fast: { required: ['movement'], filter: entity => (entity.components.movement?.speed ?? 0) > 1 },
			},
		}));
		const post = vi.spyOn(system.worker, 'postMessage');

		void world.load({ entities: ENTITIES });

		expect(check).not.toHaveBeenCalled();
		const load = post.mock.calls.map(([message]) => message as EntitySystemWorkerMessage).find(message => message.type === 'load');
		if(load?.type !== 'load') {
			throw new Error('load not posted');
		}
		const main = loadedEids(entity => !!entity.components.health && !entity.components.movement);
		expect(eidsOf(system.entities)).toEqual(main);
		expect(load.entities.added.map(entity => entity.entityId)).toEqual(main);
		expect(system.pendingAdded('___main')).toEqual([]);
		const fast = loadedEids(entity => (entity.components.movement?.speed ?? 0) > 1);
		expect(system.queryEids('fast')).toEqual(fast);
		expect(load.queries.fast.added.map(entity => entity.entityId)).toEqual(fast);
		expect(system.pendingAdded('fast')).toEqual([]);
	});

	it('includes components added in finishLoading', () => {
		const system = world.addSystem(new QuerySystem(world, { required: ['neighbors'] }));

		void world.load({ entities: ENTITIES });

		expect(eidsOf(system.entities)).toEqual(loadedEids(entity => !!entity.components.neighbors));
	});

	it('leaves a WorkerSystem main query empty and fills its sub-queries', () => {
		const system = world.addSystem(new RunOnceSystem(world));

		void world.load({ entities: ENTITIES });

		expect(system.entities.size).toEqual(0);
		expect(system.queryEids('moving')).toEqual(loadedEids(entity => !!entity.components.movement));
	});

	it('still checks each entity on a system with its own membership rule', () => {
		const system = world.addSystem(new EvenOnlySystem(world));

		void world.load({ entities: ENTITIES });

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

		void world.load({ entities: ENTITIES });

		expect(added.sort((a, b) => a - b)).toEqual(loadedEids(() => true).sort((a, b) => a - b));
		expect(eidsOf(system.entities)).toContain(spawned?.eid);
	});

	it('joins a bulk load without queueing delta rows', () => {
		const system = world.addSystem(new QuerySystem(world, { required: ['health'], queries: { moving: { required: ['movement'] } } }));
		let pending: Array<Array<number>> = [];

		void world.load({ entities: ENTITIES }, {
			onProgress: ({ phase, done }) => {
				if(phase === 'systems' && done === 1) {
					pending = [system.pendingAdded('___main'), system.pendingAdded('moving')];
				}
			},
		});

		expect(pending).toEqual([[], []]);
		expect(system.entities.size).toBeGreaterThan(0);
	});

	it('leaves an entity removed after the join out of the load message', () => {
		const system = world.addSystem(new QuerySystem(world, { required: ['health'] }));
		const post = vi.spyOn(system.worker, 'postMessage');
		let removed = 0;

		void world.load({ entities: ENTITIES }, {
			onProgress: ({ phase, done }) => {
				if(phase === 'systems' && done === 1) {
					const entity = listOf(system.entities)[0];
					removed = entity.eid;
					world.removeEntity(entity);
				}
			},
		});

		const load = findLoad(post.mock.calls);
		expect(removed).toBeGreaterThan(0);
		expect(load.entities.added.map(entity => entity.entityId)).not.toContain(removed);
		expect(load.entities.added.map(entity => entity.entityId)).toEqual(eidsOf(system.entities));
	});

	it('sends only what changed on a later finishLoading', () => {
		const system = world.addSystem(new QuerySystem(world, { required: ['health'] }));
		void world.load({ entities: ENTITIES });
		const post = vi.spyOn(system.worker, 'postMessage');

		void system.finishLoading();
		expect(findLoad(post.mock.calls).entities.added).toEqual([]);

		post.mockClear();
		const later = world.loadEntity({ maxHealth: 50 });
		void system.finishLoading();
		expect(findLoad(post.mock.calls).entities.added.map(entity => entity.entityId)).toEqual([later.eid]);
	});

	it('sends a real worker packed columns and transfers them', () => {
		const worker = new RecordingWorker();
		const system = world.addSystem(new QuerySystem(world, {
			required: ['health'],
			optional: ['movement'],
			queries: { moving: { required: ['movement'] } },
			forceMainThread: false,
			getWorker: () => worker as unknown as Worker,
		}));

		void world.load({ entities: ENTITIES });

		const { load, transfer } = worker.findLoad();
		const members = listOf(system.entities);
		const packed = load.entities.packedAdded;
		expect(load.entities.added).toEqual([]);
		expect(Array.from(packed?.entityIds ?? [])).toEqual(members.map(entity => entity.eid));
		expect(Array.from(packed?.components.health ?? [])).toEqual(members.map(entity => entity.components.health?.index));
		expect(Array.from(packed?.components.movement ?? [])).toEqual(members.map(entity => entity.components.movement?.index ?? -1));
		expect(members.some(entity => !entity.components.movement)).toEqual(true);
		expect(load.queries.moving.packedAdded?.entityIds.length).toEqual(system.queryEids('moving').length);
		expect(new Set(transfer)).toEqual(new Set([
			packed?.entityIds.buffer,
			packed?.components.health.buffer,
			packed?.components.movement.buffer,
			load.queries.moving.packedAdded?.entityIds.buffer,
			load.queries.moving.packedAdded?.components.movement.buffer,
		]));
	});

	it('rebuilds packed rows in the worker as views over the shared blocks', () => {
		const worker = new RecordingWorker();
		const system = world.addSystem(new QuerySystem(world, {
			required: ['health'],
			optional: ['movement'],
			queries: { moving: { required: ['movement'] } },
			forceMainThread: false,
			getWorker: () => worker as unknown as Worker,
		}));
		void world.load({ entities: ENTITIES });

		let seeded: Array<UpdateEntityConfigObject<ComponentArrays>> = [];
		let seededQueries: EntityQueryComponents<Components> = {};
		const init: NonNullable<EntityUpdateFunction<Components, ComponentArrays>['init']> = (_world, _data, entities, queries) => {
			seeded = entities;
			seededQueries = queries;
		};
		const scope: EntitySystemWorkerScope = { onmessage: null, postMessage: () => {} };
		createEntitySystemWorker<Components, ComponentArrays>(scope, Object.assign(() => {}, { init }));
		scope.onmessage?.(new MessageEvent('message', { data: worker.findLoad().load }));

		const members = listOf(system.entities);
		expect(seeded.map(entity => entity.entityId)).toEqual(members.map(entity => entity.eid));
		seeded.forEach((row, i) => {
			const entity = members[i];
			expect(row.components.health?.byteOffset).toEqual(entity.components.health?.block?.byteOffset);
			expect('movement' in row.components).toEqual(!!entity.components.movement);
		});
		expect(seededQueries.moving.map(entity => entity.entityId)).toEqual(system.queryEids('moving'));

		const block = members[0].components.health?.block;
		if(!block) {
			throw new Error('health block missing');
		}
		block[0] = 1234;
		expect(seeded[0].components.health?.[0]).toEqual(1234);
	});

	it('goes back to per-entity checks once loading finishes', () => {
		const system = world.addSystem(new QuerySystem(world, { required: ['health'] }));
		void world.load({ entities: [{ maxHealth: 10 }] });

		const later = world.loadEntity({ maxHealth: 20 });
		const other = world.loadEntity({ speed: 1 });
		other.loadComponent('health', { maxHealth: 5 });

		expect(eidsOf(system.entities)).toContain(later.eid);
		expect(eidsOf(system.entities)).toContain(other.eid);
	});
});

type LoadMessage = Extract<EntitySystemWorkerMessage, { type: 'load' }>;

function findLoad(calls: Array<Array<unknown>>): LoadMessage {
	const load = calls.map(([message]) => message as EntitySystemWorkerMessage).find(message => message.type === 'load');
	if(load?.type !== 'load') {
		throw new Error('load not posted');
	}
	return load;
}

class RecordingWorker {
	onmessage: ((event: MessageEvent) => void) | null = null;
	onerror: unknown = null;
	onmessageerror: unknown = null;
	posted: Array<{ message: EntitySystemWorkerMessage, transfer: Array<Transferable> }> = [];

	postMessage(message: EntitySystemWorkerMessage, transfer: Array<Transferable> = []): void {
		this.posted.push({ message, transfer });
	}
	terminate(): void {}

	findLoad(): { load: LoadMessage, transfer: Array<Transferable> } {
		const posted = this.posted.find(({ message }) => message.type === 'load');
		if(posted?.message.type !== 'load') {
			throw new Error('load not posted');
		}
		return { load: posted.message, transfer: posted.transfer };
	}
}

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
	constructor(world: TestWorld, query: EntityWorkerSystemQuery<Components> & {
		queries?: { [key: string]: EntityWorkerSystemQuery<Components> }
		forceMainThread?: boolean
		getWorker?: () => Worker
	}) {
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
