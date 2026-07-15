import { createComponentWorker } from '../../src';
import { spawnUpdate } from './spawn-update';

// Real worker entry point for the createEntityWorker tests.  See damage.worker.ts for why `self` is passed
// explicitly.
createComponentWorker(self, spawnUpdate);
