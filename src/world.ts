import { EventEmitter } from 'eventemitter3';
import MemoryHeap from '@daneren2005/shared-memory-objects/memory-heap';
import { MAX_BYTE_OFFSET_LENGTH } from '@daneren2005/shared-memory-objects/utils/pointer';
import MemoryComponent from './memory-component';
import type BaseEntity from './entity';
import type System from './systems/system';
import EntitySystem from './systems/entity-system';
import ComponentSystem from './systems/component-system';
import type {
	BaseComponent, ComponentDefinitionMap, ComponentMap, ComponentRegistry, ComponentsOf,
	EntityConfigOf, RegisteredComponentDefinition, RegisteredComponentRegistry,
} from './component-definition';
import { entityDefinition, type EntityComponent } from './entity-component';
import EntityFactory from './entity-factory';

const DEFAULT_HEAP_SIZE = MAX_BYTE_OFFSET_LENGTH;
const FREE_BUFFER_STUCK_MS = 10000;

interface DeferredComponentFree {
	memoryComponent: MemoryComponent
	index: number
	// The definition's free hook, deferred to fire alongside the block free rather than the instant the entity dies.
	free?: () => void
}
// A batch of component blocks queued to be freed, plus the systems that must each finish a run before it is safe to free them
interface ComponentFreeBuffer<C extends ComponentMap> {
	frees: Array<DeferredComponentFree>
	waitingSystems: Set<System<C>>
	waitElapsed: number
}

export interface WorldOptions<C extends ComponentMap = ComponentMap, Cfg = any> {
	heapSize?: number
	factory?: EntityFactory<C, Cfg>
}

export interface WorldConfig<Cfg = any> {
	entities: Array<Cfg>
	gameTime?: number
	playerTime?: number
	timeScale?: number
}

export default class BaseWorld<
	R extends ComponentDefinitionMap = ComponentDefinitionMap,
	C extends ComponentMap = ComponentsOf<R>,
	Cfg = EntityConfigOf<R>,
