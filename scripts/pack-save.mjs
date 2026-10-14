// Re-packs a save's entity configs into strings using its own entityDefinitions. Usage:
//   npm run pack-save -- <save.json> [--out <output.json>]
// Node's type stripping loads this directly; it has no imports, so no build is needed.
import { EntityCompressor, decompressEntities } from '../src/entity-compression.ts';
import { fail, readSaveFromArgs, writeSave } from './save-file.mjs';

const { save, output } = readSaveFromArgs('pack-save');

// A save only bundles the definitions it used, so keys are sparse; placeholders keep each definition at its saved key.
const definitions = [];
let nextKey = 0;
const keys = Object.keys(save.entityDefinitions).map(Number).sort((a, b) => a - b);
for(const key of keys) {
	if(key < nextKey) {
		fail(`entityDefinitions overlap at key ${key}`);
	}
	for(; nextKey < key; nextKey++) {
		// No real entity has this type, so placeholders are never used or bundled.
		definitions.push({ type: `${String.fromCharCode(0)}unused-${nextKey}`, properties: [] });
	}
	const definition = save.entityDefinitions[key];
	definitions.push(definition);
	nextKey += definition.types?.length ?? 1;
}

const compressor = new EntityCompressor(definitions);
// Decompress first so an already partly packed save round-trips.
save.entities = decompressEntities(save.entities, save.entityDefinitions).map(config => compressor.compress(config));
save.entityDefinitions = compressor.entityDefinitions;

writeSave(output, save);
const packed = save.entities.filter(entity => typeof entity === 'string').length;
console.warn(`Packed ${packed} of ${save.entities.length} entities -> ${output}`);
