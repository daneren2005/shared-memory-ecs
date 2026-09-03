import { describe, it, expect, vi } from 'vitest';
import { BaseWorld, killEntity } from '../index';
import type { ComponentDefinition, SystemError } from '../index';

// A position component whose `died` hook reads the dying entity's coordinates — proving the block is still live and
// readable at death — and can spawn a "drop" entity at that position (the real use case: loot on death).
interface PositionComponent {
	index: number
	x: number
	y: number
}
interface PositionConfig {
	x: number
	y: number
}

function makeRegistry() {
	const died = vi.fn<(component: PositionComponent, entity: any, world: any) => void>();
	const positionDefinition: ComponentDefinition<PositionComponent, Int32Array, PositionConfig> = {
		type: Int32Array,
		size: 2,
		loadProperties: ['x'],
		toBlock(config) {
			return [config.x, config.y];
		},
		attach(entity, memory, index) {
			const block = memory.getBlock(index);
			return {
				index,
				block,
				get x() {
					return block[0];
				},
				set x(value: number) {
					block[0] = value;
				},
				get y() {
					return block[1];
				},
				set y(value: number) {
					block[1] = value;
				},
			};
		},
		died,
	};

	// A second component with no died hook, present to prove only definitions that define died are called.
	const tagDefinition: ComponentDefinition<{ index: number }, Int32Array, { tag: boolean }> = {
		type: Int32Array,
		size: 1,
		loadProperties: ['tag'],
		toBlock() {
			return [0];
		},
		attach(entity, memory, index) {
			return { index };
		},
	};

	return { registry: { position: positionDefinition, tag: tagDefinition }, died };
}

describe('death hooks', () => {
	it('fires died once with a readable block when the entity is killed', () => {
		const { registry, died } = makeRegistry();
		const world = new BaseWorld(registry);
		const entity = world.loadEntity({ type: 'x', x: 7, y: 9, tag: true });

		// The hook must see the live position, and receive the entity + world.
		died.mockImplementation((component, deadEntity, hookWorld) => {
			expect(component.x).toEqual(7);
			expect(component.y).toEqual(9);
			expect(deadEntity).toBe(entity);
			expect(hookWorld).toBe(world);
		});

		killEntity(entity);
		expect(died).toHaveBeenCalledTimes(1);
		expect(world.entities.has(entity.eid)).toEqual(false);
	});

	it('emits an entity-died world event before the entity is removed', () => {
		const { registry } = makeRegistry();
		const world = new BaseWorld(registry);
		const entity = world.loadEntity({ type: 'x', x: 1, y: 2 });

		let seenWhileStillPresent = false;
		world.on('entity-died', (dead) => {
			seenWhileStillPresent = world.entities.get(dead.eid) === dead;
		});

		killEntity(entity);
		expect(seenWhileStillPresent).toEqual(true);
		expect(world.entities.has(entity.eid)).toEqual(false);
	});

	it('does not fire died on world.load() teardown', () => {
		const { registry, died } = makeRegistry();
		const world = new BaseWorld(registry);
		world.load({ entities: [{ type: 'x', x: 1, y: 2 }, { type: 'x', x: 3, y: 4 }] });

		// Reloading removes the old entities, but that is not a death.
		world.load({ entities: [] });
		expect(died).not.toHaveBeenCalled();
	});

	it('fires died exactly once when the same entity dies twice in one run', () => {
		const { registry, died } = makeRegistry();
		const world = new BaseWorld(registry);
		const entity = world.loadEntity({ type: 'x', x: 1, y: 2 });

		// Two projectiles killing one target: the second death is a no-op.
		entity.emit('death');
		entity.emit('death');
		expect(died).toHaveBeenCalledTimes(1);
	});

	it('surfaces a system-error and still removes the entity when a died hook throws', () => {
		const { registry, died } = makeRegistry();
		const world = new BaseWorld(registry);
		const errors: Array<SystemError> = [];
		world.on('system-error', (error: SystemError) => errors.push(error));

		died.mockImplementation(() => {
			throw new Error('boom');
		});
		const entity = world.loadEntity({ type: 'x', x: 1, y: 2 });

		expect(() => killEntity(entity)).not.toThrow();
		expect(errors).toHaveLength(1);
		expect(errors[0].phase).toEqual('died');
		expect(errors[0].entityId).toEqual(entity.eid);
		expect(errors[0].error.message).toEqual('boom');
		expect(world.entities.has(entity.eid)).toEqual(false);
	});

	it('lets a died hook spawn a new entity at the dying entity position', () => {
		const { registry, died } = makeRegistry();
		const world = new BaseWorld(registry);
		died.mockImplementation((component, _entity, hookWorld) => {
			hookWorld.loadEntity({ type: 'drop', x: component.x, y: component.y });
		});

		const entity = world.loadEntity({ type: 'x', x: 5, y: 6 });
		killEntity(entity);

		const remaining = Array.from(world.entities.values());
		expect(remaining).toHaveLength(1);
		expect(remaining[0].components.position?.x).toEqual(5);
		expect(remaining[0].components.position?.y).toEqual(6);
	});
});
