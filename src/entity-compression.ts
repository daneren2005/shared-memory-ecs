// Packs flat entity configs that match a definition into short ASCII strings. Format (all chars JSON-safe ASCII):
// a string is the definition key followed by one field per property in definition order, each field a value or ABSENT.
// Trailing absent fields are omitted, so decoding an older string with a newer definition leaves new fields unset.
// Varint: little-endian base-45 digits; every digit but the last comes from CONTINUATION, the last from TERMINAL.
// A string value is its length as a varint then its raw characters (0 is null); only it can hold non-alphabet chars.
// A definition sharing its properties across `types` at key n covers keys n, n + 1, ... in that order.

export type CompressedPropertyType = 'int' | 'uint' | 'boolean' | 'float32' | 'string';

export interface CompressedEntityProperty {
	name: string
	type: CompressedPropertyType
	// int/uint decode as stored * step / 10 ** decimals + offset; e.g. step 32 + offset 16 for tile centres.
	step?: number
	decimals?: number
	offset?: number
}

interface DefinitionProperties {
	properties: ReadonlyArray<CompressedEntityProperty>
}
export type CompressedEntityDefinition = DefinitionProperties & ({ type: string, types?: never } | { types: ReadonlyArray<string>, type?: never });

// Keyed by the decimal key of a definition's first type; see the format note for shared definitions.
export type CompressedEntityDefinitions = Record<string, CompressedEntityDefinition>;

export interface CompressedEntities<Cfg> {
	entityDefinitions: CompressedEntityDefinitions
	entities: Array<Cfg | string>
}

type CompressibleConfig = object & { type?: string };
type DecompressedValue = number | boolean | string | null;

const COMPRESSION_BASE = 45;
const ABSENT = '!';
// '#'..'O' and 'P'..'}' without the backslash: no char JSON would escape.
const TERMINAL = '#$%&\'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNO';
const CONTINUATION = 'PQRSTUVWXYZ[]^_`abcdefghijklmnopqrstuvwxyz{|}';

// Char code → digit for TERMINAL, digit + BASE for CONTINUATION, -1 otherwise.
const DIGITS = new Int8Array(128).fill(-1);
for(let i = 0; i < COMPRESSION_BASE; i++) {
	DIGITS[TERMINAL.charCodeAt(i)] = i;
	DIGITS[CONTINUATION.charCodeAt(i)] = i + COMPRESSION_BASE;
}

function encodeVarint(value: number): string {
	let encoded = '';
	while(value >= COMPRESSION_BASE) {
		encoded += CONTINUATION[value % COMPRESSION_BASE];
		value = Math.floor(value / COMPRESSION_BASE);
	}
	return encoded + TERMINAL[value];
}

const FLOAT_BITS = new Float32Array(1);
const UINT_BITS = new Uint32Array(FLOAT_BITS.buffer);

// The field text for a value, or undefined when this property can't represent it exactly.
function encodeField(property: CompressedEntityProperty, value: unknown): string | undefined {
	switch(property.type) {
		case 'boolean':
			return typeof value === 'boolean' ? TERMINAL[Number(value)] : undefined;
		case 'string':
			if(value === null) {
				return TERMINAL[0];
			}
			return typeof value === 'string' && value.length ? encodeVarint(value.length) + value : undefined;
		case 'float32':
			if(typeof value !== 'number' || !Number.isFinite(value) || Math.fround(value) !== value) {
				return undefined;
			}
			FLOAT_BITS[0] = value;
			return encodeVarint(UINT_BITS[0]);
		default: {
			const stored = integerValue(property, value);
			return stored === undefined ? undefined : encodeVarint(stored);
		}
	}
}

function integerValue(property: CompressedEntityProperty, value: unknown): number | undefined {
	if(typeof value !== 'number') {
		return undefined;
	}
	const stored = Math.round((value - (property.offset ?? 0)) * 10 ** (property.decimals ?? 0) / (property.step ?? 1));
	// Rejects anything that doesn't decode exactly, including values only near the step through floating point error.
	if(!Number.isSafeInteger(stored) || scaled(property, stored) !== value) {
		return undefined;
	}
	if(property.type === 'uint') {
		return stored >= 0 ? stored : undefined;
	}
	// Zigzag so small negatives stay short.
	const zigzag = stored >= 0 ? stored * 2 : -stored * 2 - 1;
	return Number.isSafeInteger(zigzag) ? zigzag : undefined;
}

// Divides by a power of ten rather than multiplying by a fraction: 1234 / 100 is exactly 12.34, 1234 * 0.01 is not.
function scaled(property: CompressedEntityProperty, stored: number) {
	return stored * (property.step ?? 1) / 10 ** (property.decimals ?? 0) + (property.offset ?? 0);
}

function loadedValue(property: CompressedEntityProperty, stored: number): DecompressedValue {
	switch(property.type) {
		case 'boolean':
			return stored !== 0;
		case 'float32':
			UINT_BITS[0] = stored;
			return FLOAT_BITS[0];
		case 'uint':
			return scaled(property, stored);
		default:
			return scaled(property, stored % 2 === 0 ? stored / 2 : -(stored + 1) / 2);
	}
}

function typesOf(definition: CompressedEntityDefinition): ReadonlyArray<string> {
	return definition.types !== undefined ? definition.types : [definition.type];
}

interface DefinitionGroup {
	key: number
	definition: CompressedEntityDefinition
	indices: Map<string, number>
}
interface DefinitionEncoder {
	prefix: string
	group: DefinitionGroup
}

export class EntityCompressor {
	private readonly encoders = new Map<string, DefinitionEncoder>();
	private readonly used = new Set<DefinitionGroup>();

