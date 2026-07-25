import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RouterLink, RouterOutlet } from '@angular/router';

@Component({
  selector: 'app-root',
  imports: [RouterLink, RouterOutlet],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <a class="skip-link" href="#main-content">跳到主要內容</a>
    <header class="site-header" aria-label="網站標頭">
      <a class="wordmark" routerLink="/" aria-label="Threads Downloader 首頁">
        <span aria-hidden="true">TD / 01</span>
        <span>Threads Downloader</span>
      </a>
      <p>Public media research utility</p>
    </header>
    <router-outlet />
  `,
})
export class AppComponent {}
