import { provideHttpClient } from '@angular/common/http';
import { provideZonelessChangeDetection } from '@angular/core';
import { bootstrapApplication } from '@angular/platform-browser';
import { provideRouter, TitleStrategy } from '@angular/router';

import { AppComponent } from './app/app.js';
import { appRoutes } from './app/app.routes.js';
import { LocalizedTitleStrategy } from './app/core/i18n/i18n.js';

void bootstrapApplication(AppComponent, {
  providers: [
    provideHttpClient(),
    provideRouter(appRoutes),
    provideZonelessChangeDetection(),
    { provide: TitleStrategy, useClass: LocalizedTitleStrategy },
  ],
});
