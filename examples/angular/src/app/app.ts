import { Component, NgZone, inject, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { ToastrService } from 'ngx-toastr';
import { update } from 'dalil/web';

@Component({
  selector: 'app-root',
  template: `
    <h1>Dalil, Angular</h1>
    <button id="login" (click)="toggleLogin()">{{ loggedIn() ? 'Log out' : 'Log in' }}</button>
    <button id="http500" (click)="http500()">HttpClient 500</button>
    <button id="toast" (click)="toast()">Error toast</button>
    <button id="throw" (click)="boom()">Throw in handler</button>
    <input id="typing" placeholder="type here" />
    <pre id="out">{{ out() }}</pre>
  `,
})
export class App {
  private http = inject(HttpClient);
  private toastr = inject(ToastrService);
  private zone = inject(NgZone);
  protected loggedIn = signal(false);
  protected out = signal('');

  toggleLogin() {
    this.loggedIn.update((v) => !v);
    const enabled = this.loggedIn();
    // update() mounts/unmounts the widget, which registers listeners and observers, so it
    // too must run outside Angular's zone (the ?inzone=1 comparison keeps it inside).
    const run = (inZone: boolean) => (inZone ? (f: () => void) => f() : (f: () => void) => this.zone.runOutsideAngular(f));
    run(new URLSearchParams(location.search).has('inzone'))(() =>
      update({ enabled, getContext: () => ({ userId: 'u1', userName: 'Demo user', tenant: 'Example' }) }),
    );
  }
  http500() {
    this.http.get('http://localhost:4300/api/fail').subscribe({
      next: () => this.out.set('ok'),
      error: (e) => this.out.set('HttpClient error ' + e.status),
    });
  }
  toast() {
    this.toastr.error('Could not save the payment', 'Error');
  }
  boom() {
    throw new Error('Demo click handler failure');
  }
}
