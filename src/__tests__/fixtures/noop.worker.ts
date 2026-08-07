import { createComponentWorker } from '../../index';
import type { EntityUpdateFunction } from '../../index';
import type { Components } from './components';

// The membership tests never call run(), so the update is a noop over no components.
const noopUpdate: EntityUpdateFunction<Components, Record<string, never>> = () => {};

createComponentWorker(self, noopUpdate);
