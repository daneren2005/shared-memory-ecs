import { ComponentSystem } from '../../src';
import type { BaseEntity, BaseWorld, ComponentSystemQuery } from '../../src';
import { createTestWorld, type Components } from '../fixtures/components';

interface StubOptions {
	required: Array<keyof Components>
	not?: Array<keyof Components>
	queries?: { [key: string]: ComponentSystemQuery<Components> }
}

describe('component-system', () => {
	let world: BaseWorld<Components>;
	beforeEach(() => {
		world = createTestWorld();
	});

	it('with single component', () => {
		let system = new StubSystem(world, { required: ['health'] });
		world.addSystem(system);

		let entity1 = createEntity({ health: { maxHealth: 100 }, movement: { speed: 100 } });
		let entity2 = createEntity({ health: { maxHealth: 100 } });
		createEntity({ movement: { speed: 100 } });
		expect(system.entities.map(e => e.eid)).toEqual([entity1.eid, entity2.eid]);
	});

	it('with multiple component', () => {
		let system = new StubSystem(world, { required: ['health', 'movement'] });
		world.addSystem(system);

		let entity1 = createEntity({ health: { maxHealth: 100 }, movement: { speed: 100 } });
		createEntity({ health: { maxHealth: 100 } });
		createEntity({ movement: { speed: 100 } });
		expect(system.entities.map(e => e.eid)).toEqual([entity1.eid]);
	});

	it('with not components', () => {
		let system = new StubSystem(world, { required: ['health'], not: ['movement'] });
		world.addSystem(system);

		createEntity({ health: { maxHealth: 100 }, movement: { speed: 100 } });
		let entity2 = createEntity({ health: { maxHealth: 100 } });
		createEntity({ movement: { speed: 100 } });
		expect(system.entities.map(e => e.eid)).toEqual([entity2.eid]);
	});

	it('with dynamically added components in required list', () => {
		let system = new StubSystem(world, { required: ['health', 'movement'] });
		world.addSystem(system);

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
		let system = new StubSystem(world, { required: ['health'], not: ['movement'] });
		world.addSystem(system);

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
		let system = new StubSystem(world, {
			required: ['health'],
			queries: {
				onlyMovement: {
					required: ['movement'],
				},
			},
		});
		world.addSystem(system);

		let movingEntity = createEntity({ health: { maxHealth: 100 }, movement: { speed: 100 } });
		createEntity({ health: { maxHealth: 100 } });

		expect(system.getQueryEntityEids('onlyMovement')).toEqual([movingEntity.eid]);
	});

	it('query entity list updates when required query component is added/removed', () => {
		let system = new StubSystem(world, {
			required: ['health'],
			queries: {
				onlyMovement: {
					required: ['movement'],
				},
			},
		});
		world.addSystem(system);

		let movingEntity = createEntity({ health: { maxHealth: 100 }, movement: { speed: 100 } });
		let staticEntity = createEntity({ health: { maxHealth: 100 } });

		expect(system.getQueryEntityEids('onlyMovement')).toEqual([movingEntity.eid]);

		staticEntity.loadComponent('movement', { speed: 100 });
		expect(system.getQueryEntityEids('onlyMovement')).toEqual([movingEntity.eid, staticEntity.eid]);

		staticEntity.removeComponent('movement');
		expect(system.getQueryEntityEids('onlyMovement')).toEqual([movingEntity.eid]);
	});

	it('query entity list updates when not query component is added/removed', () => {
		let system = new StubSystem(world, {
			required: ['health'],
			queries: {
				noMovement: {
					required: ['health'],
					not: ['movement'],
				},
			},
		});
		world.addSystem(system);

		createEntity({ health: { maxHealth: 100 }, movement: { speed: 100 } });
		let staticEntity = createEntity({ health: { maxHealth: 100 } });

		expect(system.getQueryEntityEids('noMovement')).toEqual([staticEntity.eid]);

		staticEntity.loadComponent('movement', { speed: 100 });
		expect(system.getQueryEntityEids('noMovement')).toEqual([]);

		staticEntity.removeComponent('movement');
		expect(system.getQueryEntityEids('noMovement')).toEqual([staticEntity.eid]);
	});

	it('removing an entity adds its eid to removedEntityBuffer', () => {
		let system = new StubSystem(world, { required: ['health'] });
		world.addSystem(system);

		let entity = createEntity({ health: { maxHealth: 100 } });
		expect(system.getRemovedEntityBuffer()).toEqual([]);

		world.removeEntity(entity);

		expect(system.getRemovedEntityBuffer()).toContain(entity.eid);
	});

	function createEntity(config: any): BaseEntity<Components> {
		return world.loadEntity(config);
	}
});

class StubSystem extends ComponentSystem<Components> {
	constructor(world: BaseWorld<Components>, options: StubOptions) {
		super(world, {
			name: 'StubSystem',
			updateFunction: () => {},
			getWorker: () => {
				throw new Error('workers are not used in tests');
			},
			forceMainThread: true,

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
