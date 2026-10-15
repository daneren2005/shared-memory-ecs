import QueryMembership from '../query-membership';
import type { UpdateEntityConfigObject } from '../../entity-worker-system';

type Entry = UpdateEntityConfigObject<{ health: Int32Array }>;
function entry(entityId: number): Entry {
	return { entityId, components: { health: new Int32Array([entityId]) } };
}

function ids(membership: QueryMembership<{ health: Int32Array }>) {
	return membership.entries.map(e => e.entityId);
}

describe('QueryMembership', () => {
	it('appends added entities to the list', () => {
		const membership = new QueryMembership<{ health: Int32Array }>();

		membership.apply({ added: [entry(1), entry(2)], removed: [] });

		expect(ids(membership)).toEqual([1, 2]);
	});

	it('keeps the same entries array for its whole life, empty deltas included', () => {
		const membership = new QueryMembership<{ health: Int32Array }>();
		const entries = membership.entries;

		membership.apply({ added: [entry(1), entry(2)], removed: [] });
		membership.apply({ added: [], removed: [] });
		membership.apply({ added: [], removed: [1] });

		expect(membership.entries).toBe(entries);
		expect(ids(membership)).toEqual([2]);
	});

	it('drops removed entities by moving the last member into the gap', () => {
		const membership = new QueryMembership<{ health: Int32Array }>();
		membership.apply({ added: [entry(1), entry(2), entry(3), entry(4)], removed: [] });

		membership.apply({ added: [], removed: [2] });
		expect(ids(membership)).toEqual([1, 4, 3]);

		membership.apply({ added: [], removed: [3, 1, 99] });
		expect(ids(membership)).toEqual([4]);

		membership.apply({ added: [entry(5)], removed: [4] });
		expect(ids(membership)).toEqual([5]);
	});

	it('replaces an existing entity in place when it is re-added with fresh blocks', () => {
		const membership = new QueryMembership<{ health: Int32Array }>();
		membership.apply({ added: [entry(1), entry(2)], removed: [] });
		const refreshed = entry(2);

		membership.apply({ added: [refreshed], removed: [] });

		expect(ids(membership)).toEqual([1, 2]);
		expect(membership.entries[1]).toBe(refreshed);
	});

	it('applies removals before additions so a remove+add of the same eid keeps the fresh entry', () => {
		const membership = new QueryMembership<{ health: Int32Array }>();
		membership.apply({ added: [entry(1)], removed: [] });
		const readded = entry(1);

		membership.apply({ added: [readded], removed: [1] });

		expect(ids(membership)).toEqual([1]);
		expect(membership.entries[0]).toBe(readded);
	});

	it('still finds every member after many removals and additions', () => {
		const membership = new QueryMembership<{ health: Int32Array }>();
		const live = new Set<number>();
		for(let round = 0; round < 50; round++) {
			const added = Array.from({ length: 20 }, (_, i) => entry(round * 20 + i));
			const removed = [...live].filter(eid => eid % 3 === round % 3);
			membership.apply({ added, removed });
			removed.forEach(eid => live.delete(eid));
			added.forEach(e => live.add(e.entityId));
		}

		expect(new Set(ids(membership))).toEqual(live);
		expect(membership.entries).toHaveLength(live.size);
		membership.apply({ added: [], removed: [...live] });
		expect(membership.entries).toHaveLength(0);
	});

	it('clears back to empty', () => {
		const membership = new QueryMembership<{ health: Int32Array }>();
		membership.apply({ added: [entry(1)], removed: [] });

		membership.clear();
		membership.apply({ added: [entry(1)], removed: [] });

		expect(ids(membership)).toEqual([1]);
	});
});
