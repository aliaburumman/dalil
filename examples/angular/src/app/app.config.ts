import { ApplicationConfig, provideBrowserGlobalErrorListeners, provideZoneChangeDetection } from '@angular/core';
import { provideHttpClient } from '@angular/common/http';
import { provideToastr, ToastNoAnimation } from 'ngx-toastr';
import { provideDalil } from 'dalil/angular';
import { dalilConfig, mode } from './dalil.config';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideZoneChangeDetection(),
    provideHttpClient(),
    // ngx-toastr renders `.toast-error`, which Dalil watches by default.
    provideToastr({ toastComponent: ToastNoAnimation, timeOut: 20000 }),
    // provideDalil starts Dalil outside the zone. For the tick measurement it is skipped in the other two modes:
    // ?nodalil=1 (baseline, no Dalil) and ?inzone=1 (manual init inside the zone, see main.ts).
    ...(mode() === 'dalil' ? [provideDalil(dalilConfig)] : []),
  ],
};
