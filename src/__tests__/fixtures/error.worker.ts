import { createComponentWorker } from '../../index';
import { errorUpdate } from './error-update';

// `self` is passed explicitly so this works under @vitest/web-worker, which injects it as a module local.
createComponentWorker(self, errorUpdate);
