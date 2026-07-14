# @daneren2005/shared-memory-ecs

A small, reusable Entity / Component / System core backed by shared memory
([`@daneren2005/shared-memory-objects`](https://www.npmjs.com/package/@daneren2005/shared-memory-objects)).
It contains only the engine-agnostic parts of the ECS - no game specific concepts (factions, terrain,
fog of war, sub-classed entities, required components, etc).

## Concepts

- **Component** – a plain object with an `index` (its block inside a shared-memory pool) plus getters/
  setters over that memory. Games decide what components exist.
- **`ComponentDefinition`** – describes a component: its typed array `type`, block `size`, the config keys
  that trigger loading (`loadProperties`), a `load(entity, memory, config)` and an optional `save(component)`.
  A component's data splits into `Config` (defining props supplied up front, e.g. `maxHealth`) and
  `Serialization` (runtime-derived state, e.g. current `health`); `load` sees `Config & Serialization` while
  `save` returns only the `Serialization` slice.
- **`ComponentRegistry<C>`** – the map of all component definitions for a game.
- **`EntityFactory<C>`** – maps an entity `type` name to a base (template) config. Loading an entity layers
  the caller's config over its type's template, so shared static data lives in one place and a save only
  needs the `type` plus the entity's serialization. `BaseWorld#loadEntity` always goes through the factory.
- **`BaseWorld<C>`** – builds one `MemoryComponent` per registered component (attached to that component's
  definition as `world.registry[name].memoryComponent`) and runs systems. It is generic over your component
  map `C`, so `world.registry`, `entity.components`, `setComponent`, etc. are fully typed.
- **`BaseEntity<C>`** – an `eid`, an optional `id`, and a bag of memory-backed components. It has no
  direct property accessors and only loads/saves component data. Every entity has an `entity` component
  whose `type` (a plain, worker-invisible string) records the factory template it was built from.
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

// `maxHealth` is the defining Config prop; `health` is optional, runtime-derived Serialization.  `load`
// and `save` both see the combined `{ maxHealth: number, health?: number }`.
const healthDefinition: ComponentDefinition<HealthComponent, Int32Array, { maxHealth: number }, { health?: number }> = {
	type: Int32Array,
	size: 2,
	// Configs are flat and shared: this component loads whenever `maxHealth` is present, then reads what it
	// needs off the same config object.  Only Config props may appear here.
	loadProperties: ['maxHealth'],
	load(entity, memoryComponent, config) {
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
		// save returns only Serialization; maxHealth is Config and comes back from the template on reload.
		return { health: component.health };
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

const entity = world.loadEntity({ maxHealth: 100 });
entity.components.health!.health -= 10;

console.log(entity.save()); // { health: 90 }
```

### Entity types via the factory

Register per-type base configs, then load entities by `type`.  The template supplies the defining config, so
only the `type` and runtime serialization need to be saved:

```ts
import { BaseWorld, EntityFactory } from '@daneren2005/shared-memory-ecs';

const factory = new EntityFactory<Components>({
	goblin: { maxHealth: 20 },
});
const world = new BaseWorld<Components>(registry, { factory });

const goblin = world.loadEntity({ type: 'goblin', health: 10 });
console.log(goblin.components.health!.maxHealth); // 20 (from the template)
console.log(goblin.save()); // { type: 'goblin', health: 10 } - no templated maxHealth

// A save re-expands back through the factory:
world.loadEntity(goblin.save());
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
