import { cpSync, mkdirSync } from 'node:fs'
import { defineConfig } from 'tsup'

// The portable replay inlines these into its HTML; the widget fetches them from dist/assets at runtime.
function copyPlayerAssets() {
  mkdirSync('dist/assets', { recursive: true })
  for (const f of ['rrweb-player.2.1.7.js', 'rrweb-player.2.1.7.css']) cpSync(`worker/public/assets/${f}`, `dist/assets/${f}`)
}

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

// dalil/angular and dalil/next must share the single dalil/web instance the app imports: keep it external.
const webExternal = {
  name: 'dalil-web-external',
  setup(b: { onResolve: (o: { filter: RegExp }, cb: () => { path: string; external: true }) => void }) {
    b.onResolve({ filter: /^\.\.\/web$/ }, () => ({ path: 'dalil/web', external: true }))
  },
}

export default defineConfig([
  {
    entry: { 'core/index': 'src/core/index.ts' },
    format: ['esm'], dts: true, splitting: true, treeshake: true,
    external: ['react', 'react-dom', 'react/jsx-runtime'],
  },
  {
    entry: { 'react/index': 'src/react/index.ts' },
    format: ['esm'], dts: true, splitting: true,
    external: ['react', 'react-dom', 'react/jsx-runtime'],
    banner: { js: '"use client";' },
  },
  {
    entry: { 'angular/index': 'src/angular/index.ts' },
    format: ['esm'], dts: true, splitting: false, treeshake: true, platform: 'browser',
    external: ['@angular/core', '@angular/common', 'dalil/web'],
    esbuildPlugins: [webExternal],
  },
  {
    entry: { 'next/index': 'src/next/index.tsx' },
    format: ['esm'], dts: true, splitting: false, platform: 'browser',
    external: ['react', 'react-dom', 'react/jsx-runtime', 'dalil/web'],
    esbuildPlugins: [webExternal],
      },
  {
    entry: { 'web/index': 'src/web/index.ts' },
    format: ['esm'], splitting: true,
    ...webBase,
    define: { __DALIL_IIFE__: 'false' },
    // dts must not see the alias; it only needs our own types.
    dts: { entry: { 'web/index': 'src/web/index.ts' } },
  },
  {
    entry: { 'dalil': 'src/web/index.ts' },
    format: ['iife'], globalName: 'Dalil', splitting: false, minify: true,
    ...webBase,
    define: { __DALIL_IIFE__: 'true' },
    onSuccess: async () => copyPlayerAssets(),
  },
])
