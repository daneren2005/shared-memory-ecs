import { System } from '../../index';
import { createTestWorld, type Components, type TestWorld } from '../../__tests__/fixtures/components';
import { runWorld } from '../../__tests__/fixtures/run-world';

describe('system', () => {
	it('run with no deltaBetweenRuns', () => {
		let world = createTestWorld();
		let system = new BasicSystem(world);

		system.update(50);
		expect(system.age).toEqual(50);
		system.update(50);
		expect(system.age).toEqual(100);
		system.update(500);
		expect(system.age).toEqual(600);
	});

	it('with deltaBetweenRuns: 500 and default firstRun', () => {
		let world = createTestWorld();
		let system = new BasicSystem(world, {
			deltaBetweenRuns: 500,
		});

		system.update(50);
		expect(system.age).toEqual(0);
		system.update(50);
		expect(system.age).toEqual(0);
		system.update(500);
		expect(system.age).toEqual(500);
		system.update(500);
		expect(system.age).toEqual(1_000);
		system.update(2_000);
		expect(system.age).toEqual(3_000);
		system.update(2_050);
		expect(system.age).toEqual(5_000);
	});
	it('with deltaBetweenRuns: 500 and firstRun: true', () => {
		let world = createTestWorld();
		let system = new BasicSystem(world, {
			deltaBetweenRuns: 500,
			firstRun: true,
		});

		system.update(50);
		expect(system.age).toEqual(0);
		system.update(50);
		expect(system.age).toEqual(0);
		system.update(500);
		expect(system.age).toEqual(500);
		system.update(500);
		expect(system.age).toEqual(1_000);
		system.update(2_000);
		expect(system.age).toEqual(3_000);
	});

	it('run inside of world', () => {
		let world = createTestWorld();
		let system = new BasicSystem(world, {
			deltaBetweenRuns: 500,
		});
		world.addSystem(system);

		runWorld(world, 50);
		expect(system.age).toEqual(0);
		runWorld(world, 50);
		expect(system.age).toEqual(0);
		runWorld(world, 500);
		expect(system.age).toEqual(500);
	});
});

class BasicSystem extends System<Components> {
	public age: number = 0;

	constructor(world: TestWorld, options: Partial<{ deltaBetweenRuns: number, firstRun: boolean }> = {}) {
		super(world, {
			name: 'BasicSystem',
			...options,
		});
	}

	run(elapsedMs: number) {
		this.age += elapsedMs;
	}
}
