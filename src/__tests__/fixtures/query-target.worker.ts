import { createComponentWorker } from '../../index';
import { queryTargetUpdate } from './query-target-update';

// Real worker entry point for the sub-query event-routing tests.  See damage.worker.ts for why `self` is passed
// explicitly.
createComponentWorker(self, queryTargetUpdate);
