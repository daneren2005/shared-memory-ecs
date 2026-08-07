import { createComponentWorker } from '../../index';
import { queryTargetUpdate } from './query-target-update';

// See damage.worker.ts for why `self` is passed explicitly.
createComponentWorker(self, queryTargetUpdate);
