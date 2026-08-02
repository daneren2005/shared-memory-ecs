import { defineConfig } from 'vite';

// Bundles the library entries into dist/ as ES modules.  `index` is the full library; `worker` is a slim
// worker-thread entry (see src/worker.ts) that lets one-per-file worker bundles avoid pulling the whole barrel.
// Type declarations are emitted separately by `tsc --emitDeclarationOnly` (see package.json build).
export default defineConfig({
	build: {
		lib: {
			entry: {
				index: 'src/index.ts',
				worker: 'src/worker.ts',
			},
			formats: ['es'],
		},
		sourcemap: true,
		// Keep runtime dependencies external so they are not inlined into the bundle.
		rollupOptions: {
			external: [
				/^@daneren2005\/shared-memory-objects(\/.*)?$/,
			],
		},
	},
});
