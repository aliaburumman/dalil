import { ApplicationRef, NgZone } from '@angular/core';
import { bootstrapApplication } from '@angular/platform-browser';
import { init } from 'dalil/web';
import { appConfig } from './app/app.config';
import { App } from './app/app';

const inZone = new URLSearchParams(location.search).has('inzone');
const dalilConfig = {
  project: 'demo',
  publicKey: 'pk_demo',
  endpoint: 'http://localhost:8787/v1/reports', // a local collector may not run; the report is queued
  apiOrigins: ['http://localhost:4300'],
  enabled: false, // turned on by update() after login
};

bootstrapApplication(App, appConfig)
  .then((appRef: ApplicationRef) => {
    const zone = appRef.injector.get(NgZone);
    // Count change detection runs so the zone cost is measurable.
    const w = window as unknown as { __ticks: number; __inZone: boolean };
    w.__ticks = 0;
    w.__inZone = inZone;
    // onMicrotaskEmpty fires each time zone-based change detection is scheduled to run.
    zone.onMicrotaskEmpty.subscribe(() => w.__ticks++);
    // The point of this example: keep the recorder's timers and observers out of Angular's zone.
    if (new URLSearchParams(location.search).has('nodalil')) return;
    if (inZone) init(dalilConfig);
    else zone.runOutsideAngular(() => init(dalilConfig));
  })
  .catch((err) => console.error(err));
