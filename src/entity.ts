import { EventEmitter } from 'eventemitter3';
import type BaseWorld from './world';
import type { ComponentMap } from './component-definition';

// A bare entity: an id, an eid, and a bag of memory-backed components
export default class BaseEntity<C extends ComponentMap = ComponentMap> extends EventEmitter {
	static eidCounter = 1;

	// eid is a fast numeric reference for internal lookups (worker threads, caches).  id is the
	// stable string reference used by save data / cross-entity references.
	readonly eid: number;
	id?: string;
	config?: any;

	world: BaseWorld<C>;
	components: Partial<C> = {};
	dead = false;
	isStatic = false;

	constructor(world: BaseWorld<C>, config?: any) {
		super();

		this.world = world;
		this.eid = BaseEntity.eidCounter++;
		if(config) {
			this.load(config);
		}
	}

	loadComponent<K extends keyof C>(name: K, config: any): C[K] {
		const definition = this.world.registry[name];
		const memoryComponent = this.world.components[name];
		// BaseEntity is invariant over C (registry/components), so widen to the definition's default BaseEntity.
		const component = definition.load(this as unknown as BaseEntity, memoryComponent, config);
		this.components[name] = component;
		this.emit('component-added', name, component);

		return component;
	}
	removeComponent<K extends keyof C>(name: K) {
		const component = this.components[name];
		if(component) {
			this.world.components[name].delete(component.index);
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
		for(let name of Object.keys(this.components) as Array<keyof C>) {
			const component = this.components[name];
			if(component) {
				this.world.components[name].delete(component.index);
			}
		}
	}

	// Loads only component data: every key in the config that maps to a registered component is handed to that component's loader.
	load(config: any) {
		for(let name in config) {
			if(name in this.world.registry) {
				this.loadComponent(name, config[name]);
			}
		}

		this.config = config;
	}
	save() {
		const config: { [key: string]: any } = {};

		for(let name of Object.keys(this.components) as Array<keyof C>) {
			const definition = this.world.registry[name];
			const component = this.components[name];
			if(definition.save && component) {
				config[name as string] = definition.save(component);
			}
		}

		return config;
	}
	// Hook for games that need a second pass once every entity in a load batch exists.
	finishLoading() {}
}
