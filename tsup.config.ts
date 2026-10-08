import { defineConfig } from 'tsup'
export default defineConfig({
  entry: { 'core/index': 'src/core/index.ts', 'react/index': 'src/react/index.ts' },
  format: ['esm'], dts: true, splitting: true, clean: true, treeshake: true,
  external: ['react', 'react-dom', 'react/jsx-runtime'],
})
