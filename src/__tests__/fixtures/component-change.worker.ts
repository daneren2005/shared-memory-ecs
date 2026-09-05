import { createEntitySystemWorker } from '../../worker';
import { registry } from './components';
import { componentChangeUpdate } from './component-change-update';

createEntitySystemWorker(self, componentChangeUpdate, registry);
