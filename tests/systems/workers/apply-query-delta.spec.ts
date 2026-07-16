import { applyQueryDelta } from '../../../src/systems/workers/apply-query-delta';
import type { UpdateEntityConfigObject } from '../../../src/systems/component-system';

// The worker-side half of the delta protocol: given a persistent list and the changes a run carries, produce the
// updated list.  Kept a pure function so both worker backends share it and it can be unit-tested directly.
type Entry = UpdateEntityConfigObject<{ health: Int32Array }>;
function entry(entityId: number): Entry {
	return { entityId, components: { health: new Int32Array([entityId]) } };
}

describe('applyQueryDelta', () => {
	it('appends added entities to the list', () => {
		let list: Array<Entry> = [];

		list = applyQueryDelta(list, { added: [entry(1), entry(2)], removed: [] });

		expect(list.map(e => e.entityId)).toEqual([1, 2]);
	});

	it('returns the same list reference untouched for an empty (steady-state) delta', () => {
		let list = [entry(1), entry(2)];

		const result = applyQueryDelta(list, { added: [], removed: [] });

		// No allocation on the hot path: the existing list is handed straight back.
		expect(result).toBe(list);
		expect(result.map(e => e.entityId)).toEqual([1, 2]);
	});

	it('drops removed entities', () => {
		let list = [entry(1), entry(2), entry(3)];

		list = applyQueryDelta(list, { added: [], removed: [2] });

		expect(list.map(e => e.entityId)).toEqual([1, 3]);
	});

	it('replaces an existing entity in place when it is re-added with fresh blocks', () => {
		let list = [entry(1), entry(2)];
		const refreshed = entry(2);

		list = applyQueryDelta(list, { added: [refreshed], removed: [] });

		expect(list.map(e => e.entityId)).toEqual([1, 2]);
		// Upsert, not duplicate: the new block object took the old one's slot.
		expect(list[1]).toBe(refreshed);
	});

	it('applies removals before additions so a remove+add of the same eid keeps the fresh entry', () => {
		let list = [entry(1)];
		const readded = entry(1);

		list = applyQueryDelta(list, { added: [readded], removed: [1] });

		expect(list.map(e => e.entityId)).toEqual([1]);
		expect(list[0]).toBe(readded);
	});
});
