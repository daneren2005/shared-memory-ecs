import { createSystemWorker } from '../../index';
import { workerSystemUpdate } from './worker-system-update';
import { registry } from './components';

// Registry passed so the run function can create entities off-thread (createEntityWorker).
createSystemWorker(self, workerSystemUpdate, registry);
