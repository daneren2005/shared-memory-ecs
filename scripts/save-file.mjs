// Shared CLI plumbing for pack-save/unpack-save: `<save.json> [--out <output.json>]`, overwriting the input by default.
import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

export function readSaveFromArgs(command) {
	const { values, positionals } = parseArgs({
		allowPositionals: true,
		options: { out: { type: 'string' } },
	});
	if(positionals.length !== 1) {
		fail(`Usage: npm run ${command} -- <save.json> [--out <output.json>]`);
	}

	const input = positionals[0];
	const save = JSON.parse(readFileSync(input, 'utf8'));
	if(!save || !Array.isArray(save.entities)) {
		fail(`${input} has no entities array`);
	}
	if(!save.entityDefinitions) {
		fail(`${input} has no entityDefinitions`);
	}
	return { save, output: values.out ?? input };
}

export function writeSave(output, save) {
	writeFileSync(output, JSON.stringify(save, null, '\t'));
}

export function fail(message) {
	console.error(message);
	process.exit(1);
}
