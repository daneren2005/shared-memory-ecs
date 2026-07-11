import type { TypedArrayConstructor } from '@daneren2005/shared-memory-objects';
import type MemoryComponent from './memory-component';
import type { ComponentTypedArray } from './memory-component';
import type BaseEntity from './entity';

// Every component stores an `index` pointing at its backing block inside the MemoryComponent pool.
// This is what lets the BaseWorld free a component's memory when it is removed.
export interface BaseComponent {
	index: number
}

// The shape a game supplies to describe its components.  The BaseWorld/BaseEntity are generic over this so
// `world.components`, `entity.components`, and the component setters/getters are all fully typed.
export type ComponentMap = Record<string, BaseComponent>;

// Describes a single component type: how big its block is, what typed array backs it, and how to
// load it from / save it to a plain config object.  The World builds a MemoryComponent from `type`
// + `size`, and BaseEntity#load / BaseEntity#save call `load` / `save` automatically - so games no longer
// wire up a loader/saver per component inside the entity itself.
export interface ComponentDefinition<
	Component extends BaseComponent,
	T extends ComponentTypedArray = ComponentTypedArray,
	Config = any,
	Serialization = any,
> {
	type: TypedArrayConstructor<T>
	size: number
	load(entity: BaseEntity, memory: MemoryComponent<T>, config: Config): Component
	save?(component: Component): Serialization
}

// The full set of component definitions for a game, keyed by component name.
export type ComponentRegistry<C extends ComponentMap> = {
	[K in keyof C]: ComponentDefinition<C[K]>
};
