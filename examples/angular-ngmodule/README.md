# Dalil, Angular 16 NgModule example

Angular 16.2, `AppModule`, `@angular-devkit/build-angular:browser` (webpack), `HttpClientModule` (XHR), `RouterModule` with two routes,
`providers: [provideDalil(...)]` in `AppModule`.

Angular 16's CLI needs Node 18, so install with any Node and build with a pinned Node 18 (the machine's Node can stay newer):

```sh
npm run build                        # at the repo root first (this app uses "dalil": "file:../..")
cd examples/angular-ngmodule
npm i                                # .npmrc: install-links (dalil is copied, not symlinked), legacy-peer-deps
npx -y -p node@18 node node_modules/@angular/cli/bin/ng.js build
```

`install-links=true` matters in this monorepo: with a symlink, `dalil/dist` would resolve `@angular/core` from the repo root's devDependencies
(a different Angular major) instead of this app. Re-run `npm i` after rebuilding the repo root.

Run the headless check from the repo root: `node scripts/e2e-angular.mjs --app angular-ngmodule`.
Query switches: `?collector=<url>` (collector endpoint), `?ado=1` (Azure DevOps mode, org `o`, project `p`).
