import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RouterLink, RouterOutlet } from '@angular/router';

import {
  LegalModalOutletComponent,
  LegalModalTriggerDirective,
} from './features/legal/legal-modal.js';

@Component({
  selector: 'app-root',
  imports: [LegalModalOutletComponent, LegalModalTriggerDirective, RouterLink, RouterOutlet],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <a class="skip-link" href="#main-content">跳到主要內容</a>
    <header class="site-header" aria-label="網站標頭">
      <a class="wordmark" routerLink="/" aria-label="Threads Downloader 首頁">
        <span>Threads Downloader</span>
      </a>
      <nav class="site-nav" aria-label="主要導覽">
        <a routerLink="/" fragment="download-workflow">開始下載</a>
      </nav>
    </header>
    <router-outlet />
    <app-legal-modal-outlet />
    <footer class="site-footer">
      <p>本服務非 Threads 官方服務；使用者須自行確認內容權利，並遵守適用法律與平台條款。</p>
      <nav aria-label="法務資訊">
        <a href="/terms" legalModalTrigger="terms">使用條款</a>
        <a href="/privacy" legalModalTrigger="privacy">隱私與資料處理</a>
        <a href="/copyright" legalModalTrigger="copyright">著作權與下架通知</a>
      </nav>
    </footer>
  `,
})
export class AppComponent {}
