import type BaseWorld from '../world';
import type BaseEntity from '../entity';
import type { ComponentDefinitionMap, ComponentMap } from '../component-definition';
import type { SystemConfig } from './system';
import EntityWorkerSystem, {
	type EntityWorkerSystemQuery, type EntityWorkerSystemWorld, type EntityUpdateComponents,
} from './entity-worker-system';
import { toEntityUpdateFunction, type WorkerSystemRunFunction } from './workers/create-system-worker';

// An EntityWorkerSystem that runs its update function once per tick instead of once per entity. It accepts the same
// named `queries` (so it can count/scan other entities), runs on its own worker, can create entities off-thread, and
// receives fresh per-run data via addDataToWorld — all reusing the EntityWorkerSystem machinery. It has no main query:
// all work happens in the single run function over the named sub-queries.
export default class WorkerSystem<
	C extends ComponentMap,
	W extends EntityWorkerSystemWorld = EntityWorkerSystemWorld,
	D = unknown,
> extends EntityWorkerSystem<C, EntityUpdateComponents<C>, W, D> {
	constructor(world: BaseWorld<ComponentDefinitionMap, C>, options: WorkerSystemConfig<C, W, D>) {
		super(world, {
			...options,
			// No main query: the run function works entirely over the named sub-queries.
			required: [],
			updateFunction: toEntityUpdateFunction(options.updateFunction),
		});
	}

	// Never populate the main query — an empty `required` would otherwise match every entity. Sub-query membership
	// is maintained as usual so the run function still sees it.
	checkAddEntity(entity: BaseEntity<C>): boolean {
		Object.entries(this.options.queries ?? {}).forEach(([queryName, query]) => {
			const queryList = this.queryEntities[queryName] ?? (this.queryEntities[queryName] = new Map());
			this.updateEntityList(queryName, queryList, entity, this.matchesQuery(entity, query));
		});

		return false;
	}

	// Runs every interval regardless of membership, since its work is the single run function over sub-queries.
	shouldRun(): boolean {
		return true;
	}
}

export interface WorkerSystemConfig<
	C extends ComponentMap,
	W extends EntityWorkerSystemWorld = EntityWorkerSystemWorld,
	D = unknown,
> extends SystemConfig {
	updateFunction: WorkerSystemRunFunction<C, W, D>
	getWorker: () => Worker
	forceMainThread?: boolean
	getInitData?: () => D
	createsEntities?: boolean
	queries?: { [key: string]: EntityWorkerSystemQuery<C> }
}

export type { WorkerSystemRunFunction };
