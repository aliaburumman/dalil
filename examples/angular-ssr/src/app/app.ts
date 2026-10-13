import { Component, inject, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { RouterLink, RouterOutlet } from '@angular/router';

@Component({
  imports: [RouterOutlet, RouterLink],
  selector: 'app-root',
  template: `
    <h1>Dalil, Angular SSR</h1>
    <nav><a id="to-home" routerLink="/">Home</a> | <a id="to-second" routerLink="/second">Second</a></nav>
    <router-outlet />
    <button id="http500" (click)="http500()">fetch 500</button>
    <button id="toast" (click)="showToast.set(true)">Error toast</button>
    @if (showToast()) {
      <div class="toast-error" role="alert">Could not save the payment</div>
    }
    <pre id="out">{{ out() }}</pre>
  `,
})
export class App {
  private http = inject(HttpClient);
  protected out = signal('');
  protected showToast = signal(false);
  http500() {
    this.http.get('/api/fail').subscribe({
      next: () => this.out.set('ok'),
      error: (e) => this.out.set('HttpClient error ' + e.status),
    });
  }
}
