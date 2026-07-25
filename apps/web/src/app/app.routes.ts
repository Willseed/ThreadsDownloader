import { type Routes } from '@angular/router';

import { DownloaderPageComponent } from './features/downloader/downloader-page.js';
import { DownloaderWorkflow } from './features/downloader/downloader-workflow.js';
import { CopyrightPageComponent } from './features/legal/copyright-page.js';
import { PrivacyPageComponent } from './features/legal/privacy-page.js';
import { TermsPageComponent } from './features/legal/terms-page.js';

export const appRoutes: Routes = [
  {
    path: '',
    pathMatch: 'full',
    component: DownloaderPageComponent,
    providers: [DownloaderWorkflow],
  },
  { path: 'terms', title: '使用條款｜Threads Downloader', component: TermsPageComponent },
  {
    path: 'privacy',
    title: '隱私與資料處理｜Threads Downloader',
    component: PrivacyPageComponent,
  },
  {
    path: 'copyright',
    title: '著作權與下架通知｜Threads Downloader',
    component: CopyrightPageComponent,
  },
  { path: '**', redirectTo: '' },
];
