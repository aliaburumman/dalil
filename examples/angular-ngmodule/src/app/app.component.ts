import { Component } from '@angular/core';
import { HttpClient } from '@angular/common/http';

@Component({ selector: 'app-home', template: `<p id="page">Home page</p>` })
export class HomeComponent {}

@Component({ selector: 'app-second', template: `<p id="page">Second page</p>` })
export class SecondComponent {}

@Component({
  selector: 'app-root',
  template: `
    <h1>Dalil, Angular NgModule</h1>
    <nav><a id="to-home" routerLink="/">Home</a> | <a id="to-second" routerLink="/second">Second</a></nav>
    <router-outlet></router-outlet>
    <button id="http500" (click)="http500()">XHR 500</button>
    <button id="toast" (click)="showToast = true">Error toast</button>
    <div *ngIf="showToast" class="toast-error" role="alert">Could not save the payment</div>
    <pre id="out">{{ out }}</pre>
  `,
})
export class AppComponent {
  out = '';
  showToast = false;
  constructor(private http: HttpClient) {}
  http500() {
    this.http.get('/api/fail').subscribe({
      next: () => (this.out = 'ok'),
      error: (e) => (this.out = 'HttpClient error ' + e.status),
    });
  }
}
