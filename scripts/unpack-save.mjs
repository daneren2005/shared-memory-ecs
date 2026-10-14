// Expands a save's packed entity strings back to plain configs, keeping entityDefinitions so pack-save can re-pack it. Usage:
//   npm run unpack-save -- <save.json> [--out <output.json>]
// Node's type stripping loads this directly; it has no imports, so no build is needed.
import { decompressEntities } from '../src/entity-compression.ts';
import { readSaveFromArgs, writeSave } from './save-file.mjs';

const { save, output } = readSaveFromArgs('unpack-save');
const packed = save.entities.filter(entity => typeof entity === 'string').length;
save.entities = decompressEntities(save.entities, save.entityDefinitions);

writeSave(output, save);
console.warn(`Unpacked ${packed} of ${save.entities.length} entities -> ${output}`);
