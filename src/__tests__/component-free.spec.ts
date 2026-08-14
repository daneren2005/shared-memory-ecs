import { describe, it, expect, vi } from 'vitest';
import { BaseWorld, System, killEntity } from '../index';
import type { ComponentDefinition } from '../index';
import type { ComponentMap } from '../component-definition';
import type MemoryComponent from '../memory-component';

// A component that allocates a second, hook-owned block in load() and releases it in free() — standing in for a
// real SharedList/child-entity a component owns beyond its own backing block. The free hook must not run the
// instant the entity dies (a system could still be mid-run over the memory); it runs at the same deferred point
// the block itself is freed. So the tests assert both timings: nothing frees until the deferred process runs.
interface TrackedComponent {
	index: number
	// The extra block the free hook owns; freeing it is what proves the hook ran against real memory.
	resourceIndex: number
}
interface TrackedConfig {
	tracked: boolean
}

function makeRegistry() {
	// Captured on first load so free() can release its owned block; every entity shares the one MemoryComponent.
	let memoryComponent: MemoryComponent | undefined;
	const free = vi.fn<(component: TrackedComponent) => void>((component) => {
		memoryComponent!.delete(component.resourceIndex);
	});

	const trackedDefinition: ComponentDefinition<TrackedComponent, Int32Array, TrackedConfig> = {
		type: Int32Array,
		size: 1,
		loadProperties: ['tracked'],
		load(entity, memory) {
			memoryComponent = memory;
			const index = memory.create([0]);
			const resourceIndex = memory.create([0]);

			return { index, resourceIndex };
		},
		free,
	};

	// Blocks currently allocated (component block + its hook-owned resource block) — 2 per live tracked entity.
	const blockCount = () => memoryComponent?.length ?? 0;
	return { registry: { tracked: trackedDefinition }, free, blockCount };
}

// A trivial synchronous system so a freed block has something to wait on before it may be reused.
class RunOnceSystem<C extends ComponentMap> extends System<C> {
	runs = 0;
	run(): void {
		this.runs++;
	}
}

describe('component free hook', () => {
	it('is optional — a definition without free tears down fine', () => {
		const plainDefinition: ComponentDefinition<{ index: number }, Int32Array, { plain: boolean }> = {
			type: Int32Array,
			size: 1,
			loadProperties: ['plain'],
			load(entity, memory) {
				const index = memory.create([0]);
				return { index };
			},
		};
		const world = new BaseWorld({ plain: plainDefinition });
		const entity = world.loadEntity({ type: 'x', plain: true });
		expect(() => {
			world.removeEntity(entity);
			world.update(16);
		}).not.toThrow();
	});

	it('defers free on removeComponent until the deferred process runs, then frees its memory', () => {
		const { registry, free, blockCount } = makeRegistry();
		const world = new BaseWorld(registry);
		const system = world.addSystem(new RunOnceSystem(world));
		const entity = world.loadEntity({ type: 'x', tracked: true });
		const component = entity.components.tracked;
		expect(blockCount()).toEqual(2);

		entity.removeComponent('tracked');
		// Component is gone from the entity, but neither the free hook nor the memory has been released yet.
		expect(entity.components.tracked).toBeUndefined();
		expect(free).not.toHaveBeenCalled();
		expect(blockCount()).toEqual(2);

		world.update(16);
		// The system finished a run, so the deferred free now runs the hook and releases both blocks.
		expect(system.runs).toEqual(1);
		expect(free).toHaveBeenCalledTimes(1);
		expect(free).toHaveBeenCalledWith(component);
		expect(blockCount()).toEqual(0);
	});

	it('defers free when the entity is removed from the world', () => {
		const { registry, free, blockCount } = makeRegistry();
		const world = new BaseWorld(registry);
		world.addSystem(new RunOnceSystem(world));
		const entity = world.loadEntity({ type: 'x', tracked: true });

		world.removeEntity(entity);
		expect(free).not.toHaveBeenCalled();
		expect(blockCount()).toEqual(2);

		world.update(16);
		expect(free).toHaveBeenCalledTimes(1);
		expect(blockCount()).toEqual(0);
	});

	it('defers free when the entity is killed', () => {
		const { registry, free, blockCount } = makeRegistry();
		const world = new BaseWorld(registry);
		world.addSystem(new RunOnceSystem(world));
		const entity = world.loadEntity({ type: 'x', tracked: true });

		killEntity(entity);
		expect(free).not.toHaveBeenCalled();
		expect(blockCount()).toEqual(2);

		world.update(16);
		expect(free).toHaveBeenCalledTimes(1);
		expect(blockCount()).toEqual(0);
	});

	it('runs free for every entity dropped on reload (no death event needed)', () => {
		const { registry, free, blockCount } = makeRegistry();
		const world = new BaseWorld(registry);
		world.load({ entities: [{ type: 'x', tracked: true }, { type: 'x', tracked: true }] });
		expect(free).not.toHaveBeenCalled();
		expect(blockCount()).toEqual(4);

		world.load({ entities: [] });
		world.update(16);

		expect(free).toHaveBeenCalledTimes(2);
		expect(blockCount()).toEqual(0);
	});

	it('runs free for every entity on world.clear', async () => {
		const { registry, free, blockCount } = makeRegistry();
		const world = new BaseWorld(registry);
		world.load({ entities: [{ type: 'x', tracked: true }, { type: 'x', tracked: true }] });

		await world.clear();

		expect(free).toHaveBeenCalledTimes(2);
		expect(blockCount()).toEqual(0);
	});
});
