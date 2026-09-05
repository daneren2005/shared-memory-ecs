import BaseEntity from './entity';
import type BaseWorld from './world';
import type { ComponentDefinitionMap, ComponentMap } from './component-definition';
import type { EntityClassDefinition, EntityClassRegistry, WorkerEntityClassRegistry } from './entity-class';

// Maps type to a template and optionally maps the template's class to a wrapper + component allowlist.
export default class EntityFactory<
	C extends ComponentMap = ComponentMap,
	Cfg = any,
	E extends BaseEntity<C, Cfg> = BaseEntity<C, Cfg>,
> {
	world!: BaseWorld<ComponentDefinitionMap, C, Cfg, E>;
	configs: { [type: string]: Cfg };
	classes: EntityClassRegistry;
	private allowedComponents = new Map<string, ReadonlySet<string>>();

	constructor(configs: { [type: string]: Cfg } = {}, classes: EntityClassRegistry = {}) {
		this.configs = configs;
		this.classes = classes;
		for(const name of Object.keys(classes)) {
			this.allowedComponents.set(name, new Set(classes[name].components));
		}
	}

	register(type: string, config: Cfg) {
		if(this.world) {
			this.validateTemplate(type, config);
		}
		this.configs[type] = config;
	}

	setWorld(world: BaseWorld<ComponentDefinitionMap, C, Cfg, E>): void {
		this.world = world;
		for(const name of Object.keys(this.classes)) {
			const constructor = this.classes[name].entity;
			if(constructor !== BaseEntity && !(constructor.prototype instanceof BaseEntity)) {
				throw new Error(`Entity class ${name} must extend BaseEntity`);
			}
			for(const component of this.classes[name].components) {
				if(component === 'entity' || !(component in world.registry)) {
					throw new Error(`Entity class ${name} contains unknown or reserved component ${component}`);
				}
			}
		}
		for(const type of Object.keys(this.configs)) {
			this.validateTemplate(type, this.configs[type]);
		}
	}

	getConfig(config: Cfg): Cfg {
		const input = config as { type?: string, class?: unknown } | undefined;
		const type = input?.type;
		const base = type ? this.configs[type] : undefined;
		if(this.hasClasses) {
			if(!type || !base) {
				throw new Error(`Unknown entity type: ${type ?? ''}`);
			}
			if(Object.prototype.hasOwnProperty.call(input, 'class')) {
				throw new Error('Entity class comes from its type template and cannot be supplied by an instance config');
			}
		}
		const merged = base ? { ...base, ...config } : config;
		if(this.hasClasses && type) {
			this.validateResolvedConfig(type, merged);
		}
		return merged;
	}

	loadEntity(config: Cfg, created = true): E {
		const requestedType = (config as { type?: string }).type;
		const merged = this.getConfig(config);
		if(this.hasClasses && requestedType) {
			this.validateResolvedConfig(requestedType, merged);
		}
		const definition = this.getClassDefinition(merged);
		const entity = definition
			? this.constructEntity(definition, merged)
			: this.createEntity(merged);
		return this.world.addEntity(entity, created);
	}

	createAdoptedEntity(type: string, entityClass: string | undefined, eid: number): E {
		if(!entityClass) {
			if(this.hasClasses) {
				throw new Error(`Entity type ${type} has no class`);
			}
			return new BaseEntity<C, Cfg>(this.world, undefined, eid) as E;
		}
		const definition = this.classes[entityClass];
		if(!definition) {
			throw new Error(`Unknown entity class: ${entityClass}`);
		}
		this.validateTypeClass(type, entityClass);
		const entity = Reflect.construct(definition.entity, [this.world, undefined, eid, this.allowedComponents.get(entityClass)]) as E;
		entity.setAllowedComponents(this.allowedComponents.get(entityClass));
		return entity;
	}

	isComponentAllowed(entityClass: string | undefined, component: string): boolean {
		return !entityClass || !this.hasClasses || this.allowedComponents.get(entityClass)?.has(component) === true;
	}

	getWorkerClasses(): WorkerEntityClassRegistry | undefined {
		if(!this.hasClasses) {
			return undefined;
		}
		const classes: WorkerEntityClassRegistry = {};
		for(const name of Object.keys(this.classes)) {
			classes[name] = { components: [...this.classes[name].components] };
		}
		return classes;
	}

	getAllowedComponentsForConfig(config: Cfg | undefined): ReadonlySet<string> | undefined {
		return config ? this.getAllowedComponents(config) : undefined;
	}

	protected createEntity(config: Cfg): E {
		return new BaseEntity<C, Cfg>(this.world, config) as E;
	}

	private get hasClasses(): boolean {
		return this.allowedComponents.size > 0;
	}
	private getClassDefinition(config: Cfg): EntityClassDefinition | undefined {
		const entityClass = (config as { class?: string }).class;
		return entityClass ? this.classes[entityClass] : undefined;
	}
	private getAllowedComponents(config: Cfg): ReadonlySet<string> | undefined {
		const entityClass = (config as { class?: string }).class;
		return entityClass ? this.allowedComponents.get(entityClass) : undefined;
	}
	private constructEntity(definition: EntityClassDefinition, config: Cfg): E {
		const entityClass = (config as { class?: string }).class;
		return Reflect.construct(definition.entity, [this.world, config, undefined, this.allowedComponents.get(entityClass ?? '')]) as E;
	}
	private validateTemplate(type: string, config: Cfg): void {
		if(!this.hasClasses) {
			return;
		}
		const identity = config as { type?: string, class?: string };
		if(identity.type !== type) {
			throw new Error(`Entity template ${type} must declare the same type`);
		}
		if(!identity.class || !this.classes[identity.class]) {
			throw new Error(`Entity template ${type} has unknown class ${identity.class ?? ''}`);
		}
		this.validateComponentTriggers(type, identity.class, config);
	}
	private validateResolvedConfig(type: string, config: Cfg): void {
		const identity = config as { type?: string, class?: string };
		if(identity.type !== type) {
			throw new Error(`Entity type ${type} is immutable`);
		}
		if(!identity.class || !this.classes[identity.class]) {
			throw new Error(`Entity type ${type} has unknown class ${identity.class ?? ''}`);
		}
		this.validateTypeClass(type, identity.class);
		this.validateComponentTriggers(type, identity.class, config);
	}
	private validateTypeClass(type: string, entityClass: string): void {
		const template = this.configs[type] as { class?: string } | undefined;
		if(!template || template.class !== entityClass) {
			throw new Error(`Entity type ${type} does not belong to class ${entityClass}`);
		}
	}
	private validateComponentTriggers(type: string, entityClass: string, config: Cfg): void {
		const allowed = this.allowedComponents.get(entityClass)!;
		const allowedProperties = new Set<string>();
		for(const component of allowed) {
			for(const prop of this.world.registry[component as keyof C].loadProperties) {
				allowedProperties.add(prop);
			}
		}
		const props = config as Record<string, unknown>;
		for(const name of Object.keys(this.world.registry)) {
			if(name === 'entity' || allowed.has(name)) {
				continue;
			}
			const definition = this.world.registry[name as keyof C];
			const forbidden = definition.loadProperties.find(prop => prop in props && !allowedProperties.has(prop));
			if(forbidden) {
				throw new Error(`Entity type ${type} class ${entityClass} cannot load component ${name} from property ${forbidden}`);
			}
		}
	}
}
