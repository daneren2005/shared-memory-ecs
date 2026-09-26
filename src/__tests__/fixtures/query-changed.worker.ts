import { createEntitySystemWorker } from '../../index';
import { queryChangedUpdate } from './query-changed-update';

// See damage.worker.ts for why `self` is passed explicitly.
createEntitySystemWorker(self, queryChangedUpdate);
