import BaseEntity from './entity';
import type BaseWorld from './world';
import type { ComponentDefinitionMap, ComponentMap } from './component-definition';

// Maps an entity `type` to a base (template) config; loading layers the caller's config over it.
export default class EntityFactory<C extends ComponentMap = ComponentMap, Cfg = any> {
	world!: BaseWorld<ComponentDefinitionMap, C, Cfg>;
	configs: { [type: string]: Cfg };

	constructor(configs: { [type: string]: Cfg } = {}) {
		this.configs = configs;
	}

	register(type: string, config: Cfg) {
		this.configs[type] = config;
	}

	getConfig(config: Cfg): Cfg {
		const type = (config as { type?: string } | undefined)?.type;
		const base = type ? this.configs[type] : undefined;
		return base ? { ...base, ...config } : config;
	}

	loadEntity(config: Cfg, created = true): BaseEntity<C, Cfg> {
		const entity = this.createEntity(this.getConfig(config));
		return this.world.addEntity(entity, created);
	}

	protected createEntity(config: Cfg): BaseEntity<C, Cfg> {
		return new BaseEntity<C, Cfg>(this.world, config);
	}
}
