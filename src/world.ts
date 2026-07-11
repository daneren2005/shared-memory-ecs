import { EventEmitter } from 'eventemitter3';
import { MAX_BYTE_OFFSET_LENGTH, MemoryHeap } from '@daneren2005/shared-memory-objects';
import MemoryComponent from './memory-component';
import BaseEntity from './entity';
import type System from './systems/system';
import EntitySystem from './systems/entity-system';
import ComponentSystem from './systems/component-system';
import type { ComponentMap, ComponentRegistry } from './component-definition';

const DEFAULT_HEAP_SIZE = MAX_BYTE_OFFSET_LENGTH;

export interface WorldOptions {
	heapSize?: number
}

// A simple wrapper around a set of entities + systems.  On construction it creates one
// MemoryComponent per entry in the component registry so entities can load/save themselves without
// each game re-declaring loaders/savers.  It has no game specific load/save/terrain/faction logic -
// that all belongs in the game that consumes this library.
export default class BaseWorld<C extends ComponentMap = ComponentMap> extends EventEmitter {
	heap: MemoryHeap;
	registry: ComponentRegistry<C>;
	components: { [K in keyof C]: MemoryComponent };

	entities: Array<BaseEntity<C>> = [];
	entitiesByEid: { [eid: number]: BaseEntity<C> } = {};
	systems: Array<System<C>> = [];

	gameTime = 0;
	destroyed = false;

	constructor(registry: ComponentRegistry<C>, options: WorldOptions = {}) {
		super();

		this.registry = registry;
		this.heap = new MemoryHeap({ bufferSize: options.heapSize ?? DEFAULT_HEAP_SIZE });

		const components = {} as { [K in keyof C]: MemoryComponent };
		for(let name of Object.keys(registry) as Array<keyof C>) {
			const definition = registry[name];
			components[name] = new MemoryComponent(this.heap, definition.type, definition.size);
		}
		this.components = components;
	}

	async init() {
		await Promise.all(this.systems.map(system => system.init()).filter(promise => promise instanceof Promise));
	}

	addEntity(entity: BaseEntity<C>, created = true): BaseEntity<C> {
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
		}
		this.emit('entity-added', entity);

		return entity;
	}
	loadEntity(config: any, created = true): BaseEntity<C> {
		return this.addEntity(new BaseEntity<C>(this, config), created);
	}
	removeEntity(entity: BaseEntity<C>) {
		let index = this.entities.indexOf(entity);
		if(index !== -1) {
			this.entities.splice(index, 1);
			delete this.entitiesByEid[entity.eid];
			this.emit('entity-removed', entity);
		}

		entity.deleteAllComponentMemory();
	}
	getEntityByEid(eid: number): BaseEntity<C> | undefined {
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
	private componentAffectsComponentSystem(system: ComponentSystem<C>, component: keyof C): boolean {
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
