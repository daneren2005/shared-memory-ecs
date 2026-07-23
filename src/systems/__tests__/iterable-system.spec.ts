import { IterableSystem } from '../../index';
import { createTestWorld, type Components } from '../../__tests__/fixtures/components';
import { runWorld } from '../../__tests__/fixtures/run-world';

describe('iterable-system', () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it('basic run', () => {
		let system = new BasicSystem(createIterables(5));

		system.update(50);
		system.iterables.forEach(i => expect(i.age).toEqual(50));
		system.update(50);
		system.iterables.forEach(i => expect(i.age).toEqual(100));
		system.update(500);
		system.iterables.forEach(i => expect(i.age).toEqual(600));
	});

	it('run across 2 updates', () => {
		let system = new BasicSystem(createIterables(5), {
			iterationsPerCheck: 1,
		}, {
			timeDelayPerIteration: 3,
		});

		system.update(100);
		expect(system.iterables.map(i => i.age)).toEqual([100, 100, 100, 100, 0]);
		system.update(100);
		expect(system.iterables.map(i => i.age)).toEqual([100, 100, 100, 100, 100]);
		system.update(100);
		expect(system.iterables.map(i => i.age)).toEqual([300, 300, 300, 300, 100]);
		system.update(100);
		expect(system.iterables.map(i => i.age)).toEqual([300, 300, 300, 300, 300]);
	});

	it('run across 2 updates with deltaBetweenRuns', () => {
		let system = new BasicSystem(createIterables(5), {
			iterationsPerCheck: 1,
			deltaBetweenRuns: 200,
		}, {
			timeDelayPerIteration: 3,
		});

		system.update(100);
		expect(system.iterables.map(i => i.age)).toEqual([0, 0, 0, 0, 0]);
		system.update(100);
		expect(system.iterables.map(i => i.age)).toEqual([200, 200, 200, 200, 0]);
		system.update(100);
		expect(system.iterables.map(i => i.age)).toEqual([200, 200, 200, 200, 200]);
		system.update(100);
		expect(system.iterables.map(i => i.age)).toEqual([400, 400, 400, 400, 200]);
		system.update(100);
		expect(system.iterables.map(i => i.age)).toEqual([400, 400, 400, 400, 400]);
	});

	it('run across many updates with deltaBetweenRuns', () => {
		let system = new BasicSystem(createIterables(7), {
			iterationsPerCheck: 1,
			deltaBetweenRuns: 200,
			maxMsPerFrame: 3,
		}, {
			timeDelayPerIteration: 2,
		});

		system.update(200);
		expect(system.iterables.map(i => i.age)).toEqual([200, 200, 0, 0, 0, 0, 0]);
		system.update(100);
		expect(system.iterables.map(i => i.age)).toEqual([200, 200, 200, 200, 0, 0, 0]);
		system.update(100);
		expect(system.iterables.map(i => i.age)).toEqual([200, 200, 200, 200, 200, 200, 0]);
		system.update(100);
		expect(system.iterables.map(i => i.age)).toEqual([200, 200, 200, 200, 200, 200, 200]);
		// Make sure when we restart we kept track of the fact that we missed multiple starts!
		system.update(100);
		expect(system.iterables.map(i => i.age)).toEqual([600, 600, 200, 200, 200, 200, 200]);
	});

	it('run inside world', () => {
		let system = new BasicSystem(createIterables(7), {
			iterationsPerCheck: 1,
			deltaBetweenRuns: 200,
			maxMsPerFrame: 3,
		}, {
			timeDelayPerIteration: 2,
		});

		runWorld(system.world, 900);
		system.iterables.forEach(i => expect(i.age).toEqual(800));
	});
});

class BasicSystem extends IterableSystem<Components, Iterable> {
	public iterables: Array<Iterable> = [];
	private testOptions: TestOptions;

	constructor(iterables: Array<Iterable>, systemOptions: Partial<{ iterationsPerCheck: number, deltaBetweenRuns: number, maxMsPerFrame: number }> = {}, testOptions: TestOptions = {}) {
		const world = createTestWorld();
		super(world, {
			name: 'BasicSystem',
			...systemOptions,
		});
		world.systems = [this];

		this.iterables = iterables;
		this.testOptions = testOptions;
	}

	getIterables() {
		return this.iterables;
	}
	updateIterable(iterable: Iterable, elapsedTime: number): void {
		iterable.age += elapsedTime;

		if(this.testOptions.timeDelayPerIteration) {
			vi.advanceTimersByTime(this.testOptions.timeDelayPerIteration);
		}
	}
}

interface Iterable {
	age: number
}
interface TestOptions {
	timeDelayPerIteration?: number
}

function createIterables(length: number) {
	return Array.from({ length }).map(() => ({
		age: 0,
	}));
}
