import { createEntitySystemWorker } from '../../index';
import { randomUpdate } from './random-update';

// See damage.worker.ts for why `self` is passed explicitly.
createEntitySystemWorker(self, randomUpdate);
