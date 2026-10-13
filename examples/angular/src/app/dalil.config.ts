import type { DalilWebConfig } from 'dalil/angular';

const q = () => new URLSearchParams(location.search);
/** ?nodalil=1 runs without Dalil (tick baseline); ?inzone=1 starts it inside the zone (the comparison). */
export const mode = (): 'dalil' | 'nodalil' | 'inzone' => (q().has('nodalil') ? 'nodalil' : q().has('inzone') ? 'inzone' : 'dalil');

export const dalilConfig = (): DalilWebConfig => ({
  project: 'demo',
  publicKey: 'pk_demo',
  endpoint: 'http://localhost:8787/v1/reports', // a local collector may not run; the report is queued
  apiOrigins: ['http://localhost:4300'],
  enabled: false, // turned on by update() after login
});
