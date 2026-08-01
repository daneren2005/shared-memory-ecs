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
  map `C`, so `world.registry`, `entity.components`, `setComponent`, etc. are fully typed. Its entities live
  in `world.entities`, a `Map` keyed by `eid` — see [Iterating entities](#iterating-entities).
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

## Iterating entities

`world.entities` is a `Map` keyed by `eid`, not an array, and so is `entities` on `EntitySystem` and
`ComponentSystem`:

```ts
world.entities.forEach(entity => { ... });   // in the order they were added
world.entities.get(eid);                     // same as world.getEntityByEid(eid)
world.entities.size;
for(const entity of world.entities.values()) { ... }

// For the array methods a Map does not have:
Array.from(world.entities.values()).filter(entity => !!entity.components.health);
```

An entity leaves from anywhere in the middle of that collection — every death is one — and finding it in an
array meant a scan of the whole world, then a shift of everything after it, repeated for each system that
held it as well. A few thousand entities with a few dozen deaths a run made that the most expensive thing the
main thread did on a busy frame; a `Map` deletes in constant time. It also replaced the separate
`entitiesByEid` lookup, so there is only ever one collection to keep straight.

Iteration order is still insertion order, so `load` / `save` round-trip in the order they always did.

## Reading components on a hot path

`entity.components.health!.health` is the way to read a component, and for almost everything it is the right
one: it is typed, it is readable, and one read costs nothing worth measuring.

It is not free, though, and the cost shows up in exactly one situation — reading the same component off
*thousands* of entities, *every frame*. The accessor walks several objects to get there and ends in a getter
closure over the shared block, and because every entity has its own closure those call sites go megamorphic
once enough entities are alive, so none of it inlines. Measured over ~10,000 entities, reading four values per
entity cost **~950ns through the accessors against ~140ns straight off the block** — the difference between
10ms a frame and 1.5ms.

Where that matters, hold the block instead. It is the same memory the accessors read, so nothing changes about
what you get, and it is what the update functions already work on:

```ts
import { TRANSFORM_X_INDEX } from '@daneren2005/shared-memory-physics';

// Resolve once, when whatever is doing the reading is set up.
const health = entity.components.health!;
const block = world.registry.health.memoryComponent.getBlock(health.index) as Int32Array;

// Then per frame, per entity:
block[HEALTH_INDEX];
```

Two things come with that. The block is only valid while the component is: resolve it again if the component
can be removed and re-added, or hang it off something that dies with the entity. And it is indexed rather than
named, so the offsets have to be exported alongside the definition — which is why every component in the
physics library exports its `*_INDEX` constants.

Reach for this when a profile says to, not by default. A menu, a save, a system that touches a dozen entities:
use the accessors.

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

### Reporting something that happens to everything, every run

Every callback above costs an event object per entity: an allocation in the worker, a structured clone of it,
an eid lookup on the main thread, and an emit on that entity. That is fine for a death or a hit, which happen
to a handful of entities a run. It is not fine for a move, which happens to nearly all of them, every run -
at ten thousand entities that is ten thousand objects and ten thousand emits a frame, and it can easily cost
more than the simulation it is reporting.

`emitSystemEvent` is the version of that with everything avoidable taken out. Name the event and give it an
entity id; the whole run arrives on the **system** as one call with one array of ids:

```ts
// in the update function - just the id, once per entity that moved
callbacks.emitSystemEvent('position-updated', entityId);

// on the main thread - one call for the run, however many entities are in it
system.on('position-updated', (entityIds: Array<number>) => {
	for(const eid of entityIds) {
		const sprite = sprites.get(eid);
		// The worker wrote the position into shared memory, so it is already here to read.
		if(sprite) {
			const transform = world.getEntityByEid(eid)?.components.transform;
			...
		}
	}
});
```

Nothing travels with the id on purpose. The blocks the update just wrote are shared memory, so the main
thread already holds the values - sending them along would only pay to copy what is already there. Reach for
`emitEntityEvent` when the thing you want to report is *not* in a component block, and for this when it is.

System events are dispatched before the per-entity events of the same run, so an entity a run both moved and
killed is still in the world when its move is reported.

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
