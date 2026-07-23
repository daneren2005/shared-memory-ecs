import { createComponentWorker } from '../../index';
import type { EntityUpdateFunction } from '../../index';
import type { Components } from './components';

// Worker entry for the membership tests, which never call run() - they only exercise which entities the
// system tracks - so the update function is intentionally a noop that operates on no components.
const noopUpdate: EntityUpdateFunction<Components, Record<string, never>> = () => {};

createComponentWorker(self, noopUpdate);
