import type { ComponentTypedArray } from './memory-component';
import type { BaseComponent } from './component-definition';

// Base class for a memory-backed component accessor. Subclass it, declare prototype get/set accessors over
// `this.block` indexed by the component's exported *_INDEX constants, and return `new YourComponent(block, index)`
// from `attach`. Because the accessors live on one shared prototype - not fresh closures captured per entity -
// reads off thousands of entities every frame stay monomorphic and inline, and constructing a component allocates
// just the instance instead of a closure per accessor. Components that own no extra memory need nothing else; a
// subclass that does can take more constructor args (the entity, another pool) and store them as fields.
export default abstract class Component<T extends ComponentTypedArray = ComponentTypedArray> implements BaseComponent {
	readonly index: number;
	readonly block: T;

	constructor(block: T, index: number) {
		this.block = block;
		this.index = index;
	}
}
