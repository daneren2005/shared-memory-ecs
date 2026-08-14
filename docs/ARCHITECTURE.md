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
| `world.ts` | `BaseWorld<R,C,Cfg>`: owns the heap, the registry (one `MemoryComponent` per component), `entities` (Map by eid), systems, the update loop, clocks (`gameTime`/`playerTime`/`timeScale`/`paused`), add/remove-entity → system wiring, the deferred component-free buffers (`deferComponentMemoryFree`/`notifySystemRunCompleted`), and reuse via `load` / async `clear` gated by the `pristine` flag. |
| `entity.ts` | `BaseEntity<C,Cfg>`: eid + component bag; `load`/`save`/`finishLoading`, `loadComponent`/`removeComponent`/`setComponent`(`Bulk`)/`deleteComponent`. `removeComponent`/`deleteAllComponentMemory` call the definition's optional `free(component)` (release extra heap the component owns) then defer the block free to the world rather than freeing inline. EventEmitter. |
| `entity-component.ts` | The always-present `entity` component (`type`, `dead`, `isStatic`). `dead`/`isStatic` live in memory (worker-visible); `type` is a plain string (main-thread only). Exports `DEAD_INDEX`, `STATIC_INDEX`, `entityDefinition`. |
| `entity-factory.ts` | `EntityFactory<C,Cfg>`: maps entity `type` → base config template; layers caller config over it. `loadEntity` builds + adds to world. Override `createEntity` for subclass-per-type. |
| `component-definition.ts` | All the component/registry types: `ComponentDefinition` (incl. the optional `free(component)` teardown hook — release extra heap the component allocated in `load`), `BaseComponent`, `ComponentMap`, `ComponentRegistry`, `RegisteredComponentDefinition`, and the derivations `ComponentsOf` / `EntityConfigOf` that infer `C`/`Cfg` from a registry. |
| `memory-component.ts` | `MemoryComponent`: a pool of same-sized blocks in the heap (`create`/`getBlock`/`get`/`set`/`delete`/`clear`). Backing type is `ComponentTypedArray`. |
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
| `workers/create-component-worker.ts` | `createComponentWorker(self, updateFn)` — worker entry helper. |
| `workers/component-web-worker.ts` | Main-thread side of the worker (message plumbing). |
| `workers/component-worker-message.ts` | Message + `EntityEvent`/`SystemEvents` types across the boundary. |
| `workers/apply-query-delta.ts` | Applies query membership deltas. |
| `workers/web-worker.ts` | `WebWorker` wrapper. |
| `actions/kill-entity.ts` / `kill-entity-worker.ts` | Mark an entity dead (main / worker side). |
| `actions/create-entity-worker.ts` | Create an entity from inside a worker update. |

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
- **Worker update-function hooks:** besides the per-entity body, an `updateFunction` may carry `init`,
  `preRun`, and `entityRemoved`. `init(data)` runs on every `finishLoading` — `data` comes from the
  system's `getInitData()` (typed via the `D` param) — and its returned `Partial<W>` is merged onto `world`
  every run, so worker-local state (seeded RNG, lookup tables) persists without re-sending. `preRun` runs
  once per run before the entity pass; `entityRemoved` runs once per entity that left the system this run.
- **Worker report-back:** update functions write shared memory directly; anything needing
  the main thread goes through `callbacks` — `entityComponentChanged` (`component-property-updated`),
  `entityDied` (`death`), `createEntity`, plus `emitEntityEvent` (per-entity, arbitrary
  args, structured-cloned) and `emitSystemEvent` (per-run, one array of ids, allocation-free).

## Conventions / gotchas

- `world.entities` (and `EntitySystem`/`ComponentSystem` `entities`) are **Maps keyed by
  eid**, not arrays — deletes are O(1) and this replaced the old `entitiesByEid`. Iterate
  with `.forEach`/`.values()`; use `Array.from(...values())` for array methods.
- Every entity always has the `entity` component; game components are partial.
- **Hot path:** reading a component off thousands of entities every frame — hold the block
  (`registry[name].memoryComponent.getBlock(index)`) and index by exported `*_INDEX`
  constants, not the accessor closures (megamorphic). See README "Reading components on a hot path".
- Worker entry files and anything they import must import from `@daneren2005/shared-memory-ecs/worker`,
  not the root barrel, or the whole library is dragged into the worker bundle.
- Types are the source of truth: a game declares its registry once and `ComponentsOf`/
  `EntityConfigOf` derive `C`/`Cfg`. Never cast to `any` (AGENTS.md).

## Tests

Colocated `__tests__/` dirs; fixtures (sample components, workers, updates) in
`src/__tests__/fixtures/`. Worker/system tests live under `src/systems/__tests__/` and
`src/systems/workers/__tests__/`.
