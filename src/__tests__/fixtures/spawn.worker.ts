import { createComponentWorker } from '../../index';
import { spawnUpdate } from './spawn-update';

// See damage.worker.ts for why `self` is passed explicitly.
createComponentWorker(self, spawnUpdate);
