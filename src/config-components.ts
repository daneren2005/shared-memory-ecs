import type { ComponentMap } from './component-definition';
import type ComponentTriggerIndex from './component-trigger-index';

interface ConfigComponentWorld<C extends ComponentMap, Cfg extends object> {
	factory: {
		configs: { [type: string]: Cfg }
		isComponentAllowed(entityClass: string | undefined, component: string): boolean
	}
	componentTriggers: ComponentTriggerIndex
	registry: { [K in keyof C]: unknown }
}

// Components are triggered by key presence, so placeholder override values give an exact `createsEntities` list.
// Keys the type's class disallows are dropped rather than rejected, so one placeholder set can cover many types.
export default function configComponents<C extends ComponentMap, Cfg extends object>(world: ConfigComponentWorld<C, Cfg>, config: Cfg): Array<keyof C> {
	const type = (config as { type?: string }).type;
	const template = type ? world.factory.configs[type] : undefined;
	const merged: object = { ...template, ...config };
	const entityClass = (merged as { class?: string }).class;
	return [...world.componentTriggers.forLoad(merged), ...world.componentTriggers.forFinishLoading(merged)]
		.map(trigger => trigger.name)
		.filter((name): name is keyof C & string => name in world.registry && world.factory.isComponentAllowed(entityClass, name));
}
