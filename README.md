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
by overriding `addDataToWorld(world)`. Declare its shape with the `W` type parameter (an interface
extending `ComponentSystemWorld`) so both `addDataToWorld` and the `updateFunction` see it typed:

```ts
interface DamageWorld extends ComponentSystemWorld {
	damage: number
}

const damageUpdate: EntityUpdateFunction<Components, { health: Int32Array }, DamageWorld> =
	(world, entityId, components) => { components.health[0] -= world.damage; };

class DamageSystem extends ComponentSystem<Components, { health: Int32Array }, DamageWorld> {
	addDataToWorld(world: DamageWorld) { world.damage = 5; }
}
```

### Reporting back to the main thread

An update function runs on shared memory, so anything it writes is already visible on the main thread. What
it cannot do from there is touch the world, so the things that have to happen back on it go through
`callbacks`: `entityComponentChanged` (emitted on the entity as `component-property-updated`), `entityDied`
(as `death`), and `createEntity`. All of them are collected during the run and applied once it completes.

`emitEntityEvent` is the escape hatch for an event of your own: name it whatever you like and give it
whatever args suit it, and it is emitted on the entity under that name. It exists so a system does not have
to spend one `component-property-updated` per property when the listener only cares about all of them
together - a move that reports `x` and `y` as one `position-updated` is half the events of one per axis:

```ts
// in the update function
callbacks.emitEntityEvent(entityId, 'position-updated', x, y);

// on the main thread
entity.on('position-updated', (x: number, y: number) => { ... });
```

The args are structured-cloned across the worker boundary, so they have to be plain values - no functions,
no class instances. Nothing about the name or the args is checked against your component map, since the
event is the system's own concept rather than a component, so export both alongside the update function that
emits them.

## Measuring performance

`PerformanceTiming` watches a world and reports what running it costs. Hand it the world and it hooks itself
up to the events the world already emits - there is nothing to call per frame and nothing added to the hot
path:

```ts
const timing = new PerformanceTiming(world);
timing.on('stats-updated', (stats: PerformanceStats) => renderDebugPanel(stats));
```

It gathers samples every frame and collapses them into a fresh `timing.stats` snapshot once
`ticksBetweenUpdates` (default `1_000`) worth of elapsed time has gone by, then emits `stats-updated` with it.
The window is measured in whatever unit you drive `world.update` with, so a game running on milliseconds gets
a snapshot a second. Frames the world was paused for are skipped, since it does no work on them.

Every entry is an `{ avg, min, max, samples }` over the window just closed:

- `stats.update` - one whole `world.update` call on the thread the world lives on.
- `stats.systems[]` - per system, in run order: `run` is the run itself on its worker, as the worker measured
  it, and `events` is what handling that run's results (the events it reported onto entities, the entities it
  asked to be created) cost back on the calling thread. A system running on the main-thread fallback never
  reports either, so it sits at zero with `samples: 0` - which is what tells it apart from one that genuinely
  cost nothing.
- `stats.events` - every system's event handling added together. Workers finish on their own schedule rather
  than on a frame boundary, so there is no per-frame combined sample to take; these are the per-system figures
  summed at the end of the window, giving what a run of every system costs the main thread between them.

`getSystemStats(name)` pulls one system out of the latest snapshot, `reset()` throws away everything collected
so far (worth doing after loading a new scene, when the samples either side are not comparable), and
`destroy()` unhooks it from the world.

## Building

```sh
npm install
npm run build      # emits dist/ (js + d.ts)
npm run type-check
```