> extends EventEmitter {
	heap: MemoryHeap;
	registry: RegisteredComponentRegistry<C> & { entity: RegisteredComponentDefinition<EntityComponent> };
	factory: EntityFactory<C, Cfg>;

	// Keyed by eid: entities leave from the middle one at a time (every death), so a Map deletes in constant
	// time while still iterating in insertion order, preserving load/save order.
	entities: Map<number, BaseEntity<C, Cfg>> = new Map();
	systems: Array<System<C>> = [];

	gameTime = 0;
	// Keeps advancing while paused and is never scaled by timeScale (unlike gameTime).
	playerTime = 0;
	timeScale = 1;
	paused = false;
	destroyed = false;
	// True while the world has never been loaded into
	pristine = true;

	// Two rolling buffers of component blocks awaiting a safe free. New deferrals land in `next`; `active` is the
	// one currently waiting for its systems to each finish a run before its blocks can be reused
	private activeFreeBuffer: ComponentFreeBuffer<C> = { frees: [], waitingSystems: new Set(), waitElapsed: 0 };
	private nextFreeBuffer: ComponentFreeBuffer<C> = { frees: [], waitingSystems: new Set(), waitElapsed: 0 };

	// The entity component is added automatically, so it must not be part of the passed registry.
	constructor(registry: R, options: WorldOptions<C, Cfg> = {}) {
		super();

		this.heap = new MemoryHeap({ bufferSize: options.heapSize ?? DEFAULT_HEAP_SIZE });

		const inputRegistry = { ...registry, entity: entityDefinition } as ComponentRegistry<C> & { entity: typeof entityDefinition };
		const registry_: Record<string, RegisteredComponentDefinition<BaseComponent>> = {};
		for(let name of Object.keys(inputRegistry)) {
			const definition = inputRegistry[name as keyof typeof inputRegistry];
			registry_[name] = {
				...definition,
				memoryComponent: new MemoryComponent(this.heap, definition.type, definition.size),
			};
		}
		this.registry = registry_ as RegisteredComponentRegistry<C> & { entity: RegisteredComponentDefinition<EntityComponent> };

		this.factory = options.factory ?? new EntityFactory<C, Cfg>();
		this.factory.world = this;
	}

	async init() {
		await Promise.all(this.systems.map(system => system.init()).filter(promise => promise instanceof Promise));
	}
	private finishLoadingSystems() {
		return Promise.all(this.systems.map(system => system.finishLoading()).filter(promise => promise instanceof Promise));
	}

	addEntity(entity: BaseEntity<C, Cfg>, created = true): BaseEntity<C, Cfg> {
		this.entities.set(entity.eid, entity);
		entity.world = this;
		// Any entity in the world means there is state to tear down on the next load/clear.
		this.pristine = false;

		entity.on('component-added', (name: keyof C) => {
			this.addEntityToComponentSystem(entity, name);
		});
		entity.on('component-removed', (name: keyof C) => {
			this.removeEntityFromComponentSystem(entity, name);
		});

		if(created) {
			entity.finishLoading();
			this.emit('entity-added', entity);
			entity.on('death', () => {
				this.onEntityDied(entity);
			});
		}

		return entity;
	}
	loadEntity(config: Cfg, created = true): BaseEntity<C, Cfg> {
		return this.factory.loadEntity(config, created);
	}
	// Replaces the world's contents. Entities load with created = false so no finishLoading runs mid-batch;
	// finishLoading is called on each once the whole batch exists, so cross-entity dependencies can resolve.
	load(config: WorldConfig<Cfg>) {
		// A pristine world (fresh or just cleared) has nothing to tear down, so skip the per-system clear.
		if(!this.pristine) {
			// Iterate over a copy since removeEntity mutates `this.entities`.
			for(let entity of Array.from(this.entities.values())) {
				this.removeEntity(entity);
			}
			this.systems.forEach(system => system.clear());
			this.consolidateFreeBuffersForReload();
		}

		const entities = config.entities.map(entityConfig => this.loadEntity(entityConfig, false));
		for(let entity of entities) {
			entity.finishLoading();
			this.emit('entity-added', entity);
			entity.on('death', () => {
				this.onEntityDied(entity);
			});
		}

		this.gameTime = config.gameTime ?? 0;
		this.playerTime = config.playerTime ?? 0;
		this.timeScale = config.timeScale ?? 1;

		// ComponentSystem re-sends its init data here.
		void this.finishLoadingSystems();
	}
	async clear(): Promise<void> {
		if(this.pristine) {
			return;
		}

		for(let entity of Array.from(this.entities.values())) {
			this.removeEntity(entity);
		}
		this.systems.forEach(system => system.clear());
		await Promise.all(
			this.systems
				.map(system => system.waitForRunToComplete())
				.filter(promise => promise instanceof Promise),
		);
		this.freeAllPendingBuffers();

		this.pristine = true;
	}
	removeEntity(entity: BaseEntity<C, Cfg>) {
		// delete reports whether it was actually present, so a double-remove emits entity-removed only once.
		if(this.entities.delete(entity.eid)) {
			this.emit('entity-removed', entity);
		}

		entity.deleteAllComponentMemory();
	}
	onEntityDied(entity: BaseEntity<C, Cfg>) {
		this.removeEntity(entity);
	}
	getEntityByEid(eid: number): BaseEntity<C, Cfg> | undefined {
		return this.entities.get(eid);
	}

	// Queues a component block to be freed when all systems done using it, running the definition's free hook (if any)
	// at that same deferred point so a system still mid-run can't observe the resource being torn down early.
	deferComponentMemoryFree(memoryComponent: MemoryComponent, index: number, free?: () => void) {
		this.nextFreeBuffer.frees.push({ memoryComponent, index, free });
	}
	// A system finished a run; if the active buffer was waiting on it, drop it and, once nothing is left to wait
	// for, free the buffer. One completion is enough: the system is now done touching the block for that run, and
	// every later run applies the pending removed-delta before its update loop, so it can never process the freed
	// entity again.
	notifySystemRunCompleted(system: System<C>) {
		if(this.activeFreeBuffer.waitingSystems.delete(system) && this.activeFreeBuffer.waitingSystems.size === 0) {
			this.processFreeBuffers();
		}
	}
	private processFreeBuffers() {
		// Loop so a promoted buffer with no systems to wait for is freed the same tick rather than a frame later.
		while(this.activeFreeBuffer.waitingSystems.size === 0) {
			if(this.activeFreeBuffer.frees.length > 0) {
				this.performFrees(this.activeFreeBuffer);
			}
			if(this.nextFreeBuffer.frees.length === 0) {
				break;
			}
			this.promoteNextFreeBuffer();
		}
	}
	private promoteNextFreeBuffer() {
		// active is now empty (its frees were performed); swap roles and reuse it as the new next buffer.
		const emptied = this.activeFreeBuffer;
		this.activeFreeBuffer = this.nextFreeBuffer;
		this.nextFreeBuffer = emptied;

		const active = this.activeFreeBuffer;
		active.waitElapsed = 0;
		active.waitingSystems.clear();
		for(let system of this.systems) {
			// Wait on a system if it will run (and so might pick up this block) or is already mid-run over memory we
			// may free. A system that is neither can't touch these blocks, so there's nothing to wait for.
			if(system.shouldRun() || system.isCurrentlyRunning()) {
				active.waitingSystems.add(system);
			}
		}
	}
	// On reload every system was just cleared (its completedRuns reset and worker told to drop its lists), so the
	// old targets no longer apply. Collapse whatever was pending into `next` with a fresh (empty) active buffer
	private consolidateFreeBuffersForReload() {
		if(this.activeFreeBuffer.frees.length > 0) {
			this.nextFreeBuffer.frees.push(...this.activeFreeBuffer.frees);
			this.activeFreeBuffer.frees.length = 0;
		}
		this.activeFreeBuffer.waitingSystems.clear();
		this.activeFreeBuffer.waitElapsed = 0;
	}
	// Frees both buffers outright. Only safe once every system's in-flight run has finished (see clear()), since it
	// skips the per-system wait the update loop normally enforces.
	private freeAllPendingBuffers() {
		this.performFrees(this.activeFreeBuffer);
		this.performFrees(this.nextFreeBuffer);
		this.activeFreeBuffer.waitingSystems.clear();
		this.activeFreeBuffer.waitElapsed = 0;
		this.nextFreeBuffer.waitingSystems.clear();
		this.nextFreeBuffer.waitElapsed = 0;
	}
	private performFrees(buffer: ComponentFreeBuffer<C>) {
		for(let deferred of buffer.frees) {
			deferred.free?.();
			deferred.memoryComponent.delete(deferred.index);
		}
		buffer.frees.length = 0;
	}
	private checkFreeBufferTimeout(elapsedTime: number) {
		const active = this.activeFreeBuffer;
		if(active.waitingSystems.size === 0) {
			return;
		}

		active.waitElapsed += elapsedTime;
		if(active.waitElapsed >= FREE_BUFFER_STUCK_MS) {
			const stuck = Array.from(active.waitingSystems).map(system => system.name).join(', ');
			console.warn(`shared-memory-ecs: deferred component free waited over ${FREE_BUFFER_STUCK_MS}ms on system(s): ${stuck}; freeing anyway`);
			active.waitingSystems.clear();
			this.processFreeBuffers();
		}
	}

	addSystem<T extends System<C>>(system: T): T {
		this.systems.push(system);
		this.emit('system-added', system);
		return system;
	}
	addSystemIfNotExists(system: System<C>) {
		let index = this.systems.findIndex(otherSystem => system.name === otherSystem.name);
		if(index === -1) {
			this.systems.push(system);
			this.emit('system-added', system);
		}
	}
	removeSystem(name: string) {
		let index = this.systems.findIndex(system => system.name === name);
		if(index !== -1) {
			const [system] = this.systems.splice(index, 1);
			this.emit('system-removed', system);
		}
	}

	update(elapsedTime: number): { lastSystemError?: Error | null } {
		this.emit('update-started', elapsedTime);
		const result = this.runUpdate(elapsedTime);
		this.emit('update-finished', elapsedTime);

		return result;
	}
	private runUpdate(elapsedTime: number): { lastSystemError?: Error | null } {
		this.playerTime += elapsedTime;
		if(this.paused) {
			return {};
		}
		const unscaledElapsedTime = elapsedTime;
		elapsedTime = this.timeScale * elapsedTime;

		this.gameTime += elapsedTime;

		// Promote before running: a run this same update then counts toward the wait, instead of after it.
		this.processFreeBuffers();

		let lastSystemError: Error | null = null;
		this.systems.forEach(system => {
			let shouldRun = true;
			let ran = false;
			let failed = false;
			this.emit(`system-${system.name}-started`);
			try {
				shouldRun = system.shouldRun();
				if(shouldRun) {
					ran = system.update(elapsedTime);
				}
			} catch(e) {
				const error = e as Error;
				console.error(error.message, error);
				failed = true;
				lastSystemError = error;
			}
			this.emit(`system-${system.name}-finished`, {
				ran,
				shouldRun,
				failed,
			});
		});

		this.checkFreeBufferTimeout(unscaledElapsedTime);

		return {
			lastSystemError,
		};
	}
	pause() {
		this.paused = true;
	}
	resume() {
		this.paused = false;
	}

	addEntityToComponentSystem(entity: BaseEntity<C>, component: keyof C) {
		this.systems.forEach(system => {
			if(system instanceof EntitySystem && system.options.components?.includes(component)) {
				system.checkAddEntity(entity);
			} else if(system instanceof ComponentSystem) {
				if(this.componentAffectsComponentSystem(system, component)) {
					system.checkAddEntity(entity);
				}
			}
		});
	}
	removeEntityFromComponentSystem(entity: BaseEntity<C>, component: keyof C) {
		this.systems.forEach(system => {
			if(system instanceof EntitySystem && system.options.components?.includes(component)) {
				system.removeEntity(entity);
			} else if(system instanceof ComponentSystem) {
				if(this.componentAffectsComponentSystem(system, component)) {
					system.checkAddEntity(entity);
				}
			}
		});
	}
	private componentAffectsComponentSystem(system: ComponentSystem<C, any>, component: keyof C): boolean {
		const affectsMainQuery = system.options.required.includes(component)
			|| !!system.options.not?.includes(component)
			|| !!system.options.optional?.includes(component);
		const affectsSubQuery = Object.values(system.options.queries ?? {}).some(query => {
			return query.required.includes(component)
				|| !!query.not?.includes(component)
				|| !!query.optional?.includes(component);
		});

		return affectsMainQuery || affectsSubQuery;
	}

	destroy() {
		if(this.destroyed) {
			return;
		}

		this.systems.forEach(system => {
			system.destroy();
		});
		this.destroyed = true;
	}
}
