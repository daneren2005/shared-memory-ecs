import { createComponentWorker } from '../../index';
import { typeReadUpdate } from './type-read-update';

// See damage.worker.ts for why `self` is passed explicitly.
createComponentWorker(self, typeReadUpdate);
