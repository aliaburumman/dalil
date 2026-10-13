import { NgModule } from '@angular/core';
import { BrowserModule } from '@angular/platform-browser';
import { HttpClientModule } from '@angular/common/http';
import { RouterModule } from '@angular/router';
import { provideDalil } from 'dalil/angular';
import { AppComponent, HomeComponent, SecondComponent } from './app.component';

@NgModule({
  declarations: [AppComponent, HomeComponent, SecondComponent],
  imports: [
    BrowserModule,
    HttpClientModule, // XHR-based HttpClient
    RouterModule.forRoot([
      { path: '', component: HomeComponent },
      { path: 'second', component: SecondComponent },
    ]),
  ],
  providers: [
    provideDalil(() => {
      const q = new URLSearchParams(location.search);
      return {
        project: 'ngmodule-demo',
        publicKey: 'pk_demo',
        endpoint: q.get('collector') ?? 'http://localhost:8787/v1/reports',
        // ?ado=1 files a work item straight from the browser instead of posting to a collector
        ...(q.has('ado') ? { destination: { type: 'azure-devops' as const, org: 'o', project: 'p' } } : {}),
        apiOrigins: [location.origin],
      };
    }),
  ],
  bootstrap: [AppComponent],
})
export class AppModule {}
