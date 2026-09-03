import { createEntitySystemWorker } from '../../index';
import { spawnUpdate } from './spawn-update';
import { registry } from './components';

// Passes the registry so the worker has each component's toBlock() for config-based entity creation.
// See damage.worker.ts for why `self` is passed explicitly.
createEntitySystemWorker(self, spawnUpdate, registry);
