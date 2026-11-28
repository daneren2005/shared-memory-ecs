import { createEntitySystemWorker } from '../../index';
import { createMultiUpdate } from './create-multi-update';
import { registry } from './components';

// Only the block builders, as a slim worker entry would pass them, so creation can't come to rely on attach/save.
const layouts = Object.fromEntries(Object.entries(registry).map(([name, { loadProperties, toBlock }]) => [name, { loadProperties, toBlock }]));

// See damage.worker.ts for why `self` is passed explicitly.
createEntitySystemWorker(self, createMultiUpdate, layouts);