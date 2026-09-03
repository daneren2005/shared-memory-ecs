import { createEntitySystemWorker } from '../../index';
import { killUpdate } from './kill-update';

// See damage.worker.ts for why `self` is passed explicitly.
createEntitySystemWorker(self, killUpdate);
