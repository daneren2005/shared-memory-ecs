import { createComponentWorker } from '../../src';
import type { EntityUpdateFunction } from '../../src';
import type { Components } from './components';

// Worker entry for the membership tests, which never call run() - they only exercise which entities the
// system tracks - so the update function is intentionally a noop.
const noopUpdate: EntityUpdateFunction<Components> = () => {};

createComponentWorker(self, noopUpdate);
