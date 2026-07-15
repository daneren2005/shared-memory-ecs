import { EventEmitter } from 'eventemitter3';
import { MAX_BYTE_OFFSET_LENGTH, MemoryHeap } from '@daneren2005/shared-memory-objects';
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

export interface WorldOptions<C extends ComponentMap = ComponentMap, Cfg = any> {
	heapSize?: number
	// Supplies the type -> base config templates; defaults to an empty factory that loads configs as-is.
	factory?: EntityFactory<C, Cfg>
}

// The serialized shape of a whole world: the flat list of entity configs to (re)build plus the world clocks.  A
// game can layer its own fields on top; the World itself only needs `entities` (the same flat `Cfg` objects
// `loadEntity` / `save` deal with) and the optional time state that `load` restores.
export interface WorldConfig<Cfg = any> {
	entities: Array<Cfg>
	// Simulation clock; restored so a saved world resumes at the same in-game time.  Defaults to 0.
	gameTime?: number
	// Real elapsed play time; kept separate from gameTime and unaffected by timeScale.  Defaults to 0.
	playerTime?: number
	// Simulation speed multiplier.  Defaults to 1.
	timeScale?: number
}

// A simple wrapper around a set of entities + systems.  On construction it creates one
// MemoryComponent per entry in the component registry so entities can load/save themselves without
// each game re-declaring loaders/savers.  It has no game specific load/save/terrain/faction logic -
// that all belongs in the game that consumes this library.
// The World is generic over `R`, the registry of component definitions a game supplies.  Both the
// component-instance map `C` and the flat entity config `Cfg` are derived from `R` (via `ComponentsOf` /
// `EntityConfigOf`) and default off it, so `new BaseWorld(registry)` infers `R` from its argument and every
// entity's components and config are typed without the game declaring any composite types by hand.
export default class BaseWorld<
	R extends ComponentDefinitionMap = ComponentDefinitionMap,
	C extends ComponentMap = ComponentsOf<R>,
	Cfg = EntityConfigOf<R>,
> extends EventEmitter {
	heap: MemoryHeap;
	// The entity component is always registered on top of the game's components so every entity can be
	// given one automatically.  Each registered definition carries its own MemoryComponent, so a
	// component's memory pool is reachable straight from `registry[name].memoryComponent`.
	registry: RegisteredComponentRegistry<C> & { entity: RegisteredComponentDefinition<EntityComponent> };
	// Every entity is built through the factory, which expands its `type` against the registered templates.
	factory: EntityFactory<C, Cfg>;

	entities: Array<BaseEntity<C, Cfg>> = [];
	entitiesByEid: { [eid: number]: BaseEntity<C, Cfg> } = {};
	systems: Array<System<C>> = [];

	gameTime = 0;
	// Real (unscaled) time the player has spent in the world.  Unlike gameTime it keeps advancing while paused and
	// is never multiplied by timeScale.
	playerTime = 0;
	// Multiplier applied to elapsedTime before it advances gameTime / runs systems, so a game can speed up or slow
	// down simulation without touching the real frame delta.
	timeScale = 1;
	// While paused, update still accrues playerTime but skips advancing gameTime and running systems.
	paused = false;
	destroyed = false;

	// The game supplies its own components as `R`; the entity component is added automatically, so it must not
	// be part of the passed registry.
	constructor(registry: R, options: WorldOptions<C, Cfg> = {}) {
		super();

		this.heap = new MemoryHeap({ bufferSize: options.heapSize ?? DEFAULT_HEAP_SIZE });

		// Register every supplied definition (plus the always-present entity component) by attaching a freshly
		// allocated MemoryComponent to it, so the memory pool lives alongside the definition on the registry.
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

	addEntity(entity: BaseEntity<C, Cfg>, created = true): BaseEntity<C, Cfg> {
		this.entities.push(entity);
		this.entitiesByEid[entity.eid] = entity;
		entity.world = this;

		entity.on('component-added', (name: keyof C) => {
			this.addEntityToComponentSystem(entity, name);
		});
		entity.on('component-removed', (name: keyof C) => {
			this.removeEntityFromComponentSystem(entity, name);
		});

		if(created) {
			entity.finishLoading();
			this.emit('entity-added', entity);
			// killEntity / killEntityWorker flag the entity dead and emit `death`; remove it here.
			entity.on('death', () => {
				this.onEntityDied(entity);
			});
		}

		return entity;
	}
	loadEntity(config: Cfg, created = true): BaseEntity<C, Cfg> {
		// The factory expands the config's `type` against the registered templates before building the entity.
		return this.factory.loadEntity(config, created);
	}
	// Replace the world's contents with a saved config.  The existing entities (their backing memory freed) are
	// cleared and each system is reset via `clear()` first, then each entity is loaded with `created = false` so
	// no finishLoading runs mid-batch.  Systems themselves are set up once ahead of time (they persist across
	// loads); only their per-load state is cleared here.  Once every entity exists, finishLoading is called on
	// each - so a component that depends on other entities (e.g. a lumbermill counting nearby trees) can resolve
	// them, since the whole batch is guaranteed loaded by then.
	load(config: WorldConfig<Cfg>) {
		// Iterate over a copy since removeEntity mutates `this.entities`.
		for(let entity of this.entities.slice()) {
			this.removeEntity(entity);
		}
		this.systems.forEach(system => system.clear());

		const entities = config.entities.map(entityConfig => this.loadEntity(entityConfig, false));
		for(let entity of entities) {
			entity.finishLoading();
			this.emit('entity-added', entity);
			// killEntity / killEntityWorker flag the entity dead and emit `death`; remove it here.
			entity.on('death', () => {
				this.onEntityDied(entity);
			});
		}

		// Restore the world clocks, falling back to a fresh world's defaults when the config omits them.
		this.gameTime = config.gameTime ?? 0;
		this.playerTime = config.playerTime ?? 0;
		this.timeScale = config.timeScale ?? 1;
	}
	removeEntity(entity: BaseEntity<C, Cfg>) {
		let index = this.entities.indexOf(entity);
		if(index !== -1) {
			this.entities.splice(index, 1);
			delete this.entitiesByEid[entity.eid];
			this.emit('entity-removed', entity);
		}

		entity.deleteAllComponentMemory();
	}
	onEntityDied(entity: BaseEntity<C, Cfg>) {
		this.removeEntity(entity);
	}
	getEntityByEid(eid: number): BaseEntity<C, Cfg> | undefined {
		return this.entitiesByEid[eid];
	}

	addSystem<T extends System<C>>(system: T): T {
		this.systems.push(system);
		return system;
	}
	addSystemIfNotExists(system: System<C>) {
		let index = this.systems.findIndex(otherSystem => system.name === otherSystem.name);
		if(index === -1) {
			this.systems.push(system);
		}
	}
	removeSystem(name: string) {
		let index = this.systems.findIndex(system => system.name === name);
		if(index !== -1) {
			this.systems.splice(index, 1);
		}
	}

	update(elapsedTime: number): { lastSystemError?: Error | null } {
		// playerTime tracks real elapsed time and keeps ticking even while paused; gameTime is the scaled,
		// pausable simulation clock the systems run against.
		this.playerTime += elapsedTime;
		if(this.paused) {
			return {};
		}
		elapsedTime = this.timeScale * elapsedTime;

		this.gameTime += elapsedTime;

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
