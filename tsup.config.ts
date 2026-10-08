import { defineConfig } from 'tsup'

// The web builds swap React for preact/compat so the widget ships without React.
const preactAlias = {
  react: 'preact/compat',
  'react-dom': 'preact/compat',
  'react-dom/client': 'preact/compat/client',
  'react/jsx-runtime': 'preact/jsx-runtime',
}
const webBase = {
  platform: 'browser' as const,
  treeshake: true,
  noExternal: [/.*/],
  esbuildOptions(o: { alias?: Record<string, string> }) {
    o.alias = { ...o.alias, ...preactAlias }
  },
}

export default defineConfig([
  {
    entry: { 'core/index': 'src/core/index.ts', 'react/index': 'src/react/index.ts' },
    format: ['esm'], dts: true, splitting: true, treeshake: true,
    external: ['react', 'react-dom', 'react/jsx-runtime'],
  },
  {
    entry: { 'web/index': 'src/web/index.ts' },
    format: ['esm'], dts: true, splitting: true,
    ...webBase,
    // dts must not see the alias; it only needs our own types.
    dts: { entry: { 'web/index': 'src/web/index.ts' } },
  },
  {
    entry: { 'dalil': 'src/web/index.ts' },
    format: ['iife'], globalName: 'Dalil', splitting: false, minify: true,
    ...webBase,
  },
])
