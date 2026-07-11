import type BaseWorld from '../world';
import type BaseEntity from '../entity';
import type { ComponentMap } from '../component-definition';
import IterableSystem, { type IterableSystemConfig } from './iterable-system';

// Iterates the entities that own a given set of components on the main thread.  Entities are added
// and removed automatically as the world emits entity-added / entity-removed / component changes.
export default abstract class EntitySystem<C extends ComponentMap, T extends BaseEntity<C> = BaseEntity<C>> extends IterableSystem<C, T> {
	entities: Array<T> = [];
	options: EntitySystemConfig<C>;

	constructor(world: BaseWorld<C>, options: EntitySystemConfig<C> = { name: 'EntitySystem' }) {
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
		return this.entities.filter(entity => !entity.dead);
	}
	updateIterable(entity: T, elapsedTime: number): void {
		if(entity.dead) {
			return;
		}

		this.updateEntity(entity, elapsedTime);
	}
	filterEntity(entity: BaseEntity<C>): boolean {
		return !entity.isStatic;
	}
	isEntityInSystem(entity: BaseEntity<C>) {
		return this.entities.indexOf(entity as T) !== -1;
	}
	abstract updateEntity(entity: T, elapsedTime: number): void;

	checkAddEntity(entity: BaseEntity<C>): boolean {
		if(this.options.components && this.options.components.filter(component => !!entity.components[component]).length !== this.options.components.length) {
			return false;
		}

		if(this.filterEntity(entity)) {
			this.entities.push(entity as T);
			return true;
		} else {
			return false;
		}
	}
	removeEntity(entity: BaseEntity<C>) {
		let index = this.entities.indexOf(entity as T);
		if(index !== -1) {
			this.entities.splice(index, 1);
		}
	}

	shouldRun(): boolean {
		return this.entities.length > 0;
	}
}

export interface EntitySystemConfig<C extends ComponentMap> extends IterableSystemConfig {
	components?: Array<keyof C>
	updateEntityOnAdd?: boolean
}
