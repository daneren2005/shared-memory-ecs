import { defineConfig } from 'vite';

// Bundles the library entry (src/index.ts) into dist/index.js as an ES module.
// Type declarations are emitted separately by `tsc --emitDeclarationOnly` (see package.json build).
export default defineConfig({
	build: {
		lib: {
			entry: 'src/index.ts',
			formats: ['es'],
			fileName: () => 'index.js',
		},
		sourcemap: true,
		// Keep runtime dependencies external so they are not inlined into the bundle.
		rollupOptions: {
			external: [
				'eventemitter3',
				/^@daneren2005\/shared-memory-objects(\/.*)?$/,
			],
		},
	},
});
