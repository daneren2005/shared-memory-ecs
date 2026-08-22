# Architecture (agent code map)

Terse orientation map so an agent can jump straight to the right file instead of
re-exploring the tree each task. The README is the *usage* doc (how a game consumes
the library); this is the *internal* map. Keep it current — see AGENTS.md.

## What this is

An engine-agnostic Entity/Component/System core backed by shared memory
(`@daneren2005/shared-memory-objects`). No game concepts (factions, terrain, etc.).
Components store data in typed-array blocks inside one shared `MemoryHeap`, so
`ComponentSystem` update functions can run off-thread in a Web Worker over the same
memory. Public surface is re-exported from `src/index.ts`; the worker-only surface
from `src/worker.ts` (the `/worker` subpath).

## Commands

- `npm run type-check` — `tsc --noEmit`
- `npm run lint` — oxlint (prod config); `npm run lint:fix` to autofix
- `npm test` — vitest (`vitest run`); worker tests use `@vitest/web-worker`
- `npm run build` — vite build + `.d.ts` emit
Run type-check and lint after every edit (AGENTS.md).

## Code map (`src/`)

| File | Responsibility |
| --- | --- |
| `index.ts` | Public barrel (main-thread entry). |
| `worker.ts` | `/worker` subpath barrel — only what runs in a worker, keeps worker bundles tiny. |
| `world.ts` | `BaseWorld<R,C,Cfg>`: owns the heap, the `constantStrings` cache, the heap-backed atomic eid counter (`allocateEid`, unique across threads), the registry (one `MemoryComponent` per component), `entities` (Map by eid), systems, the update loop, clocks (`gameTime`/`playerTime`/`timeScale`/`paused`), add/remove-entity → system wiring, the deferred component-free buffers (`deferComponentMemoryFree`/`notifySystemRunCompleted`), and reuse via `load` / async `clear` gated by the `pristine` flag. `getSharedComponentMemory()` ships each pool + the eid counter to workers; `adoptEntity()` materializes an entity a worker created off-thread. Re-emits the heap's buffer-growth as a `grow-buffer` event, and `addGrownBuffer()` adopts a buffer a worker grew (then fans it out) so worker heaps stay in sync both ways. |
| `entity.ts` | `BaseEntity<C,Cfg>`: eid (from `world.allocateEid()`, a heap atomic — unique across threads; or a pre-minted `adoptEid` for worker-created entities) + component bag; `load`/`save`/`finishLoading`, `loadComponent` (create block from `toBlock` then `attach`), `attachComponent` (adopt a worker-written block by index — `attach` only), `removeComponent`/`setComponent`(`Bulk`)/`deleteComponent`. Both `loadComponent`/`attachComponent` ensure `component.block` holds the typed-array view (`??= memory.getBlock(index)` — a `Component` subclass already set it, a plain-object accessor gets it filled in), so query-delta building reuses this instead of re-fetching (a `getBlock` gives a fresh subarray each call) per system the entity joins. `removeComponent`/`deleteAllComponentMemory` call the definition's optional `free(component)` (release extra heap the component owns) then defer the block free to the world rather than freeing inline. EventEmitter. |
| `entity-component.ts` | The always-present `entity` component (`type`, `dead`, `isStatic`), all worker-visible in memory. `type` is stored as a pointer to an interned `ConstantString` (see `constant-string-cache.ts`); the `type` accessor resolves it through `world.constantStrings`. Exports `DEAD_INDEX`, `STATIC_INDEX`, `TYPE_INDEX`, `entityDefinition`. |
| `constant-string-cache.ts` | `ConstantStringCache`: interns immutable strings (from `@daneren2005/shared-memory-objects`'s `ConstantString`) in the heap and resolves a stored pointer back to its string. `getOrCreate(value)` dedupes so identical values share one allocation; `getString(pointer)` is a Map hit before rebuilding from memory. The main thread creates+interns (`world.constantStrings`); each worker reconstructs its own cache over the same buffers to resolve pointers. |
| `entity-factory.ts` | `EntityFactory<C,Cfg>`: maps entity `type` → base config template; layers caller config over it. `loadEntity` builds + adds to world. Override `createEntity` for subclass-per-type. |
| `component-definition.ts` | All the component/registry types: `ComponentDefinition` — a component is built in two required halves, `toBlock(config, entity?)` (worker-safe config→block-values map) + `attach(entity, memory, index)` (accessor over that block); loading is `attach(entity, memory, memory.create(toBlock(config)))`, and a worker calls only `toBlock`. Plus the optional `free(component)` teardown hook and `save(component)`. `BaseComponent`, `ComponentMap`, `ComponentRegistry`, `RegisteredComponentDefinition`, and the derivations `ComponentsOf` (from `attach`'s return, intersected with `BaseComponent`) / `EntityConfigOf` that infer `C`/`Cfg` from a registry. |
| `component.ts` | `Component<T>` base class an `attach` returns (`new YourComponent(block, index)`): holds `block`/`index` fields, subclass adds prototype get/set over `this.block`. One shared hidden class per component type keeps reads monomorphic/inlinable and construction a single allocation (vs a closure per accessor). `attach` may still return a plain object; the entity layer fills in `block` either way. |
| `memory-component.ts` | `MemoryComponent`: a pool of same-sized blocks in the heap (`create`/`getBlock`/`get`/`set`/`delete`/`clear`). Backed by a `SharedPool` (all bookkeeping in the heap), so a worker can reconstruct a handle over the same pool (`MemoryComponent.fromSharedMemory` / owner's `getSharedMemory()`) and allocate/read blocks off-thread — lockless except a spin-lock guarding rare chunk growth. Backing type is `ComponentTypedArray`. |
| `performance-timing.ts` | `PerformanceTiming`: hooks world events, emits `stats-updated` snapshots (`update` / per-system `run`+`events` / `events`). Non-invasive. |

### Systems (`src/systems/`)

Hierarchy: `System` → `IterableSystem` → `EntitySystem`; `ComponentSystem` extends `IterableSystem` too.

| File | Responsibility |
| --- | --- |
| `system.ts` | `System<C>` abstract base: fixed-timestep `deltaBetweenRuns`, `update`→`run`, `shouldRun`, `firstRun`, plus the overridable `init`/`finishLoading` startup pair. `onRunFinished` (fires `world.notifySystemRunCompleted`) and `isCurrentlyRunning()` let the world's deferred free tell when a system is done with memory; `waitForRunToComplete()` (a no-op base, real promise in `ComponentSystem`) lets `world.clear()` await an in-flight run. EventEmitter (systems report a whole run in one emit). |
| `iterable-system.ts` | `IterableSystem<C,T>`: spreads one pass over multiple frames when it exceeds `maxMsPerFrame` (`iterationsPerCheck`, `getIterables`/`updateIterable`). |
| `entity-system.ts` | `EntitySystem<C,T>`: main-thread iteration over entities owning `options.components`; auto add/remove via world events; `entities` Map by eid; `filterEntity` skips static. |
| `component-system.ts` | `ComponentSystem`: runs an `updateFunction` over raw memory blocks, off-thread when Workers + `SharedArrayBuffer` exist, else main-thread fallback. Queries (`required`/`optional`/`not`/`queries`), `addDataToWorld`, callbacks, and the update-function hooks (`init`/`preRun`/`entityRemoved`). The largest / most involved file. |

### Workers (`src/systems/workers/`) and actions (`src/actions/`)

| File | Responsibility |
| --- | --- |
| `workers/create-component-worker.ts` | `createComponentWorker(self, updateFn, registry?)` — worker entry helper. Pass the component registry only for a worker that creates entities (gives it each `toBlock`). |
| `workers/component-web-worker.ts` | Main-thread side of the worker (message plumbing). |
| `workers/component-worker-message.ts` | Message + `EntityEvent`/`SystemEvents` types across the boundary. |
| `workers/apply-query-delta.ts` | Applies query membership deltas. |
| `workers/web-worker.ts` | `WebWorker` wrapper. |
| `actions/kill-entity.ts` / `kill-entity-worker.ts` | Mark an entity dead (main / worker side). |
| `actions/create-entity-worker.ts` | `createEntityWorker(world, config, callbacks)`: create an entity from a factory config off-thread (via `world.buildEntityDescriptor`), report the descriptor for the main thread to adopt. |
| `actions/build-worker-entity.ts` | `buildWorkerEntity(config, factoryConfigs, registry, allocator)`: shared config→descriptor builder (template merge + per-component `toBlock` allocation); used by the real worker and the main-thread fallback. |

## Core data flow

- **Load:** `world.loadEntity(config)` → factory expands `type` → `new BaseEntity` →
  `load` loads every component whose `loadProperties` appear in the flat config (deferred
  ones wait for `finishLoading`, run once the whole batch exists) → `addEntity` (Map,
  wires `component-added`/`removed` → systems, emits `entity-added`).
- **Save:** `entity.save()` merges each component's `save()` (Serialization slice only;
  Config comes back from the factory template) → flat `Cfg`. `world` config is
  `{ entities: Cfg[], gameTime?, playerTime?, timeScale? }`.
- **Update:** `world.update(dt)` → `update-started` → per system `shouldRun`/`update`
  (timeScale-scaled, skipped while paused) → `update-finished`.
- **Deferred component free:** a component block is never freed the instant its entity dies or its component is
  removed — a freed block can be reused by a newly created entity while another system's worker is still mid-run
  over the old data, corrupting the new entity. Instead `removeComponent`/`deleteAllComponentMemory` call
  `world.deferComponentMemoryFree`, which queues the block — plus the definition's optional `free(component)` hook
  (for anything the component owns beyond its block: a SharedList, child entities) — in the `next` of two rolling
  buffers. The `free` hook runs at the same deferred point as the block delete (in `performFrees`), not the instant
  the entity dies, so a system still mid-run can't observe the resource torn down early. Each update the
  world promotes the pending buffer to `active`, snapshotting into a Set the systems that must each finish a run
  first — those that `shouldRun()` (will run and might pick up the block) or are `isCurrentlyRunning()` (mid-run
  over memory we may free). Each system needs just one completion: it drops out of the Set on its next
  `notifySystemRunCompleted` (fired from `onRunFinished` / a worker's `run-complete`), because after that run it is
  done with the block, and every later run applies the pending removed-delta before its update loop, so it can
  never process the freed entity again. Once the Set empties the blocks are actually freed and the next buffer is
  promoted. A buffer stuck longer than `FREE_BUFFER_STUCK_MS` (10s of unscaled time) warns which system it is
  waiting on and frees anyway rather than leak. `world.load()` routes all pending frees through the same wait so
  the reloaded world's systems each run once before the old blocks can be reused (see `consolidateFreeBuffersForReload`).
- **Clear / reuse:** `world.load()` removes every entity then calls `system.clear()` before loading the new
  batch. `ComponentSystem.clear()` resets `isRunning`, empties its main-thread caches (`entities`,
  `queryEntities`, `queryDeltas`), posts `reset` to drop the worker's persistent lists, and bumps a `generation`
  counter. Each `run` message carries the current `generation` and the worker echoes it on `run-complete`; a
  reply whose generation no longer matches is dropped, so a run still in flight when the world was reloaded can't
  report its events/creations into the new world. A `pristine` flag (true on a fresh or fully-cleared world,
  flipped false the moment any entity is added) lets `load`/`clear` skip this whole teardown when there is
  nothing to tear down.
- **Async `world.clear()`:** tears the world back to a pristine, reusable state and resolves once it is safe to
  reuse. It first awaits `system.waitForRunToComplete()` on every system (only an off-thread `ComponentSystem`
  mid-run returns a real promise; main-thread systems are never truly mid-run between `update()` calls), so no
  worker is still reading memory it is about to free. Then it removes every entity, clears every system, and
  frees **both** deferred-free buffers outright (`freeAllPendingBuffers`) rather than routing them through the
  per-update wait — safe precisely because it already waited. A pristine world resolves immediately.
- **System startup (two phases):** `system.init()` resolves once the worker is up — `ComponentSystem` posts
  `init` in its constructor and the worker answers `init-complete`. `system.finishLoading()` then posts `load`
  carrying `getInitData()`'s result; the worker runs `updateFunction.init` and answers `loaded`. `world.init()`
  awaits both in order, and `world.load()` re-runs `finishLoading` so a reused world re-seeds its workers.
- **Constant strings (entity type):** `entity.type` is interned once per distinct value into the heap as a
  `ConstantString` (immutable, lockless — see the shared-memory-objects repo) and the entity block stores only its
  pointer at `TYPE_INDEX`, so N entities of one type share one allocation. A real worker gets the heap's
  `SharedArrayBuffer`s in its `load` message (`heap: this.world.heap.getSharedMemory()`), rebuilds a `MemoryHeap`
  + its own `ConstantStringCache`, and exposes `world.getString(pointer)` (injected before every run) so update
  functions resolve `components.entity[TYPE_INDEX]` back to the string — a pointer→string Map hit before ever
  touching memory. `world.load()` also pre-interns a constant for every type in `factory.configs` (deduped), so a
  worker can resolve any known type even when no currently-loaded entity uses it. `world.load()`'s re-`finishLoading`
  re-ships the heap; buffers the heap grows afterward reach the worker as `grow-buffer` messages so later pointers
  still resolve. The main-thread fallback
  (`ComponentWebWorker`) shares the world's cache directly and ignores both the shipped heap and `grow-buffer`.
- **Off-thread allocation foundation:** the `load` message also ships `sharedMemory` (`getSharedComponentMemory()`):
  one `SharedPoolMemory` per component + the eid counter's `SharedAllocatedMemory`. A real worker reconstructs a
  `name → MemoryComponent` registry over the same pools and injects a `world.allocate` (`WorkerAllocator`) each run:
  `allocateEid()` (heap atomic) and `allocateComponentBlock(name, values)` (pushes into the shared pool). The fallback
  mirrors this over `world.registry`/`allocateEid` directly. When a worker's allocation grows the heap, it posts
  `grow-buffer-from-worker`; `ComponentSystem` forwards it to `world.addGrownBuffer`, which adopts the buffer and
  re-emits `grow-buffer` to fan it out to sibling workers. Growth is idempotent: neither the world nor a worker
  replaces a buffer position it already holds (the originating worker ignores the echo of its own buffer). This is the
  substrate for worker-side entity creation (below).
- **Worker-side entity creation:** an update function calls `createEntityWorker(world, config, callbacks)`
  (`actions/create-entity-worker.ts`) with a factory config `{ type, ...overrides }`. The worker builds the entity
  **off-thread** via `world.buildEntityDescriptor` (injected each run; the shared `buildWorkerEntity` in
  `actions/build-worker-entity.ts`): it layers the type's factory template under the overrides, mints an id
  (`world.allocate.allocateEid()`), and for each triggered game component pushes a block into the shared pool
  (`allocateComponentBlock`) filled by the component's `toBlock(config)` — the worker-safe half of the definition
  (no entity/world access). `entity` and `loadInFinishLoading` components are skipped. It reports
  a `WorkerCreatedEntity` (`{ eid, type, isStatic?, components: { name: index } }`) through `callbacks.createEntity`.
  On run-complete the main thread calls `world.adoptEntity(descriptor)`: it builds the `entity` component on the main
  thread (interning the type is main-thread-only), then `entity.attachComponent(name, index)` wraps each
  worker-written block via the definition's config-free `attach(entity, memory, index)` half — no block is
  re-allocated (a component's own extra allocations, if any, live in `attach`, so they happen the same way whether
  loaded or adopted). It then `addEntity`s the entity so it joins systems via
  `entity-added` on the next frame. Two opt-ins gate it: the system's `createsEntities: true` (ships the factory
  configs to its worker on load) and the worker entry passing the component registry to `createComponentWorker` (so
  the worker has each `toBlock`). Runs identically on the main-thread fallback (same `buildWorkerEntity`, over
  `world.registry`/`world.factory.configs`). Adopted entities are always the base `BaseEntity`; the factory's per-type
  subclass is not applied.
- **Worker update-function hooks:** besides the per-entity body, an `updateFunction` may carry `init`,
  `preRun`, and `entityRemoved`. `init(data)` runs on every `finishLoading` — `data` comes from the
  system's `getInitData()` (typed via the `D` param) — and its returned `Partial<W>` is merged onto `world`
  every run, so worker-local state (seeded RNG, lookup tables) persists without re-sending. `preRun` runs
  once per run before the entity pass; `entityRemoved` runs once per entity that left the system this run.
- **Worker report-back:** update functions write shared memory directly; anything needing
  the main thread goes through `callbacks` — `entityComponentChanged` (`component-property-updated`),
  `entityDied` (`death`), `createEntity` (a `WorkerCreatedEntity` descriptor → `world.adoptEntity`), plus
  `emitEntityEvent` (per-entity, arbitrary args, structured-cloned) and `emitSystemEvent` (per-run, one array of
  ids, allocation-free).

## Conventions / gotchas

- `world.entities` (and `EntitySystem`/`ComponentSystem` `entities`) are **Maps keyed by
  eid**, not arrays — deletes are O(1) and this replaced the old `entitiesByEid`. Iterate
  with `.forEach`/`.values()`; use `Array.from(...values())` for array methods.
- Every entity always has the `entity` component; game components are partial.
- **Hot path:** reading a component off thousands of entities every frame — hold the block
  (`registry[name].memoryComponent.getBlock(index)`, or the cached `component.block`) and index by exported
  `*_INDEX` constants rather than going through the accessor. `Component`-subclass accessors are prototype
  getters (monomorphic, inlinable), so the gap is far smaller than the old closure accessors, but a raw indexed
  read still wins the tightest loops. See README "Reading components on a hot path".
- `getBlock(index)` allocates a **fresh subarray view every call**, so it is not free. A live component caches
  its view on `component.block` at attach; reuse that rather than re-fetching (`ComponentSystem.buildComponents`
  relies on it, which is what keeps spawn-heavy query-delta building off the main thread's back).
- Worker entry files and anything they import must import from `@daneren2005/shared-memory-ecs/worker`,
  not the root barrel, or the whole library is dragged into the worker bundle.
- Types are the source of truth: a game declares its registry once and `ComponentsOf`/
  `EntityConfigOf` derive `C`/`Cfg`. Never cast to `any` (AGENTS.md).

## Tests

Colocated `__tests__/` dirs; fixtures (sample components, workers, updates) in
`src/__tests__/fixtures/`. Worker/system tests live under `src/systems/__tests__/` and
`src/systems/workers/__tests__/`.
