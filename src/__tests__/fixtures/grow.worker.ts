import { createComponentWorker } from '../../index';
import { growUpdate } from './grow-update';

// See damage.worker.ts for why `self` is passed explicitly.
createComponentWorker(self, growUpdate);
