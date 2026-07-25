import { provideHttpClient } from '@angular/common/http';
import { provideZonelessChangeDetection } from '@angular/core';
import { bootstrapApplication } from '@angular/platform-browser';
import { provideRouter } from '@angular/router';

import { AppComponent } from './app/app.js';
import { appRoutes } from './app/app.routes.js';

void bootstrapApplication(AppComponent, {
  providers: [provideHttpClient(), provideRouter(appRoutes), provideZonelessChangeDetection()],
});
