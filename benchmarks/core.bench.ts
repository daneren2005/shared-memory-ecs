import { bench, describe } from 'vitest';
import { BaseWorld, EntityWorkerSystem, EntitySystem, System } from '../src/index';
import type { BaseEntity, EntityWorkerSystemCallbacks, EntityWorkerSystemWorld, EntityUpdateFunction } from '../src/index';
import { registry, type Components, type TestWorld } from '../src/__tests__/fixtures/components';

const configuredSizes = process.env.ECS_BENCH_SIZES?.split(',').map(Number).filter(Number.isFinite);
const SIZES = configuredSizes?.length ? configuredSizes : [1_000, 10_000, 100_000];
const BENCH_OPTIONS = { time: 100, iterations: 5, warmupTime: 25, warmupIterations: 2 };

const noopUpdate: EntityUpdateFunction<Components, { health: Int32Array }> = () => {};
const eventUpdate: EntityUpdateFunction<Components, { health: Int32Array }> = (
	_world: EntityWorkerSystemWorld,
	entityId: number,
	_components: { health: Int32Array },
	_queries,
	callbacks: EntityWorkerSystemCallbacks<Components>,
) => {
	callbacks.emitSystemEvent('touched', entityId);
};

class BenchEntityWorkerSystem extends EntityWorkerSystem<Components, { health: Int32Array }> {
	constructor(world: TestWorld, updateFunction = noopUpdate) {
		super(world, {
			name: 'BenchEntityWorkerSystem',
			required: ['health'],
			optional: ['movement'],
			updateFunction,
			forceMainThread: true,
			getWorker: () => {
				throw new Error('benchmark fallback should not construct a worker');
			},
		});
	}
}

class BenchEntitySystem extends EntitySystem<Components> {
	total = 0;

	constructor(world: TestWorld) {
		super(world, {
			name: 'BenchEntitySystem',
			components: ['health'],
			iterationsPerCheck: Number.MAX_SAFE_INTEGER,
			maxMsPerFrame: Number.MAX_SAFE_INTEGER,
		});
	}

	updateEntity(entity: BaseEntity<Components>): void {
		this.total += entity.components.health?.health ?? 0;
	}
}

class BenchDispatchSystem extends System<Components> {
	run(): void {}
}

function populatedWorld(size: number): TestWorld {
	const world = new BaseWorld(registry);
	for(let i = 0; i < size; i++) {
		world.loadEntity({ maxHealth: 100 });
	}
	return world;
}

for(const size of SIZES) {
	describe(`core ECS (${size.toLocaleString()} entities)`, () => {
		let stableWorld: TestWorld;
		let stableSystem: BenchEntityWorkerSystem;
		let iterableWorld: TestWorld;
		let eventWorld: TestWorld;
		let eventSystem: BenchEntityWorkerSystem;
		let dispatchWorld: TestWorld;
		let churnEntities: Array<BaseEntity<Components>>;
		let churnHasMovement = false;
		let initialized = false;

		function initialize() {
			if(initialized) {
				return;
			}
			initialized = true;
			stableWorld = populatedWorld(size);
			stableSystem = stableWorld.addSystem(new BenchEntityWorkerSystem(stableWorld));
			stableSystem.run(0);

			iterableWorld = populatedWorld(size);
			iterableWorld.addSystem(new BenchEntitySystem(iterableWorld));

			eventWorld = populatedWorld(size);
			eventSystem = eventWorld.addSystem(new BenchEntityWorkerSystem(eventWorld, eventUpdate));
			eventSystem.on('touched', () => {});

			dispatchWorld = new BaseWorld(registry);
			for(let i = 0; i < 32; i++) {
				dispatchWorld.addSystem(new BenchDispatchSystem(dispatchWorld, { name: `Dispatch${i}` }));
			}

			churnEntities = Array.from(stableWorld.entities.values()).slice(0, Math.max(1, Math.floor(size / 100)));
		}

		bench('stable EntityWorkerSystem query', () => {
			initialize();
			stableWorld.update(16);
		}, BENCH_OPTIONS);

		bench('1% component membership churn', () => {
			initialize();
			for(const entity of churnEntities) {
				if(churnHasMovement) {
					entity.removeComponent('movement');
				} else {
					entity.loadComponent('movement', { speed: 1 });
				}
			}
			churnHasMovement = !churnHasMovement;
			stableWorld.update(16);
		}, BENCH_OPTIONS);

		bench('EntitySystem iteration', () => {
			initialize();
			iterableWorld.update(16);
		}, BENCH_OPTIONS);

		bench('batched worker-style system events', () => {
			initialize();
			eventWorld.update(16);
		}, BENCH_OPTIONS);

		bench('32-system dispatch', () => {
			initialize();
			dispatchWorld.update(16);
		}, BENCH_OPTIONS);

		bench('1% spawn/despawn burst', () => {
			initialize();
			const spawned: Array<BaseEntity<Components>> = [];
			const count = Math.max(1, Math.floor(size / 100));
			for(let i = 0; i < count; i++) {
				spawned.push(stableWorld.loadEntity({ maxHealth: 100 }));
			}
			for(const entity of spawned) {
				stableWorld.removeEntity(entity);
			}
			stableWorld.update(16);
		}, BENCH_OPTIONS);
	});
}
