import { ApplicationConfig, provideBrowserGlobalErrorListeners, provideZonelessChangeDetection } from '@angular/core';
import { provideHttpClient, withFetch } from '@angular/common/http';
import { provideRouter } from '@angular/router';
import { provideDalil } from 'dalil/angular';
import { routes } from './app.routes';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideZonelessChangeDetection(),
    provideRouter(routes),
    provideHttpClient(withFetch()),
    provideDalil(() => {
      const q = new URLSearchParams(location.search);
      return {
        project: 'zoneless-demo',
        publicKey: 'pk_demo',
        endpoint: q.get('collector') ?? 'http://localhost:8787/v1/reports',
        ...(q.has('ado') ? { destination: { type: 'azure-devops' as const, org: 'o', project: 'p' } } : {}),
        apiOrigins: [location.origin],
      };
    }),
  ],
};
