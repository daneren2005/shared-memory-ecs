import { createComponentWorker } from '../../index';
import { damageUpdate } from './damage-update';

// Real worker entry point.  Pass `self` explicitly so this works under @vitest/web-worker, which injects
// `self` as a module local rather than a real global.  In a browser worker `self` is the true global, so
// passing it is equivalent.
createComponentWorker(self, damageUpdate);
