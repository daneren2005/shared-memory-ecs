import { createComponentWorker } from '../../index';
import { createMultiUpdate } from './create-multi-update';
import { registry } from './components';

// See damage.worker.ts for why `self` is passed explicitly.
createComponentWorker(self, createMultiUpdate, registry);
