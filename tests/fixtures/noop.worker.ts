import { createComponentWorker } from '../../src';
import type { EntityUpdateFunction } from '../../src';
import type { Components } from './components';

// Worker entry for the membership tests, which never call run() - they only exercise which entities the
// system tracks - so the update function is intentionally a noop that operates on no components.
const noopUpdate: EntityUpdateFunction<Components, Record<string, never>> = () => {};

createComponentWorker(self, noopUpdate);
