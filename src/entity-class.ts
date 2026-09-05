import type { ComponentDefinitionMap, EntityConfigOf } from './component-definition';

export type EntityClassConstructor = abstract new (...args: never[]) => { readonly eid: number };

export interface EntityClassDefinition {
	entity: EntityClassConstructor
	components: ReadonlyArray<string>
}

export type EntityClassRegistry = Record<string, EntityClassDefinition>;

declare const ENTITY_CLASSES_TYPE: unique symbol;

export type DefinedEntityClasses<
	R extends ComponentDefinitionMap,
	Classes extends EntityClassRegistry,
> = Classes & { readonly [ENTITY_CLASSES_TYPE]: R };

export type EntityInstancesOf<Classes extends EntityClassRegistry> = InstanceType<Classes[keyof Classes & string]['entity']>;

type RegistryOf<Classes extends EntityClassRegistry> = Classes extends DefinedEntityClasses<infer R, EntityClassRegistry> ? R : never;
type ComponentKeysOf<Definition> = Definition extends { components: ReadonlyArray<infer K> } ? K : never;

export type EntityClassTemplateConfig<
	Classes extends EntityClassRegistry,
	ClassName extends keyof Classes & string,
	R extends ComponentDefinitionMap = RegistryOf<Classes>,
> = EntityConfigOf<Pick<R, Extract<ComponentKeysOf<Classes[ClassName]>, keyof R>>> & {
	type: string
	class: ClassName
};

export type EntityTemplateConfigOf<Classes extends EntityClassRegistry> = {
	[ClassName in keyof Classes & string]: EntityClassTemplateConfig<Classes, ClassName>
}[keyof Classes & string];

export type EntityInstanceConfigOf<Classes extends EntityClassRegistry> = EntityTemplateConfigOf<Classes> extends infer Config
	? Config extends object ? Omit<Config, 'class'> & { class?: never } : never
	: never;

type EntityClassInput<R extends ComponentDefinitionMap> = Record<string, {
	entity: EntityClassConstructor
	components: ReadonlyArray<keyof R & string>
}>;

type ExactEntityConfig<Classes extends EntityClassRegistry, ClassName extends keyof Classes & string, Type, Config> = Config
	& EntityClassTemplateConfig<Classes, ClassName>
	& { type: Type }
	& Record<Exclude<keyof Config, keyof EntityClassTemplateConfig<Classes, ClassName>>, never>;

type CheckedEntityConfig<Classes extends EntityClassRegistry, Type, Config> =
	Config extends { class: infer ClassName }
		? ClassName extends keyof Classes & string
			? ExactEntityConfig<Classes, ClassName, Type, Config>
			: never
		: never;

type CheckedEntityConfigs<Classes extends EntityClassRegistry, Configs> = {
	[K in keyof Configs]: CheckedEntityConfig<Classes, K, Configs[K]>
};

export function defineEntityClasses<
	R extends ComponentDefinitionMap,
	const Classes extends EntityClassInput<R>,
>(_registry: R, classes: Classes): DefinedEntityClasses<R, Classes> {
	return classes as DefinedEntityClasses<R, Classes>;
}

export function defineEntityConfigs<
	Classes extends EntityClassRegistry,
	const Configs extends Record<string, { type: string, class: keyof Classes & string }>,
>(_classes: Classes, configs: Configs & CheckedEntityConfigs<Classes, Configs>): Configs {
	return configs;
}

export interface WorkerEntityClassDefinition {
	components: Array<string>
}

export type WorkerEntityClassRegistry = Record<string, WorkerEntityClassDefinition>;
