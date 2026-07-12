# @daneren2005/shared-memory-ecs

A small, reusable Entity / Component / System core backed by shared memory
([`@daneren2005/shared-memory-objects`](https://www.npmjs.com/package/@daneren2005/shared-memory-objects)).
It contains only the engine-agnostic parts of the ECS - no game specific concepts (factions, terrain,
fog of war, sub-classed entities, required components, etc).

## Concepts

- **Component** – a plain object with an `index` (its block inside a shared-memory pool) plus getters/
  setters over that memory. Games decide what components exist.
- **`ComponentDefinition`** – describes a component: its typed array `type`, block `size`, a `load(entity, memory, config)`
  and an optional `save(component)`.
- **`ComponentRegistry<C>`** – the map of all component definitions for a game.
- **`BaseWorld<C>`** – builds one `MemoryComponent` per registered component and runs systems. It is
  generic over your component map `C`, so `world.components`, `entity.components`, `setComponent`, etc.
  are fully typed.
- **`BaseEntity<C>`** – an `eid`, an optional `id`, and a bag of memory-backed components. It has no
  direct property accessors and only loads/saves component data.
- **Systems** – `System`, `IterableSystem`, `EntitySystem` (main-thread iteration over entities with a
  given set of components) and `ComponentSystem` (runs an update function over raw memory blocks,
  off-thread when Web Workers + `SharedArrayBuffer` are available).

## Defining components

```ts
import type { ComponentDefinition } from '@daneren2005/shared-memory-ecs';

interface HealthComponent {
	index: number
	health: number
	maxHealth: number
}

const HEALTH_INDEX = 0;
const HEALTH_MAX_INDEX = 1;

const healthDefinition: ComponentDefinition<HealthComponent, Int32Array> = {
	type: Int32Array,
	size: 2,
	load(entity, memoryComponent, config: { health?: number, maxHealth: number }) {
		const index = memoryComponent.create([config.health ?? config.maxHealth, config.maxHealth]);
		const memory = memoryComponent.getBlock(index);

		return {
			index,
			get health() { return memory[HEALTH_INDEX]; },
			set health(value: number) { memory[HEALTH_INDEX] = value; },
			get maxHealth() { return memory[HEALTH_MAX_INDEX]; }
		};
	},
	save(component) {
		return { maxHealth: component.maxHealth, health: component.health };
	}
};

// One place defines the whole registry + the component map type it implies.
const registry = {
	health: healthDefinition
	// ...other component definitions
};
type Components = { [K in keyof typeof registry]: ReturnType<(typeof registry)[K]['load']> };
```

## Using the world

```ts
import { BaseWorld } from '@daneren2005/shared-memory-ecs';

const world = new BaseWorld<Components>(registry);

const entity = world.loadEntity({ health: { maxHealth: 100 } });
entity.components.health!.health -= 10;

console.log(entity.save()); // { health: { maxHealth: 100, health: 90 } }
```

## ComponentSystem workers

`ComponentSystem` needs a `getWorker()` that returns a real `Worker`, and an `updateFunction`. Your
worker entry file calls `createComponentWorker(self, updateFunction)`. When Web Workers or
`SharedArrayBuffer` are unavailable it transparently falls back to running the same update function on
the main thread. Attach any extra per-run data (the equivalent of the old faction/fog-of-war fields)
by overriding `addDataToWorld(world)`.

## Building

```sh
npm install
npm run build      # emits dist/ (js + d.ts)
npm run type-check
```
