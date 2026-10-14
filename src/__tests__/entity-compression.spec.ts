import { EntityFactory, EntityCompressor, compressEntities, decompressEntity, decompressEntities } from '../index';
import type { CompressedEntityDefinition } from '../index';
import { createTestWorld, type Components, type Config } from './fixtures/components';
import { listOf } from './fixtures/entity-collections';

const GRASS: CompressedEntityDefinition = {
	type: 'grass',
	properties: [
		{ name: 'x', type: 'uint', step: 32, offset: 16 },
		{ name: 'y', type: 'uint', step: 32, offset: 16 },
		{ name: 'harvestAmount', type: 'uint' },
		{ name: 'harvestProgress', type: 'uint' },
	],
};
const SIGN: CompressedEntityDefinition = {
	type: 'sign',
	properties: [{ name: 'offset', type: 'int' }, { name: 'lit', type: 'boolean' }],
};

function roundTrip(config: { type: string } & Record<string, unknown>, definitions = [GRASS, SIGN]) {
	const compressor = new EntityCompressor(definitions);
	const encoded = compressor.compress(config);
	return { encoded, decoded: decompressEntities([encoded], compressor.entityDefinitions)[0] };
}


describe('entity compression', () => {
	it('packs a matching config into a short JSON-safe string and back', () => {
		const config = { type: 'grass', x: 7920, y: 15440, harvestAmount: 0, harvestProgress: 633000 };
		const { encoded, decoded } = roundTrip(config);

		expect(typeof encoded).toBe('string');
		expect(JSON.stringify(encoded)).toEqual(`"${encoded as string}"`);
		expect((encoded as string).length).toBeLessThan(JSON.stringify(config).length / 3);
		expect(decoded).toEqual(config);
	});

	it.each([0, 1, 44, 45, 2024, 2025, 91124, 91125, 2 ** 31, 2 ** 51])('round trips %d at every varint length', value => {
		const definitions: Array<CompressedEntityDefinition> = [{ type: 'n', properties: [{ name: 'u', type: 'uint' }, { name: 'i', type: 'int' }] }];
		const { encoded, decoded } = roundTrip({ type: 'n', u: value, i: 0 - value }, definitions);
		expect(typeof encoded).toBe('string');
		expect(decoded).toEqual({ type: 'n', u: value, i: 0 - value });
	});

	it('keeps integers too large to zigzag safely as objects', () => {
		const definitions: Array<CompressedEntityDefinition> = [{ type: 'n', properties: [{ name: 'u', type: 'uint' }, { name: 'i', type: 'int' }] }];
		expect(typeof roundTrip({ type: 'n', u: Number.MAX_SAFE_INTEGER }, definitions).encoded).toBe('string');
		expect(typeof roundTrip({ type: 'n', i: -Number.MAX_SAFE_INTEGER }, definitions).encoded).toBe('object');
	});

	it('round trips signed values and booleans', () => {
		expect(roundTrip({ type: 'sign', offset: -17, lit: true }).decoded).toEqual({ type: 'sign', offset: -17, lit: true });
		expect(roundTrip({ type: 'sign', offset: 3, lit: false }).decoded).toEqual({ type: 'sign', offset: 3, lit: false });
	});

	it('round trips float32 values bit for bit', () => {
		const definitions: Array<CompressedEntityDefinition> = [{ type: 'deer', properties: [{ name: 'velocity', type: 'float32' }] }];
		for(const velocity of [0, -0, 1, -55.96278381347656, Math.fround(0.1), 3.4028234663852886e38, Math.fround(1e-40)]) {
			const { encoded, decoded } = roundTrip({ type: 'deer', velocity }, definitions);
			expect(typeof encoded).toBe('string');
			expect(Object.is(decoded.velocity, velocity)).toBe(true);
		}
		for(const velocity of [0.1, Infinity, NaN]) {
			expect(typeof roundTrip({ type: 'deer', velocity }, definitions).encoded).toBe('object');
		}
	});

	it('stores strings as their length then their characters, with 0 for null', () => {
		const definitions: Array<CompressedEntityDefinition> = [{ type: 'jerky', properties: [{ name: 'ownerId', type: 'string' }, { name: 'quantity', type: 'uint' }] }];
		const owner = 'aMjBsh4nAUe4emRQ5AbZi';
		expect(roundTrip({ type: 'jerky', ownerId: owner, quantity: 3 }, definitions)).toEqual({ encoded: `#8${owner}&`, decoded: { type: 'jerky', ownerId: owner, quantity: 3 } });
		expect(roundTrip({ type: 'jerky', ownerId: null, quantity: 3 }, definitions)).toEqual({ encoded: '##&', decoded: { type: 'jerky', ownerId: null, quantity: 3 } });
		expect(roundTrip({ type: 'jerky', quantity: 3 }, definitions)).toEqual({ encoded: '#!&', decoded: { type: 'jerky', quantity: 3 } });

		const awkward = 'a"b\\c!#é\u{1F600}'.repeat(10);
		expect(roundTrip({ type: 'jerky', ownerId: awkward, quantity: 1 }, definitions).decoded).toEqual({ type: 'jerky', ownerId: awkward, quantity: 1 });
		expect(typeof roundTrip({ type: 'jerky', ownerId: '' }, definitions).encoded).toBe('object');
		expect(typeof roundTrip({ type: 'jerky', ownerId: 5 }, definitions).encoded).toBe('object');
	});

	it('leaves missing values unset, trimming trailing ones from the string', () => {
		const bare = roundTrip({ type: 'grass', x: 16, y: 48 });
		const gap = roundTrip({ type: 'grass', x: 16, y: 48, harvestProgress: 5 });

		expect(bare.decoded).toEqual({ type: 'grass', x: 16, y: 48 });
		expect(gap.decoded).toEqual({ type: 'grass', x: 16, y: 48, harvestProgress: 5 });
		expect((gap.encoded as string).length).toEqual((bare.encoded as string).length + 2);
	});

	it.each([
		['an extra property', { type: 'grass', x: 16, y: 16, onFire: true }],
		['an unknown type', { type: 'worker', x: 16, y: 16 }],
		['a value off the step', { type: 'grass', x: 20, y: 16 }],
		['a fractional value', { type: 'sign', offset: 1.5 }],
		['a negative uint', { type: 'grass', x: 16, y: 16, harvestAmount: -1 }],
		['a string where a number belongs', { type: 'grass', x: '16', y: 16 }],
		['a number where a boolean belongs', { type: 'sign', lit: 1 }],
	])('keeps a config with %s as an object', (_, config) => {
		const { encoded, decoded } = roundTrip(config);
		expect(encoded).toBe(config);
		expect(decoded).toBe(config);
	});

	it('decodes strings saved before a definition grew a property', () => {
		const original = new EntityCompressor([GRASS]).compress({ type: 'grass', x: 48, y: 80, harvestAmount: 1, harvestProgress: 9 });
		const grown = { ...GRASS, properties: [...GRASS.properties, { name: 'onFire', type: 'boolean' as const }] };

		const decoded = decompressEntity(original as string, { 0: grown });
		expect(decoded).toEqual({ type: 'grass', x: 48, y: 80, harvestAmount: 1, harvestProgress: 9 });
		expect(new EntityCompressor([grown]).compress({ type: 'grass', x: 48, y: 80, onFire: true })).toEqual(expect.any(String));
	});

	it('stores decimals exactly or not at all', () => {
		const definitions: Array<CompressedEntityDefinition> = [{ type: 'pond', properties: [{ name: 'temperature', type: 'int', decimals: 2 }] }];
		for(let hundredths = -5000; hundredths <= 5000; hundredths += 7) {
			const temperature = hundredths / 100;
			const { encoded, decoded } = roundTrip({ type: 'pond', temperature }, definitions);
			expect(typeof encoded).toBe('string');
			expect(decoded).toEqual({ type: 'pond', temperature });
		}
		expect(typeof roundTrip({ type: 'pond', temperature: 12.345 }, definitions).encoded).toBe('object');
		expect(typeof roundTrip({ type: 'pond', temperature: 0.1 + 0.2 }, definitions).encoded).toBe('object');
	});

	it('only bundles the definitions some string uses', () => {
		const compressed = compressEntities([{ type: 'sign', offset: 1 }, { type: 'grass', x: 1, y: 1 }], [GRASS, SIGN]);
		expect(compressed.entityDefinitions).toEqual({ 1: SIGN });
	});


	it('keys definitions by index and decodes any number of them', () => {
		const definitions = Array.from({ length: 100 }, (_, index): CompressedEntityDefinition => ({ type: `t${index}`, properties: [{ name: 'v', type: 'uint' }] }));
		const configs = definitions.map((definition, index) => ({ type: definition.type, v: index }));
		const compressed = compressEntities(configs, definitions);

		expect(compressed.entityDefinitions[99]).toBe(definitions[99]);
		expect(decompressEntities(compressed.entities, compressed.entityDefinitions)).toEqual(configs);
	});

	it('shares one property list across types without lengthening their strings', () => {
		const PLANTS: CompressedEntityDefinition = { types: ['berry-bush', 'grass', 'wild-flax'], properties: GRASS.properties };
		const configs = [
			{ type: 'grass', x: 16, y: 48, harvestAmount: 1 },
			{ type: 'wild-flax', x: 48, y: 16 },
			{ type: 'sign', offset: 4 },
		];
		const shared = compressEntities(configs, [PLANTS, SIGN]);
		const separate = compressEntities(configs, [GRASS, { ...GRASS, type: 'wild-flax' }, SIGN]);

		expect(shared.entityDefinitions).toEqual({ 0: PLANTS, 3: SIGN });
		expect(shared.entities.map(entity => (entity as string).length)).toEqual(separate.entities.map(entity => (entity as string).length));
		expect(JSON.stringify(shared.entityDefinitions).length).toBeLessThan(JSON.stringify(separate.entityDefinitions).length);
		expect(decompressEntities(JSON.parse(JSON.stringify(shared.entities)), JSON.parse(JSON.stringify(shared.entityDefinitions)))).toEqual(configs);
	});

	it('rejects shared definitions that overlap or repeat a type', () => {
		expect(() => new EntityCompressor([{ types: ['grass', 'oak'], properties: [] }, { type: 'oak', properties: [] }])).toThrow(/Duplicate/);
		expect(() => decompressEntity('$', { 0: { types: ['a', 'b'], properties: [] }, 1: { type: 'c', properties: [] } })).toThrow(/overlap/);
	});

	it('survives a JSON round trip of the whole save', () => {
		const configs = [{ type: 'grass', x: 16, y: 16 }, { type: 'worker', name: 'Aldric' }, { type: 'sign', offset: -2, lit: true }];
		const saved = JSON.parse(JSON.stringify(compressEntities(configs, [GRASS, SIGN])));
		expect(Object.keys(saved.entityDefinitions)).toEqual(['0', '1']);

		expect(decompressEntities(saved.entities, saved.entityDefinitions)).toEqual(configs);
	});

	it('rejects duplicate definitions and strings it cannot read', () => {
		expect(() => new EntityCompressor([GRASS, GRASS])).toThrow(/Duplicate/);
		expect(() => decompressEntity('%#', { 0: GRASS })).toThrow(/No compressed entity definition/);
		expect(() => decompressEntity('#P', { 0: GRASS })).toThrow(/Truncated/);
		expect(() => decompressEntity('#"', { 0: GRASS })).toThrow(/Invalid/);
		expect(() => decompressEntity('#######', { 0: GRASS })).toThrow(/more values/);
		expect(() => decompressEntity('#(ab', { 0: { type: 'jerky', properties: [{ name: 'ownerId', type: 'string' }] } })).toThrow(/Truncated/);
		expect(() => decompressEntities(['#'], undefined)).toThrow(/entityDefinitions/);
	});
});

describe('world load with compressed entities', () => {
	it('expands string entities through the bundled definitions', () => {
		const factory = new EntityFactory<Components, Config>({ Miner: { maxHealth: 5 } });
		const world = createTestWorld(factory);
		const configs: Array<Config> = [{ type: 'Miner', health: 3 }, { type: 'Miner' }, { maxHealth: 9 }];
		const compressed = compressEntities<Config>(configs, [{ type: 'Miner', properties: [{ name: 'health', type: 'uint' }] }]);
		expect(compressed.entities.filter(entity => typeof entity === 'string')).toHaveLength(2);

		void world.load(compressed);

		expect(listOf(world.entities).map(entity => entity.save())).toEqual(configs.map(({ maxHealth: _, ...saved }) => saved));
	});
});
