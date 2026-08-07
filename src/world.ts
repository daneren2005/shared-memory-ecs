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

	addEntity(entity: BaseEntity<C, Cfg>, created = true): BaseEntity<C, Cfg> {
		this.entities.set(entity.eid, entity);
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
		// Iterate over a copy since removeEntity mutates `this.entities`.
		for(let entity of Array.from(this.entities.values())) {
			this.removeEntity(entity);
		}
		this.systems.forEach(system => system.clear());

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
