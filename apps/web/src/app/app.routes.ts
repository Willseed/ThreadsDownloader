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
  { path: '**', redirectTo: '' },
];
