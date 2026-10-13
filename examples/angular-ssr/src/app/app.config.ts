import { ApplicationConfig, provideBrowserGlobalErrorListeners } from '@angular/core';
import { provideHttpClient, withFetch } from '@angular/common/http';
import { provideRouter } from '@angular/router';
import { provideClientHydration } from '@angular/platform-browser';
import { provideDalil } from 'dalil/angular';
import { routes } from './app.routes';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideRouter(routes),
    provideClientHydration(),
    provideHttpClient(withFetch()),
    // Browser only: provideDalil does nothing on the server. The factory runs in the browser, so it can read the URL.
    provideDalil(() => {
      const q = new URLSearchParams(location.search);
      return {
        project: 'ssr-demo',
        publicKey: 'pk_demo',
        endpoint: q.get('collector') ?? 'http://localhost:8787/v1/reports',
        // ?ado=1 files a work item straight from the browser instead of posting to a collector
        ...(q.has('ado') ? { destination: { type: 'azure-devops' as const, org: 'o', project: 'p' } } : {}),
        apiOrigins: [location.origin],
      };
    }),
  ],
};
