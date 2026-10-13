import { ApplicationRef, NgZone } from '@angular/core';
import { bootstrapApplication } from '@angular/platform-browser';
import { init } from 'dalil/web';
import { appConfig } from './app/app.config';
import { App } from './app/app';
import { dalilConfig, mode } from './app/dalil.config';

bootstrapApplication(App, appConfig)
  .then((appRef: ApplicationRef) => {
    const zone = appRef.injector.get(NgZone);
    // Count change detection runs so the zone cost is measurable.
    const w = window as unknown as { __ticks: number; __inZone: boolean };
    w.__ticks = 0;
    w.__inZone = mode() === 'inzone';
    // onMicrotaskEmpty fires each time zone-based change detection is scheduled to run.
    zone.onMicrotaskEmpty.subscribe(() => w.__ticks++);
    // The normal path is provideDalil (outside the zone, see app.config.ts). ?inzone=1 is the comparison:
    // start Dalil by hand inside Angular's zone to show what that costs.
    if (mode() === 'inzone') init(dalilConfig());
  })
  .catch((err) => console.error(err));
