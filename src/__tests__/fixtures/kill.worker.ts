import { createComponentWorker } from '../../index';
import { killUpdate } from './kill-update';

// Real worker entry point for the killEntityWorker tests.  See damage.worker.ts for why `self` is passed
// explicitly.
createComponentWorker(self, killUpdate);
