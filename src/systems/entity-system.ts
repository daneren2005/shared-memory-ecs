import type BaseWorld from '../world';
import type BaseEntity from '../entity';
import type { ComponentDefinitionMap, ComponentMap } from '../component-definition';
import IterableSystem, { type IterableSystemConfig } from './iterable-system';

// Iterates the entities that own a given set of components on the main thread.  Entities are added
// and removed automatically as the world emits entity-added / entity-removed / component changes.
export default abstract class EntitySystem<C extends ComponentMap, T extends BaseEntity<C> = BaseEntity<C>> extends IterableSystem<C, T> {
	// Keyed by eid so an entity leaving the world costs a constant-time delete here rather than a scan of the
	// whole membership - see BaseWorld#entities.
	entities: Map<number, T> = new Map();
	options: EntitySystemConfig<C>;

	constructor(world: BaseWorld<ComponentDefinitionMap, C>, options: EntitySystemConfig<C> = { name: 'EntitySystem' }) {
		if(!options.iterationsPerCheck) {
			options.iterationsPerCheck = 10;
		}
		if(!options.maxMsPerFrame) {
			options.maxMsPerFrame = 4;
		}

		super(world, options);
		this.options = options;

		world.on('entity-added', (entity: BaseEntity<C>) => {
			if(this.checkAddEntity(entity) && this.options.updateEntityOnAdd) {
				this.updateEntity(entity as T, 0);
			}
		});
		world.on('entity-removed', (entity: BaseEntity<C>) => {
			this.removeEntity(entity);
		});

		world.entities.forEach(entity => {
			this.checkAddEntity(entity);
		});
	}

	getIterables(): Array<T> {
		// An array because IterableSystem spreads one pass over several frames, so it needs a list it can hold a
		// position in while the membership underneath it changes.
		const iterables: Array<T> = [];
		this.entities.forEach(entity => {
			if(!entity.components.entity.dead) {
				iterables.push(entity);
			}
		});

		return iterables;
	}
	updateIterable(entity: T, elapsedTime: number): void {
		if(entity.components.entity.dead) {
			return;
		}

		this.updateEntity(entity, elapsedTime);
	}
	filterEntity(entity: BaseEntity<C>): boolean {
		return !entity.components.entity.isStatic;
	}
	isEntityInSystem(entity: BaseEntity<C>) {
		return this.entities.has(entity.eid);
	}
	abstract updateEntity(entity: T, elapsedTime: number): void;

	checkAddEntity(entity: BaseEntity<C>): boolean {
		if(this.options.components && this.options.components.filter(component => !!entity.components[component]).length !== this.options.components.length) {
			return false;
		}

		if(this.filterEntity(entity)) {
			this.entities.set(entity.eid, entity as T);
			return true;
		} else {
			return false;
		}
	}
	removeEntity(entity: BaseEntity<C>) {
		this.entities.delete(entity.eid);
	}

	shouldRun(): boolean {
		return this.entities.size > 0;
	}
}

export interface EntitySystemConfig<C extends ComponentMap> extends IterableSystemConfig {
	components?: Array<keyof C>
	updateEntityOnAdd?: boolean
}
