# Dalil, Angular SSR example

Angular 22, standalone, `@angular/ssr` (request-time SSR) with `provideClientHydration()`, `HttpClient` `withFetch()`, `provideDalil` in `app.config.ts`.
The Express server (`src/server.ts`) also answers `/api/fail` with 500.

```sh
npm run build        # at the repo root first
cd examples/angular-ssr && npm i && npx ng build --configuration development
PORT=4000 node dist/angular-ssr/server/server.mjs
```

`?collector=<url>` sets the collector endpoint, `?ado=1` switches to Azure DevOps mode. Check: `node scripts/e2e-angular.mjs --app angular-ssr`.
