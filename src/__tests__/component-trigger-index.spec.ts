import ComponentTriggerIndex from '../component-trigger-index';
import { BaseWorld, Component } from '../index';
import type { ComponentDefinition } from '../index';

const index = new ComponentTriggerIndex({
	first: { loadProperties: ['a', 'b'] },
	entity: { loadProperties: ['type'] },
	second: { loadProperties: ['b'] },
	later: { loadProperties: ['b', 'c'], loadInFinishLoading: true },
	third: { loadProperties: ['d'] },
});
const names = (triggers: ReadonlyArray<{ name: string }>) => triggers.map(trigger => trigger.name);

class MarkerComponent extends Component<Int32Array> {}

describe('ComponentTriggerIndex', () => {
	it('returns hits in registry order whatever the config key order', () => {
		expect(names(index.forLoad({ d: 1, b: 1 }))).toEqual(['first', 'second', 'third']);
	});

	it('returns a component once when several of its properties are present', () => {
		expect(names(index.forLoad({ a: 1, b: 1 }))).toEqual(['first', 'second']);
	});

	it('matches keys the way `in` does', () => {
		expect(names(index.forLoad({ a: undefined }))).toEqual(['first']);
		expect(names(index.forLoad(Object.create({ a: 1 }) as object))).toEqual(['first']);
	});

	it('ignores unclaimed keys and object prototype members', () => {
		expect(index.forLoad({ bogus: 1 })).toEqual([]);
		expect(index.forLoad({})).toEqual([]);
	});

	it('keeps deferred components out of load and immediate ones out of finishLoading', () => {
		expect(names(index.forLoad({ c: 1 }))).toEqual([]);
		expect(names(index.forFinishLoading({ b: 1, c: 1 }))).toEqual(['later']);
	});

	it('never triggers the entity component', () => {
		expect(index.forLoad({ type: 'goblin' })).toEqual([]);
	});

	it('finds nothing when no component is deferred', () => {
		const immediateOnly = new ComponentTriggerIndex({ first: { loadProperties: ['a'] } });
		expect(immediateOnly.forFinishLoading({ a: 1 })).toEqual([]);
	});

	it('loads an entity\'s components in registry order', () => {
		const loaded: Array<string> = [];
		const definition = (name: string, prop: string): ComponentDefinition<MarkerComponent, Int32Array> => ({
			type: Int32Array,
			size: 1,
			loadProperties: [prop],
			toBlock: () => [0],
			attach(entity, memory, blockIndex) {
				loaded.push(name);
				return new MarkerComponent(memory.getBlock(blockIndex), blockIndex);
			},
		});
		const world = new BaseWorld({ zebra: definition('zebra', 'z'), apple: definition('apple', 'a') });

		world.loadEntity({ a: 1, z: 1 });

		expect(loaded).toEqual(['zebra', 'apple']);
	});
});
