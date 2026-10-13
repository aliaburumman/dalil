import { Component } from '@angular/core';
import { Routes } from '@angular/router';

@Component({ selector: 'app-home', template: `<p id="page">Home page</p>` })
export class Home {}

@Component({ selector: 'app-second', template: `<p id="page">Second page</p>` })
export class Second {}

export const routes: Routes = [
  { path: '', component: Home },
  { path: 'second', component: Second },
];
