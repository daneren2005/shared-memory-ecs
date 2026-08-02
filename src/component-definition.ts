import type { TypedArrayConstructor } from '@daneren2005/shared-memory-objects/interfaces/typed-array-constructor';
import type MemoryComponent from './memory-component';
import type { ComponentTypedArray } from './memory-component';
import type BaseEntity from './entity';
// Type-only imports (erased at build time), so this does not create a runtime cycle with entity-component.
import type { EntityComponent, EntityComponentConfig, EntityComponentSerialization } from './entity-component';

// Every component stores an `index` pointing at its backing block inside the MemoryComponent pool.
// This is what lets the BaseWorld free a component's memory when it is removed - and it is also how anything
// that needs to can get at the block itself, through `world.registry[name].memoryComponent.getBlock(index)`.
//
// That matters for one thing only: reading a component off thousands of entities every frame.  A definition's
// `load` typically returns accessors over its block, which is the right way to read one - but the property
// walk ends in a getter closure, and since every entity has its own closure those call sites go megamorphic
// once enough entities exist, so none of it inlines.  Measured over ~10,000 entities, four reads apiece cost
// ~950ns an entity through the accessors and ~140ns off the block.  Anywhere else - and that is nearly
// everywhere - the accessors are what to use.  See "Reading components on a hot path" in the README.
export interface BaseComponent {
	index: number
}

// The shape a game supplies to describe its components.  The BaseWorld/BaseEntity are generic over this so
// `world.registry`, `entity.components`, and the component setters/getters are all fully typed.
export type ComponentMap = Record<string, BaseComponent>;

// Describes a single component type: how big its block is, what typed array backs it, and how to
// load it from / save it to a plain config object.  The World builds a MemoryComponent from `type`
// + `size`, and BaseEntity#load / BaseEntity#save call `load` / `save` automatically - so games no longer
// wire up a loader/saver per component inside the entity itself.
//
// A component's data is split across two shapes that together make up its flat config:
//   - `Config`: the defining properties supplied up front (e.g. `maxHealth`, `isStatic`).  `loadProperties`
//     can only name these, since they are what decides whether the component loads at all.
//   - `Serialization`: the optional, runtime-derived state that only exists once the component is alive
//     (e.g. current `health`, `dead`).
// `load` is handed the combined `Config & Serialization` (configs are flat and shared, so a loader keys off
// its `loadProperties` and reads whatever it needs off the whole object).  `save` returns only the
// `Serialization` slice - the defining `Config` is expected to come back from the template on reload, so a
// saver persists just the runtime-derived state.
export interface ComponentDefinition<
	Component extends BaseComponent,
	T extends ComponentTypedArray = ComponentTypedArray,
	Config = any,
	Serialization = object,
> {
	type: TypedArrayConstructor<T>
	size: number
	loadProperties: Array<keyof Config & string>
	// When true, this component is not loaded during BaseEntity#load with the rest.  Its `load` is instead
	// deferred to BaseEntity#finishLoading, which runs once every entity in a load batch exists - so a loader
	// that needs to reference other (already-loaded) entities can resolve them there.
	loadInFinishLoading?: boolean
	load(entity: BaseEntity, memory: MemoryComponent<T>, config: Config & Serialization): Component
	save?(component: Component): Serialization
}

// A definition once it has been registered on a World.  The World allocates the definition's backing
// MemoryComponent up front and attaches it here, so callers can reach a component's memory pool straight
// from its definition (`world.registry[name].memoryComponent`) instead of a parallel lookup map.
export type RegisteredComponentDefinition<
	Component extends BaseComponent,
	T extends ComponentTypedArray = ComponentTypedArray,
	Config = any,
	Serialization = object,
> = ComponentDefinition<Component, T, Config, Serialization> & {
	memoryComponent: MemoryComponent<T>
};

// The full set of component definitions a game supplies, keyed by component name.
export type ComponentRegistry<C extends ComponentMap> = {
	[K in keyof C]: ComponentDefinition<C[K]>
};

// The registry as it lives on a World: every definition has had its MemoryComponent attached.
export type RegisteredComponentRegistry<C extends ComponentMap> = {
	[K in keyof C]: RegisteredComponentDefinition<C[K]>
};

// A registry as a game supplies it to the World: component name -> its definition.  The entity component is
// added automatically by the World, so it is NOT part of this map.  A World is generic over this shape and
// derives both its component-instance map (`ComponentsOf`) and its flat entity config (`EntityConfigOf`)
// from it, so a game only ever declares its definitions once.
export type ComponentDefinitionMap = Record<string, ComponentDefinition<BaseComponent>>;

// Distributes over a union, collecting its members into a single intersection (e.g. `A | B` -> `A & B`).
type UnionToIntersection<U> = (U extends unknown ? (k: U) => void : never) extends (k: infer I) => void ? I : never;

// Pulls the combined `Config & Serialization` back off a single definition - the full flat config slice that
// definition's `load` understands.
type DefinitionConfig<D> = D extends ComponentDefinition<BaseComponent, ComponentTypedArray, infer Config, infer Serialization>
	? Config & Serialization
	: never;

// The component-instance map derived from a registry, plus the always-present entity component.  This is the
// `C extends ComponentMap` that the rest of the library is typed over.
export type ComponentsOf<R extends ComponentDefinitionMap> = {
	[K in keyof R]: ReturnType<R[K]['load']>
} & { entity: EntityComponent };

// The flat entity config derived from a registry: every component's `Config & Serialization` merged (plus the
// entity component's), all optional - since an entity holds any subset of components, any given prop may be
// absent.  This is what BaseEntity#config / BaseWorld#loadEntity are typed as, so a game never hand-writes a
// composite config type.
export type EntityConfigOf<R extends ComponentDefinitionMap> = Partial<
	UnionToIntersection<{ [K in keyof R]: DefinitionConfig<R[K]> }[keyof R]>
	& EntityComponentConfig & EntityComponentSerialization
>;
