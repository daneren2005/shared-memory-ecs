import type { TypedArrayConstructor } from '@daneren2005/shared-memory-objects/interfaces/typed-array-constructor';
import type MemoryComponent from './memory-component';
import type { ComponentTypedArray } from './memory-component';
import type BaseEntity from './entity';
import type { EntityComponent, EntityComponentConfig, EntityComponentSerialization } from './entity-component';

// `index` points at the backing block in the MemoryComponent pool, reachable via
// world.registry[name].memoryComponent.getBlock(index) — the fast path for reading a component off
// thousands of entities per frame. See "Reading components on a hot path" in the README.
export interface BaseComponent {
	index: number
}

export type ComponentMap = Record<string, BaseComponent>;

// `save` returns only the `Serialization` slice; the defining `Config` comes back from the template on reload.
export interface ComponentDefinition<
	Component extends BaseComponent,
	T extends ComponentTypedArray = ComponentTypedArray,
	Config = any,
	Serialization = object,
> {
	type: TypedArrayConstructor<T>
	size: number
	loadProperties: Array<keyof Config & string>
	// Defer load to BaseEntity#finishLoading (after the whole batch exists) so a loader can reference other entities.
	loadInFinishLoading?: boolean
	load(entity: BaseEntity, memory: MemoryComponent<T>, config: Config & Serialization): Component
	save?(component: Component): Serialization
}

export type RegisteredComponentDefinition<
	Component extends BaseComponent,
	T extends ComponentTypedArray = ComponentTypedArray,
	Config = any,
	Serialization = object,
> = ComponentDefinition<Component, T, Config, Serialization> & {
	memoryComponent: MemoryComponent<T>
};

export type ComponentRegistry<C extends ComponentMap> = {
	[K in keyof C]: ComponentDefinition<C[K]>
};

export type RegisteredComponentRegistry<C extends ComponentMap> = {
	[K in keyof C]: RegisteredComponentDefinition<C[K]>
};

// The entity component is NOT part of this map; the World adds it automatically.
export type ComponentDefinitionMap = Record<string, ComponentDefinition<BaseComponent>>;

type UnionToIntersection<U> = (U extends unknown ? (k: U) => void : never) extends (k: infer I) => void ? I : never;

type DefinitionConfig<D> = D extends ComponentDefinition<BaseComponent, ComponentTypedArray, infer Config, infer Serialization>
	? Config & Serialization
	: never;

export type ComponentsOf<R extends ComponentDefinitionMap> = {
	[K in keyof R]: ReturnType<R[K]['load']>
} & { entity: EntityComponent };

export type EntityConfigOf<R extends ComponentDefinitionMap> = Partial<
	UnionToIntersection<{ [K in keyof R]: DefinitionConfig<R[K]> }[keyof R]>
	& EntityComponentConfig & EntityComponentSerialization
>;
