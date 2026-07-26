import { type Routes } from '@angular/router';

import { DownloaderPageComponent } from './features/downloader/downloader-page.js';
import { DownloaderWorkflow } from './features/downloader/downloader-workflow.js';

export const appRoutes: Routes = [
  {
    path: '',
    pathMatch: 'full',
    component: DownloaderPageComponent,
    providers: [DownloaderWorkflow],
  },
  {
    path: 'terms',
    title: '使用條款｜Threads Downloader',
    loadComponent: () =>
      import('./features/legal/terms-page.js').then(({ TermsPageComponent }) => TermsPageComponent),
  },
  {
    path: 'privacy',
    title: '隱私與資料處理｜Threads Downloader',
    loadComponent: () =>
      import('./features/legal/privacy-page.js').then(
        ({ PrivacyPageComponent }) => PrivacyPageComponent,
      ),
  },
  {
    path: 'copyright',
    title: '著作權與下架通知｜Threads Downloader',
    loadComponent: () =>
      import('./features/legal/copyright-page.js').then(
        ({ CopyrightPageComponent }) => CopyrightPageComponent,
      ),
  },
  { path: '**', redirectTo: '' },
];
