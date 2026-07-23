import { EventEmitter } from 'eventemitter3';
import type BaseWorld from './world';
import type { ComponentDefinitionMap, ComponentMap, RegisteredComponentRegistry } from './component-definition';
import type { EntityComponent } from './entity-component';

// A bare entity: an eid and a bag of memory-backed components (including the required entity component).
// `Cfg` is the flat config this entity loads from / saves to; it defaults to `any` so a bare `BaseEntity<C>`
// stays usable, but a World derives it (via `EntityConfigOf`) so `config` and `load` are fully typed.
export default class BaseEntity<C extends ComponentMap = ComponentMap, Cfg = any> extends EventEmitter {
	static eidCounter = 1;

	readonly eid: number;
	config?: Cfg;

	// The World only uses its `R` param to derive `C`/`Cfg`, so entities reference it Cfg-agnostically via the
	// widened `ComponentDefinitionMap` - the instance shape depends on `C`/`Cfg`, not on the concrete registry.
	world: BaseWorld<ComponentDefinitionMap, C, Cfg>;
	// The entity component is required on every entity, so it is always present (unlike the game
	// components, which are partial).  Its `dead`/`isStatic` flags and `id` live here now.
	components: Partial<C> & { entity: EntityComponent } = {} as Partial<C> & { entity: EntityComponent };

	constructor(world: BaseWorld<ComponentDefinitionMap, C, Cfg>, config?: Cfg) {
		super();

		this.world = world;
		this.eid = BaseEntity.eidCounter++;
		this.loadComponent('entity', config ?? {}, false);
		if(config) {
			this.load(config);
		}
	}

	// `emitAdded` is true for runtime additions so systems can react; the loading path (constructor and
	// `load`) passes false, since those components are already accounted for when the entity is added.
	loadComponent<K extends keyof C>(name: K, config: any, emitAdded = true): C[K] {
		// registry carries the always-present entity component as an intersection; index the plain game map
		// here so the generic key stays cleanly typed as C[K].
		const definition = (this.world.registry as RegisteredComponentRegistry<C>)[name];
		// The definition now owns its MemoryComponent, so the memory pool comes straight off it.
		const memoryComponent = definition.memoryComponent;
		const component = definition.load(this, memoryComponent, config);
		(this.components as Partial<C>)[name] = component;
		if(emitAdded) {
			this.emit('component-added', name, component);
		}

		return component;
	}
	removeComponent<K extends keyof C>(name: K) {
		const component = this.components[name];
		if(component) {
			(this.world.registry as RegisteredComponentRegistry<C>)[name].memoryComponent.delete(component.index);
			delete this.components[name];
			this.emit('component-removed', name);
		}
	}
	setComponent<K extends keyof C, P extends keyof C[K]>(componentName: K, prop: P, value: C[K][P]) {
		const component = this.components[componentName];
		if(!component) {
			return;
		}

		// TS can't verify writing to a property of the generic C[K] by a keyof C[K] key, so index through a record.
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
		const registry = this.world.registry as RegisteredComponentRegistry<C>;
		for(let name of Object.keys(this.components) as Array<keyof C>) {
			const component = this.components[name];
			if(component) {
				registry[name].memoryComponent.delete(component.index);
			}
		}
	}

	// Loads component data from a flat config: every registered component whose `loadProperties` appear in
	// the config is handed the entire config.  The entity component is skipped here since the constructor
	// always loads it up front.
	load(config: Cfg) {
		// The flat config is keyed by string props; index it as a record for the `loadProperties` checks.
		const props = config as Record<string, unknown>;
		// registry carries the intersected entity component; index the plain game map so `definition` stays typed.
		const registry = this.world.registry as RegisteredComponentRegistry<C>;
		for(let name of Object.keys(registry) as Array<keyof C>) {
			if(name === 'entity') {
				continue;
			}

			const definition = registry[name];
			// Deferred components wait for finishLoading, once every entity in the batch exists.
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
		// Every component's saver returns flat props merged into one shared config, mirroring how `load`
		// hands that same flat config to each loader.
		const config: { [key: string]: any } = {};

		// registry carries the intersected entity component; index the plain game map here (the entity key
		// still resolves at runtime, so its definition is picked up as well).
		const registry = this.world.registry as RegisteredComponentRegistry<C>;
		const components = this.components as Partial<C>;
		for(let name of Object.keys(components) as Array<keyof C>) {
			const definition = registry[name];
			const component = components[name];
			if(definition.save && component) {
				Object.assign(config, definition.save(component));
			}
		}

		// The merged serialization slices reconstruct a (partial) flat config, which is exactly `Cfg`.
		return config as Cfg;
	}
	// Hook for games that need a second pass once every entity in a load batch exists.  The base pass loads any
	// components flagged `loadInFinishLoading`, which `load` deliberately skipped; overrides should call super.
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
