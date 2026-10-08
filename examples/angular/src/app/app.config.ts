import { ApplicationConfig, provideBrowserGlobalErrorListeners, provideZoneChangeDetection } from '@angular/core';
import { provideHttpClient } from '@angular/common/http';
import { provideToastr, ToastNoAnimation } from 'ngx-toastr';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideZoneChangeDetection(),
    provideHttpClient(),
    // ngx-toastr renders `.toast-error`, which Dalil watches by default.
    provideToastr({ toastComponent: ToastNoAnimation, timeOut: 20000 }),
  ],
};
