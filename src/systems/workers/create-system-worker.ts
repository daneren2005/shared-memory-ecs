import createEntitySystemWorker, { type EntitySystemWorkerScope } from './create-entity-system-worker';
import type { ComponentDefinitionMap, ComponentMap } from '../../component-definition';
import type {
	EntityWorkerSystemCallbacks, EntityWorkerSystemWorld, EntityQueryComponents, EntityUpdateComponents,
	EntityUpdateFunction, EntityUpdateInitFunction, EntityRemovedFunction, EntityQueryChangedFunction,
} from '../entity-worker-system';

// A WorkerSystem's single per-run function: called once per run over the named sub-queries, not once per entity.
// Optional `init`/`queryChanged`/`entityRemoved` mirror EntityUpdateFunction's hooks.
export type WorkerSystemRunFunction<
	C extends ComponentMap,
	W extends EntityWorkerSystemWorld = EntityWorkerSystemWorld,
	D = unknown,
> = ((world: W, queries: EntityQueryComponents<C>, callbacks: EntityWorkerSystemCallbacks<C>) => void) & {
	init?: EntityUpdateInitFunction<W, D>
	queryChanged?: EntityQueryChangedFunction<C, W>
	entityRemoved?: EntityRemovedFunction<C, W>
};

// A WorkerSystem reuses the EntityWorkerSystem worker machinery: the single run function becomes `preRun` (which runs
// once with query access) and the per-entity body is a no-op, since a WorkerSystem never populates its main query.
export function toEntityUpdateFunction<
	C extends ComponentMap,
	W extends EntityWorkerSystemWorld = EntityWorkerSystemWorld,
	D = unknown,
>(run: WorkerSystemRunFunction<C, W, D>): EntityUpdateFunction<C, EntityUpdateComponents<C>, W, D> {
	const updateFunction = (() => {}) as EntityUpdateFunction<C, EntityUpdateComponents<C>, W, D>;
	updateFunction.preRun = (world, _entities, queries, callbacks) => run(world, queries, callbacks);
	if(run.init) {
		updateFunction.init = run.init;
	}
	if(run.queryChanged) {
		updateFunction.queryChanged = run.queryChanged;
	}
	if(run.entityRemoved) {
		updateFunction.entityRemoved = run.entityRemoved;
	}

	return updateFunction;
}

// Worker entry helper for a WorkerSystem (mirrors createEntitySystemWorker). Pass the component registry only for a
// worker that creates entities.
export default function createSystemWorker<
	C extends ComponentMap,
	W extends EntityWorkerSystemWorld = EntityWorkerSystemWorld,
	D = unknown,
>(scope: EntitySystemWorkerScope, runFunction: WorkerSystemRunFunction<C, W, D>, definitions?: ComponentDefinitionMap) {
	createEntitySystemWorker(scope, toEntityUpdateFunction(runFunction), definitions);
}
