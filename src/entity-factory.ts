import BaseEntity from './entity';
import type BaseWorld from './world';
import type { ComponentDefinitionMap, ComponentMap } from './component-definition';

// Maps an entity `type` name to a base (template) config.  Loading an entity of a given type layers the
// caller's config on top of that base, so shared static data (a goblin's maxHealth, say) is declared once
// here instead of being saved on every entity - a save then only needs the `type` plus the entity's runtime
// serialization.  BaseWorld#loadEntity goes through the factory, so every load is type-expanded.
export default class EntityFactory<C extends ComponentMap = ComponentMap, Cfg = any> {
	// Set by BaseWorld when the factory is attached to it.  The World only uses `R` to derive `C`/`Cfg`, so the
	// factory references it Cfg-agnostically through the widened `ComponentDefinitionMap`.
	world!: BaseWorld<ComponentDefinitionMap, C, Cfg>;
	// type name -> its base config.
	configs: { [type: string]: Cfg };

	constructor(configs: { [type: string]: Cfg } = {}) {
		this.configs = configs;
	}

	// Register (or replace) the base config for an entity type.
	register(type: string, config: Cfg) {
		this.configs[type] = config;
	}

	// Layer a config over its type's base config.  A config with no (or an unknown) `type` passes through
	// unchanged, so fully-specified configs can still be loaded directly.
	getConfig(config: Cfg): Cfg {
		const type = (config as { type?: string } | undefined)?.type;
		const base = type ? this.configs[type] : undefined;
		return base ? { ...base, ...config } : config;
	}

	// Build a type-expanded entity and add it to the world.
	loadEntity(config: Cfg, created = true): BaseEntity<C, Cfg> {
		const entity = this.createEntity(this.getConfig(config));
		return this.world.addEntity(entity, created);
	}

	// Hook for games that map types to BaseEntity subclasses; override to return a subclass per config.type.
	protected createEntity(config: Cfg): BaseEntity<C, Cfg> {
		return new BaseEntity<C, Cfg>(this.world, config);
	}
}