	constructor(definitions: ReadonlyArray<CompressedEntityDefinition>) {
		let key = 0;
		for(const definition of definitions) {
			const group: DefinitionGroup = {
				key,
				definition,
				indices: new Map(definition.properties.map((property, index) => [property.name, index])),
			};
			for(const type of typesOf(definition)) {
				if(this.encoders.has(type)) {
					throw new Error(`Duplicate compressed entity definition for ${type}`);
				}
				this.encoders.set(type, { prefix: encodeVarint(key++), group });
			}
		}
	}

	// Only the definitions some compressed string needs, so a game can define every type without bloating its saves.
	get entityDefinitions(): CompressedEntityDefinitions {
		const definitions: CompressedEntityDefinitions = {};
		for(const group of this.used) {
			definitions[group.key] = group.definition;
		}
		return definitions;
	}

	// Returns the config unchanged when it carries anything its definition can't represent.
	compress<Cfg extends CompressibleConfig>(config: Cfg): Cfg | string {
		const encoder = config.type === undefined ? undefined : this.encoders.get(config.type);
		const encoded = encoder && this.encode(encoder, config);
		if(!encoder || encoded === undefined) {
			return config;
		}
		this.used.add(encoder.group);
		return encoded;
	}

	compressAll<Cfg extends CompressibleConfig>(entities: ReadonlyArray<Cfg>): CompressedEntities<Cfg> {
		const compressed = entities.map(config => this.compress(config));
		return { entityDefinitions: this.entityDefinitions, entities: compressed };
	}

	private encode(encoder: DefinitionEncoder, config: CompressibleConfig): string | undefined {
		const fields: Array<string | undefined> = [];
		for(const [name, value] of Object.entries(config)) {
			if(name === 'type' || value === undefined) {
				continue;
			}
			const index = encoder.group.indices.get(name);
			if(index === undefined) {
				return undefined;
			}
			const field = encodeField(encoder.group.definition.properties[index], value);
			if(field === undefined) {
				return undefined;
			}
			fields[index] = field;
		}

		let encoded = encoder.prefix;
		for(let i = 0; i < fields.length; i++) {
			encoded += fields[i] ?? ABSENT;
		}
		return encoded;
	}
}

export function compressEntities<Cfg extends CompressibleConfig>(entities: ReadonlyArray<Cfg>, definitions: ReadonlyArray<CompressedEntityDefinition>): CompressedEntities<Cfg> {
	return new EntityCompressor(definitions).compressAll(entities);
}

interface ResolvedDefinition {
	type: string
	properties: ReadonlyArray<CompressedEntityProperty>
}
// Expanding shared definitions to one entry per key once per save, rather than once per entity.
const resolvedDefinitions = new WeakMap<CompressedEntityDefinitions, Map<number, ResolvedDefinition>>();
function resolveDefinitions(definitions: CompressedEntityDefinitions): Map<number, ResolvedDefinition> {
	let resolved = resolvedDefinitions.get(definitions);
	if(resolved) {
		return resolved;
	}
	resolved = new Map();
	for(const [key, definition] of Object.entries(definitions)) {
		const types = typesOf(definition);
		for(let i = 0; i < types.length; i++) {
			if(resolved.has(Number(key) + i)) {
				throw new Error(`Compressed entity definitions overlap at key ${Number(key) + i}`);
			}
			resolved.set(Number(key) + i, { type: types[i], properties: definition.properties });
		}
	}
	resolvedDefinitions.set(definitions, resolved);
	return resolved;
}

export function decompressEntity(encoded: string, definitions: CompressedEntityDefinitions): Record<string, DecompressedValue | string> {
	let position = 0;
	const readVarint = (): number | undefined => {
		if(encoded[position] === ABSENT) {
			position++;
			return undefined;
		}
		let value = 0;
		let multiplier = 1;
		while(position < encoded.length) {
			const code = encoded.charCodeAt(position++);
			const digit = code < 128 ? DIGITS[code] : -1;
			if(digit < 0) {
				throw new Error(`Invalid compressed entity ${encoded}`);
			}
			if(digit < COMPRESSION_BASE) {
				return value + digit * multiplier;
			}
			value += (digit - COMPRESSION_BASE) * multiplier;
			multiplier *= COMPRESSION_BASE;
		}
		throw new Error(`Truncated compressed entity ${encoded}`);
	};

	const key = readVarint();
	const definition = key === undefined ? undefined : resolveDefinitions(definitions).get(key);
	if(!definition) {
		throw new Error(`No compressed entity definition for ${encoded}`);
	}
	const config: Record<string, DecompressedValue | string> = { type: definition.type };
	for(let i = 0; position < encoded.length; i++) {
		const property = definition.properties[i];
		if(!property) {
			throw new Error(`Compressed entity ${encoded} has more values than ${definition.type} defines`);
		}
		const stored = readVarint();
		if(stored === undefined) {
			continue;
		}
		if(property.type !== 'string') {
			config[property.name] = loadedValue(property, stored);
		} else if(stored === 0) {
			config[property.name] = null;
		} else {
			if(position + stored > encoded.length) {
				throw new Error(`Truncated compressed entity ${encoded}`);
			}
			config[property.name] = encoded.slice(position, position += stored);
		}
	}
	return config;
}

// Configs are flat records of the same shape a compressed string expands to, so the caller's Cfg is trusted here.
export function decompressEntities<Cfg>(entities: ReadonlyArray<Cfg | string>, definitions: CompressedEntityDefinitions | undefined): Array<Cfg> {
	return entities.map(entity => {
		if(typeof entity !== 'string') {
			return entity;
		}
		if(!definitions) {
			throw new Error('Compressed entities need entityDefinitions to load');
		}
		return decompressEntity(entity, definitions) as Cfg;
	});
}
