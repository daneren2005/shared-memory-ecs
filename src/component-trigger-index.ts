export interface ComponentTrigger {
	name: string
	order: number
}

interface TriggerDefinition {
	loadProperties: Array<string>
	loadInFinishLoading?: boolean
}

type TriggerMap = Map<string, Array<ComponentTrigger>>;

const NO_TRIGGERS: ReadonlyArray<ComponentTrigger> = [];
const byRegistryOrder = (a: ComponentTrigger, b: ComponentTrigger) => a.order - b.order;

// Finds a config's components from its own keys, so load cost follows the config's size and not the registry's.
export default class ComponentTriggerIndex {
	private readonly immediate: TriggerMap = new Map();
	private readonly deferred: TriggerMap = new Map();

	constructor(registry: Record<string, TriggerDefinition>) {
		Object.keys(registry).forEach((name, order) => {
			if(name === 'entity') {
				return;
			}

			const definition = registry[name];
			const triggers = definition.loadInFinishLoading ? this.deferred : this.immediate;
			const trigger = { name, order };
			for(const prop of definition.loadProperties) {
				const components = triggers.get(prop);
				if(components) {
					components.push(trigger);
				} else {
					triggers.set(prop, [trigger]);
				}
			}
		});
	}

	forLoad(config: object): ReadonlyArray<ComponentTrigger> {
		return this.find(this.immediate, config);
	}
	forFinishLoading(config: object): ReadonlyArray<ComponentTrigger> {
		return this.find(this.deferred, config);
	}

	private find(triggers: TriggerMap, config: object): ReadonlyArray<ComponentTrigger> {
		if(triggers.size === 0) {
			return NO_TRIGGERS;
		}

		const hits: Array<ComponentTrigger> = [];
		// for...in, not Object.keys: inherited enumerable keys must count, as they do for `in`.
		for(const key in config) {
			const components = triggers.get(key);
			if(components) {
				for(const component of components) {
					if(!hits.includes(component)) {
						hits.push(component);
					}
				}
			}
		}

		return hits.sort(byRegistryOrder);
	}
}
