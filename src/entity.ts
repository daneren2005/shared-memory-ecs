import { EventEmitter } from 'eventemitter3';
import type BaseWorld from './world';
import type { BaseComponent, ComponentDefinitionMap, ComponentMap, RegisteredComponentRegistry } from './component-definition';
import type { EntityComponent } from './entity-component';

export default class BaseEntity<C extends ComponentMap = ComponentMap, Cfg = any> extends EventEmitter {
	readonly eid: number;
	config?: Cfg;

	world: BaseWorld<ComponentDefinitionMap, C, Cfg>;
	private componentMemoryDeletionScheduled = false;
	// entity is always present; game components are partial.
	components: Partial<C> & { entity: EntityComponent } = {} as Partial<C> & { entity: EntityComponent };

	// `adoptEid`: build an empty shell around a pre-minted id (an entity a worker created off-thread), skipping the
	// automatic entity-component load - the caller (world.adoptEntity) loads the entity component and attaches the
	// worker-allocated blocks itself.
	constructor(world: BaseWorld<ComponentDefinitionMap, C, Cfg>, config?: Cfg, adoptEid?: number) {
		super();

		this.world = world;
		this.eid = adoptEid ?? world.allocateEid();
		if(adoptEid !== undefined) {
			return;
		}

		this.loadComponent('entity', config ?? {}, false);
		if(config) {
			this.load(config);
		}
	}

	loadComponent<K extends keyof C>(name: K, config: any, emitAdded = true): C[K] {
		const definition = (this.world.registry as RegisteredComponentRegistry<C>)[name];
		const memoryComponent = definition.memoryComponent;
		const index = memoryComponent.create(definition.toBlock(config, this));
		const component = definition.attach(this, memoryComponent, index);
		// A Component subclass already holds its block; only fetch one for a plain-object accessor that didn't.
		(component as BaseComponent).block ??= memoryComponent.getBlock(index);
		(this.components as Partial<C>)[name] = component;
		if(emitAdded) {
			this.emit('component-added', name, component);
		}

		return component;
	}
	// Builds an accessor over an existing block (allocated + written by a worker) instead of creating a new one - the
	// adopt half of loadComponent, without the create.
	attachComponent<K extends keyof C>(name: K, index: number, emitAdded = false): C[K] {
		const definition = (this.world.registry as RegisteredComponentRegistry<C>)[name];
		const component = definition.attach(this, definition.memoryComponent, index);
		(component as BaseComponent).block ??= definition.memoryComponent.getBlock(index);
		(this.components as Partial<C>)[name] = component;
		if(emitAdded) {
			this.emit('component-added', name, component);
		}
		return component;
	}
	removeComponent<K extends keyof C>(name: K) {
		if(this.componentMemoryDeletionScheduled) {
			return;
		}

		const component = (this.components as Partial<C>)[name];
		if(component) {
			const definition = (this.world.registry as RegisteredComponentRegistry<C>)[name];
			this.world.deferComponentMemoryFree(definition.memoryComponent, component.index, definition.free ? () => definition.free!(component) : undefined);
			delete this.components[name];
			this.emit('component-removed', name);
		}
	}
	setComponent<K extends keyof C, P extends keyof C[K]>(componentName: K, prop: P, value: C[K][P]) {
		const component = this.components[componentName];
		if(!component) {
			return;
		}

		(component as unknown as Record<P, C[K][P]>)[prop] = value;
		this.emit('component-property-updated', componentName, prop, value);
	}
	/**
	 * NOTE: Does not emit component-property-updated!
	 */
	setComponentBulk<K extends keyof C>(componentName: K, values: Partial<C[K]>) {
		const component = this.components[componentName];
		if(!component) {
			return;
		}

		Object.assign(component, values);
	}
	deleteComponent<K extends keyof C>(componentName: K, prop: keyof C[K]) {
		const component = this.components[componentName];
		if(!component) {
			return;
		}

		delete (component as Partial<C[K]>)[prop];
		this.emit('component-property-deleted', componentName, prop);
	}

	deleteAllComponentMemory() {
		if(this.componentMemoryDeletionScheduled) {
			return;
		}
		this.componentMemoryDeletionScheduled = true;

		const registry = this.world.registry as RegisteredComponentRegistry<C>;
		const components = this.components as Partial<C>;
		for(let name of Object.keys(components) as Array<keyof C>) {
			const definition = registry[name];
			const component = components[name];
			if(component) {
				this.world.deferComponentMemoryFree(definition.memoryComponent, component.index, definition.free ? () => definition.free!(component) : undefined);
			}
		}
	}

	load(config: Cfg) {
		const props = config as Record<string, unknown>;
		const registry = this.world.registry as RegisteredComponentRegistry<C>;
		for(let name of Object.keys(registry) as Array<keyof C>) {
			if(name === 'entity') {
				continue;
			}

			const definition = registry[name];
			if(definition.loadInFinishLoading) {
				continue;
			}
			if(definition.loadProperties.some(prop => prop in props)) {
				this.loadComponent(name, config, false);
			}
		}

		this.config = config;
	}
	save(): Cfg {
		const config: { [key: string]: any } = {};

		const registry = this.world.registry as RegisteredComponentRegistry<C>;
		const components = this.components as Partial<C>;
		for(let name of Object.keys(components) as Array<keyof C>) {
			const definition = registry[name];
			const component = components[name];
			if(definition.save && component) {
				Object.assign(config, definition.save(component));
			}
		}

		return config as Cfg;
	}
	// Second pass once every entity in a load batch exists; loads the deferred (loadInFinishLoading)
	// components load skipped. Overrides should call super.
	finishLoading() {
		const config = this.config;
		if(!config) {
			return;
		}

		const props = config as Record<string, unknown>;
		const registry = this.world.registry as RegisteredComponentRegistry<C>;
		for(let name of Object.keys(registry) as Array<keyof C>) {
			if(name === 'entity') {
				continue;
			}

			const definition = registry[name];
			if(definition.loadInFinishLoading && definition.loadProperties.some(prop => prop in props)) {
				this.loadComponent(name, config, false);
			}
		}
	}
}
