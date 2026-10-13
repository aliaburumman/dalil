# Dalil, Angular zoneless example

Angular 22, `provideZonelessChangeDetection()`, no zone.js, standalone, `HttpClient` `withFetch()`, `provideDalil`.

```sh
npm run build        # at the repo root first
cd examples/angular-zoneless && npm i && npx ng build
```

`/api/fail` must answer 500 (the e2e's static server does). `?collector=<url>` sets the endpoint, `?ado=1` switches to Azure DevOps mode.
Check: `node scripts/e2e-angular.mjs --app angular-zoneless`.
