# @daneren2005/shared-memory-ecs

A small, reusable Entity / Component / System core backed by shared memory
([`@daneren2005/shared-memory-objects`](https://www.npmjs.com/package/@daneren2005/shared-memory-objects)).
It contains only the engine-agnostic parts of the ECS - no game specific concepts (factions, terrain,
fog of war, sub-classed entities, required components, etc).

## Concepts

- **Component** – a plain object with an `index` (its block inside a shared-memory pool) plus getters/
  setters over that memory. Games decide what components exist.
- **`ComponentDefinition`** – describes a component: its typed array `type`, block `size`, the config keys
  that trigger loading (`loadProperties`), and the two halves that build it — `toBlock(config)` (maps the
  config to the raw block values) and `attach(entity, memory, index)` (builds the accessor over that block).
  Loading a component is `attach(entity, memory, memory.create(toBlock(config)))`; splitting it this way lets a
  worker build the block off-thread (it calls only `toBlock`) and the main thread wrap it (`attach`) when it
  adopts the entity. Plus an optional `save(component)` and `free(component)`. A component's data splits into
  `Config` (defining props supplied up front, e.g. `maxHealth`) and `Serialization` (runtime-derived state,
  e.g. current `health`); `toBlock` sees `Config & Serialization` while `save` returns only the `Serialization`
  slice. `free` runs when the component is torn down (see [Freeing extra resources](#freeing-extra-resources)).
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
import { Component } from '@daneren2005/shared-memory-ecs';
import type { ComponentDefinition } from '@daneren2005/shared-memory-ecs';

interface HealthComponent {
	index: number
	health: number
	maxHealth: number
}

const HEALTH_INDEX = 0;
const HEALTH_MAX_INDEX = 1;

// The accessor is a subclass of `Component`, so its get/set live on one shared prototype: reading a component off
// thousands of entities stays monomorphic and inline, and each instance is a single allocation rather than a
// closure per accessor. Index `this.block` (the typed-array view, set for you) by the exported *_INDEX constants.
class Health extends Component<Int32Array> implements HealthComponent {
	get health() { return this.block[HEALTH_INDEX]; }
	set health(value: number) { this.block[HEALTH_INDEX] = value; }
	get maxHealth() { return this.block[HEALTH_MAX_INDEX]; }
}

// `maxHealth` is the defining Config prop; `health` is optional, runtime-derived Serialization.  `toBlock`
// and `save` both see the combined `{ maxHealth: number, health?: number }`.
const healthDefinition: ComponentDefinition<HealthComponent, Int32Array, { maxHealth: number }, { health?: number }> = {
	type: Int32Array,
	size: 2,
	// Configs are flat and shared: this component loads whenever `maxHealth` is present, then reads what it
	// needs off the same config object.  Only Config props may appear here.
	loadProperties: ['maxHealth'],
	// The block values, purely from config — so a worker can build the block off-thread. No entity/world access.
	toBlock(config) {
		return [config.health ?? config.maxHealth, config.maxHealth];
	},
	// The accessor over an already-allocated block. Runs on the main thread both when loading and when adopting a
	// worker-built entity; a component's own extra allocations (a SharedList, a resource block) go here — a
	// subclass that owns extra memory takes more constructor args (the entity, another pool) and stores them.
	attach(entity, memoryComponent, index) {
		return new Health(memoryComponent.getBlock(index), index);
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
type Components = { [K in keyof typeof registry]: ReturnType<(typeof registry)[K]['attach']> };
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

An entity's `type` lives in shared memory (worker-visible), not as a plain field. Each distinct type string is
interned once as an immutable `ConstantString` in the heap — 15 `"Space Ship"` entities share one allocation —
and the `entity` block stores only a pointer to it at `TYPE_INDEX`. Reading `entity.components.entity.type`
resolves that pointer back to the string through the world's cache; a worker can do the same (see
[Reading an entity's type in a worker](#reading-an-entitys-type-in-a-worker)).

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
call over the shared block. `Component`-subclass accessors are prototype getters (all instances of a type share
one hidden class, so those reads stay monomorphic and inline — unlike the old per-entity closures, which went
megamorphic), but a getter call plus the property walk still loses to a raw indexed read in the very tightest
per-frame loops.

Where that matters, hold the block instead. It is the same memory the accessors read, so nothing changes about
what you get, and it is what the update functions already work on:

```ts
import { TRANSFORM_X_INDEX } from '@daneren2005/shared-memory-physics';

// Resolve once, when whatever is doing the reading is set up. The component caches its view on `.block` when it
// is attached, so read that rather than paying for another getBlock (each call allocates a fresh subarray).
const block = entity.components.health!.block as Int32Array;

// Then per frame, per entity:
block[HEALTH_INDEX];
```

Two things come with that. The block is only valid while the component is: re-read `.block` if the component
can be removed and re-added, or hang it off something that dies with the entity. And it is indexed rather than
named, so the offsets have to be exported alongside the definition — which is why every component in the
physics library exports its `*_INDEX` constants.

Reach for this when a profile says to, not by default. A menu, a save, a system that touches a dozen entities:
use the accessors.

## ComponentSystem workers

`ComponentSystem` needs a `getWorker()` that returns a real `Worker`, and an `updateFunction`. Your
worker entry file calls `createComponentWorker(self, updateFunction)`, importing it from the
[`/worker` subpath](#importing-in-workers) so the worker bundle stays small. When Web Workers or
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

### Update-function hooks: `init` and `preRun`

`addDataToWorld` runs on the main thread and re-sends its data every run. When the data instead needs to
*live in the worker* — computed once, or too big to ship each frame — attach hooks to the update function
itself. Both are optional properties on the `EntityUpdateFunction`.

**`init`** runs on `system.finishLoading()` — once at startup (`world.init()` calls it), and again on each
`world.load()` so a reused world re-seeds its workers. It receives whatever the system's `getInitData()` returned
(structured-cloned across the boundary) and returns a `Partial<W>` that is merged onto `world` on every
subsequent run. Use it for state that must be seeded from the main thread but then persist inside the worker
— a seeded RNG, a lookup table, a config object — without paying to re-send it each frame. Type the init
data with the `D` type parameter (the fourth on `EntityUpdateFunction` / `ComponentSystem`) so `getInitData`
and the `init` hook agree on its shape; it defaults to `unknown` when a system has no init data:

```ts
interface DamageWorld extends ComponentSystemWorld {
	damage: number
}
interface DamageInitData {
	baseDamage: number
}

const damageUpdate: EntityUpdateFunction<Components, { health: Int32Array }, DamageWorld, DamageInitData> =
	(world, entityId, components) => { components.health[0] -= world.damage; };

// Runs once in the worker; its return is merged onto `world` before every run. `data` is typed as
// `DamageInitData | undefined` (undefined when the system supplies no getInitData).
damageUpdate.init = (data) => ({ damage: data?.baseDamage ?? 1 });

class DamageSystem extends ComponentSystem<Components, { health: Int32Array }, DamageWorld, DamageInitData> {
	constructor(world: BaseWorld<Components>) {
		super(world, {
			name: 'DamageSystem',
			required: ['health'],
			updateFunction: damageUpdate,
			getWorker: () => new Worker(/* your worker entry */),
			// Runs on the main thread; its result is structured-cloned to the worker's `init`.
			getInitData: () => ({ baseDamage: 5 }),
		});
	}
}
```

Unlike `addDataToWorld` (an overridable method on the system), `getInitData` is a config option — it lives in
the options passed to the `ComponentSystem` constructor, so a system used without a subclass can supply it
there directly.

**`preRun`** runs once per run, before any entity is updated, with the run's `world`, the full entity list,
the query results, and the same `callbacks`. Use it for setup that spans the whole batch — seeding a
spatial index, resetting an accumulator, or emitting a run-level event — that would be wasteful or wrong to
repeat inside the per-entity loop:

```ts
damageUpdate.preRun = (world, entities, queries, callbacks) => {
	// Runs before the per-entity pass; `entities` is everything this run will touch.
};
```

(An `entityRemoved(world, entityId, callbacks)` hook completes the set — it fires once per entity that left
the system this run, so a worker can release any per-entity state it was holding.)

### Importing in workers

Each worker entry file is bundled on its own, and a single-entry bundle cannot tree-shake this package's
barrel: importing `createComponentWorker` from `@daneren2005/shared-memory-ecs` drags the whole library -
`BaseWorld`, every system, their `@daneren2005/shared-memory-objects` dependencies - into the worker, even
though a worker never runs any of it (easily ~20kb of dead code per worker). Import worker-side helpers from
the `@daneren2005/shared-memory-ecs/worker` subpath instead. It exposes only what runs in a worker -
`createComponentWorker`, `createEntityWorker`, `killEntityWorker`, `DEAD_INDEX`, `TYPE_INDEX` (plus the
worker-relevant types) - so the bundle stays tiny:

```ts
// damage.worker.ts - the worker entry file
import { createComponentWorker } from '@daneren2005/shared-memory-ecs/worker';
import { damageUpdate } from './damage-update';

createComponentWorker(self, damageUpdate);
```

The same applies to any module the worker file pulls in: an update function that calls `createEntityWorker`
or `killEntityWorker` should import them from `/worker` too. Type-only imports (`EntityUpdateFunction`,
`ComponentSystemWorld`, ...) can come from either path since types are erased, and main-thread code
(`ComponentSystem`, `BaseWorld`, `EntityFactory`, ...) keeps importing from the package root.

A worker that creates entities (see [Creating entities from a worker](#creating-entities-from-a-worker)) passes
your component registry as the third argument - `createComponentWorker(self, shipUpdate, registry)` - so it has
each component's `toBlock`. Only do this in workers that actually create entities; it pulls the registry (and
whatever it imports) into that worker's bundle.

### Reading an entity's type in a worker

The `entity` component carries the entity's `type` in shared memory as a pointer, so a worker can resolve it
back to a string. Pull `entity` into the system's query (its block only reaches the worker if it is `required`
or `optional`), read the pointer at `TYPE_INDEX`, and hand it to `world.getString` — the framework injects that
resolver on `world` before every run:

```ts
import { TYPE_INDEX } from '@daneren2005/shared-memory-ecs/worker';
import type { EntityUpdateFunction } from '@daneren2005/shared-memory-ecs/worker';

const update: EntityUpdateFunction<Components, { entity: Uint32Array }> = (world, entityId, components) => {
	const type = world.getString(components.entity[TYPE_INDEX]); // e.g. "Space Ship"
	// ...branch on type, etc.
};

class TypedSystem extends ComponentSystem<Components, { entity: Uint32Array }> {
	constructor(world: BaseWorld<Components>) {
		super(world, { name: 'TypedSystem', required: ['entity'], updateFunction: update, getWorker: () => new Worker(/* ... */) });
	}
}
```

`world.getString(pointer)` is a Map lookup before it ever rebuilds the string from memory, and returns `''` for
the empty type or a pointer whose buffer has not synced to the worker yet. This works identically on the
main-thread fallback. It is not limited to type — any pointer to a `ConstantString` (via `world.constantStrings`
on the main thread) resolves the same way.

### Reporting back to the main thread

An update function runs on shared memory, so anything it writes is already visible on the main thread. What
it cannot do from there is touch the world, so the things that have to happen back on it go through
`callbacks`: `entityComponentChanged` (emitted on the entity as `component-property-updated`), `entityDied`
(as `death`), and `createEntity` (see [Creating entities from a worker](#creating-entities-from-a-worker)).
All of them are collected during the run and applied once it completes.

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

### Creating entities from a worker

An update function can spawn a whole entity, off-thread, from a factory config - the same
`{ type, ...overrides }` you would pass to `world.loadEntity`. Because component pools live in shared memory,
the worker merges the type's factory template, allocates each component's block and writes it, then reports
what it made; the main thread only wraps the result:

```ts
// in the update function - spawn a ship, overriding two fields of its template
createEntityWorker(world, { type: 'ship', x: 100, y: 150 }, callbacks);
```

`createEntityWorker` layers your overrides over the `ship` template, mints a unique id from a shared atomic
counter (so it never collides with one the main thread or another worker hands out), and for each component
the merged config triggers, pushes a block into its pool and writes the values - all off-thread. It reports
back an id-plus-block-indexes descriptor; when the run completes the main thread *adopts* it, building the
always-present `entity` component there (interning the `type` is a main-thread job) and wrapping each block the
worker wrote - no block is copied or re-allocated. Like every other worker report-back, the new entity first
exists on the following frame, so the system picks it up next run.

Two things make this work, both opt-in so only the workers that create entities pay for them:

- Register the system with `createsEntities: true`. That ships the factory templates to its worker on load.
- In that system's worker entry, pass your component registry to `createComponentWorker`, so the worker has
  each component's block builder:

  ```ts
  createComponentWorker(self, shipUpdate, registry);
  ```

Every component is already defined as two halves for exactly this — `toBlock(config)` (the block values) and
`attach(entity, memory, index)` (the accessor), see [Defining components](#defining-components). The worker
runs only `toBlock` (off-thread, no entity/world), and the main thread runs `attach` when it adopts the entity.
So creating a component in a worker needs nothing extra as long as its `toBlock` is genuinely pure over config —
no `entity`/`world` access:

```ts
const shipHealth: ComponentDefinition<HealthComponent, Int32Array, HealthConfig> = {
	// ...
	toBlock(config) {
		return [config.health ?? config.maxHealth, config.maxHealth];
	},
	attach(entity, memory, index) {
		const block = memory.getBlock(index);
		// ...build the accessor over `block`
	},
};
```

This runs identically on the main-thread fallback. Two current limits: a `loadInFinishLoading` component (one
that reads other entities) is skipped, since the worker has no world to read; and an adopted entity is always
the base `BaseEntity` - a factory per-type subclass is not applied to it.

### Freeing component memory safely

Component blocks live in a shared pool, so a freed block gets handed straight back out to the next entity that
needs one. That is a problem across workers: if one system kills an entity, a second reuses its freed block for
a brand-new entity, and a third is still mid-run over what it thinks is the old entity, the third system writes
into the new entity's memory.

So the library never frees a block the instant it is orphaned. When an entity dies or you call
`removeComponent`, the block is *deferred* — the component is gone from the entity immediately, but the memory is
held until every system that could be mid-run over it has finished a run. Only then is the block returned to the
pool for reuse. This is automatic; there is nothing to call. The one visible effect is that
`memoryComponent.length` can briefly sit one higher than the number of live components, until the next update
lets the holding systems finish. If a system stays stuck (never completes a run) for more than ten seconds of
unscaled time, the world logs a warning naming that system and frees the blocks anyway rather than leak them —
a stuck system there is a bug worth chasing down.

### Freeing extra resources

Everything above frees a component's own block. A component that allocates something *else* in `attach` —
another heap structure (a `SharedList`, a `SharedString`) or child entities it owns — needs to release that
too, and the block-level deferred free won't do it. Give the definition an optional `free(component)`:

```ts
const cargoDefinition: ComponentDefinition<Cargo, Uint32Array, CargoConfig> = {
  type: Uint32Array,
  size: 3,
  loadProperties: ['cargoSpace'],
  toBlock(config) {
    /* the block's own values */
  },
  attach(entity, memory, index) {
    /* allocate a SharedList in the heap, stash its pointer in the block, return accessors */
  },
  free(component) {
    component.items.free(); // release the SharedList + the item entities it holds
  },
};
```

`free` runs exactly once per component teardown: on `removeComponent`, and on every path that removes an
entity — `removeEntity`, a `death` (from `killEntity`), a `load` that drops the old batch, and `clear`.
It is deferred to the same safe point as the component's own block (see above), not fired the instant the
entity dies — so a system still mid-run over that memory can't see your resource released early. Reload calls
it without any `death` event, so it is the reliable place to avoid leaks when a world is reused.

### Reusing a world: `load` and `clear`

A world is meant to be reused rather than rebuilt. `world.load(config)` swaps in a fresh scenario — it removes
the old entities, clears every system, and loads the new batch (deferred frees from the old contents drain over
the following updates, as above). `await world.clear()` instead tears the world all the way back down to an
empty, reusable state: it waits for every system's in-flight worker run to finish so nothing is still reading
the memory, frees the held blocks immediately, and resolves once the world is ready to load into again.

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
