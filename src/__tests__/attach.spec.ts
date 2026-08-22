import { BaseWorld } from '../index';
import type { ComponentDefinition, WorkerCreatedEntity } from '../index';

// A component built from the two-halves contract: toBlock (config → block values, worker-safe) + attach (accessor
// over an existing block). It dereferences a nested config in toBlock (like the game's `weapon.range`) - fine,
// because adoption never calls toBlock, only attach.
interface ShieldComponent {
	index: number
	strength: number
}
interface ShieldConfig {
	shield: { strength: number }
}
const shieldDefinition: ComponentDefinition<ShieldComponent, Float32Array, ShieldConfig> = {
	type: Float32Array,
	size: 1,
	loadProperties: ['shield'],
	toBlock(config) {
		return [config.shield.strength];
	},
	attach(entity, memory, index) {
		const block = memory.getBlock(index);
		return {
			index,
			get strength() {
				return block[0];
			},
			set strength(value: number) {
				block[0] = value;
			},
		};
	},
};

describe('two-halves component contract (toBlock + attach)', () => {
	it('loadComponent builds a block from toBlock then wraps it with attach', () => {
		const world = new BaseWorld({ shield: shieldDefinition });
		const entity = world.loadEntity({ type: 'ship', shield: { strength: 7 } });

		expect(entity.components.shield?.strength).toEqual(7);
	});

	it('adoptEntity wraps a worker-written block with attach - no config, no toBlock', () => {
		const world = new BaseWorld({ shield: shieldDefinition });
		// Stand in for the block a worker allocated + wrote.
		const index = world.registry.shield.memoryComponent.create([42]);
		const descriptor: WorkerCreatedEntity = { eid: 999, type: 'ship', components: { shield: index } };

		const entity = world.adoptEntity(descriptor);

		expect(entity.eid).toEqual(999);
		expect(entity.components.shield?.strength).toEqual(42);
	});

	it('caches the block view on the component so query building reuses it instead of re-fetching', () => {
		const world = new BaseWorld({ shield: shieldDefinition });
		const loaded = world.loadEntity({ type: 'ship', shield: { strength: 7 } });
		const index = world.registry.shield.memoryComponent.create([42]);
		const adopted = world.adoptEntity({ eid: 999, type: 'ship', components: { shield: index } });

		// Both load and adopt stamp block, and it points at the live backing memory (a write through the block shows
		// up on the accessor).
		for(const entity of [loaded, adopted]) {
			const block = entity.components.shield?.block;
			expect(block).toBeInstanceOf(Float32Array);
			block![0] = 100;
			expect(entity.components.shield?.strength).toEqual(100);
		}
	});
});
