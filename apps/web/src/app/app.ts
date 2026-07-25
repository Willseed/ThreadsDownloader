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
      <nav class="site-nav" aria-label="主要導覽">
        <a routerLink="/">下載工具</a>
        <a routerLink="/terms">條款</a>
        <a routerLink="/privacy">隱私</a>
        <a routerLink="/copyright">著作權</a>
      </nav>
    </header>
    <router-outlet />
    <footer class="site-footer">
      <p>Public media research utility</p>
      <nav aria-label="法務資訊">
        <a routerLink="/terms">使用條款</a>
        <a routerLink="/privacy">隱私與資料處理</a>
        <a routerLink="/copyright">著作權與下架通知</a>
      </nav>
    </footer>
  `,
})
export class AppComponent {}
