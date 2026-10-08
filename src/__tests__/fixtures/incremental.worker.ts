import { createEntitySystemWorker } from '../../worker';
import { incrementalUpdate } from './incremental-update';

createEntitySystemWorker(self, incrementalUpdate);
