import type { EntityUpdateFunction } from '../../index';
import type { ComponentArrays, Components } from './components';

// Allocates a large batch of health blocks directly in the worker's shared pool - enough to grow the heap - so the
// worker-side allocation + worker→main buffer-growth propagation can be exercised end-to-end. Each block stores its
// own pool index as a sentinel so the main thread can verify it reads back a value the worker wrote into a grown
// buffer. The test drives a single update so the batch runs once.
export const GROW_COUNT = 5_000;

export const growUpdate: EntityUpdateFunction<Components, Pick<ComponentArrays, 'health'>> = (world) => {
	if(!world.allocate) {
		return;
	}

	for(let i = 0; i < GROW_COUNT; i++) {
		world.allocate.allocateComponentBlock('health', [i, i]);
	}
};
