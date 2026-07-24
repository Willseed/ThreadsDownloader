import { provideHttpClient } from '@angular/common/http';
import { provideZonelessChangeDetection } from '@angular/core';
import { bootstrapApplication } from '@angular/platform-browser';
import { provideRouter } from '@angular/router';

import { AppComponent } from './app/app.js';

void bootstrapApplication(AppComponent, {
  providers: [provideHttpClient(), provideRouter([]), provideZonelessChangeDetection()],
});
