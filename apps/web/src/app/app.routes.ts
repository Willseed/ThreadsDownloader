import { type Routes } from '@angular/router';

import { DownloaderPageComponent } from './features/downloader/downloader-page.js';
import { DownloaderWorkflow } from './features/downloader/downloader-workflow.js';

export const appRoutes: Routes = [
  {
    path: '',
    pathMatch: 'full',
    component: DownloaderPageComponent,
    data: { titleKey: 'home' },
    providers: [DownloaderWorkflow],
  },
  {
    path: 'terms',
    data: { titleKey: 'terms' },
    loadComponent: () =>
      import('./features/legal/terms-page.js').then(({ TermsPageComponent }) => TermsPageComponent),
  },
  {
    path: 'privacy',
    data: { titleKey: 'privacy' },
    loadComponent: () =>
      import('./features/legal/privacy-page.js').then(
        ({ PrivacyPageComponent }) => PrivacyPageComponent,
      ),
  },
  {
    path: 'copyright',
    data: { titleKey: 'copyright' },
    loadComponent: () =>
      import('./features/legal/copyright-page.js').then(
        ({ CopyrightPageComponent }) => CopyrightPageComponent,
      ),
  },
  { path: '**', redirectTo: '' },
];
