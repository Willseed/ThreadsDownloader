import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { RouterLink, RouterOutlet } from '@angular/router';

import { I18nService } from './core/i18n/i18n.js';
import {
  LegalModalOutletComponent,
  LegalModalTriggerDirective,
} from './features/legal/legal-modal.js';

@Component({
  selector: 'app-root',
  imports: [LegalModalOutletComponent, LegalModalTriggerDirective, RouterLink, RouterOutlet],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <a class="skip-link" href="#main-content">{{ text().skipLink }}</a>
    <header class="site-header" [attr.aria-label]="text().headerLabel">
      <a class="wordmark" routerLink="/" [attr.aria-label]="text().homeLabel">
        <span>{{ text().brand }}</span>
      </a>
      <nav class="site-nav" [attr.aria-label]="text().primaryNavigationLabel">
        <a routerLink="/" fragment="download-workflow">{{ text().startDownload }}</a>
      </nav>
    </header>
    <router-outlet />
    <app-legal-modal-outlet />
    <footer class="site-footer">
      <p>{{ text().disclaimer }}</p>
      <nav [attr.aria-label]="text().legalNavigationLabel">
        <a href="/terms" legalModalTrigger="terms">{{ text().terms }}</a>
        <a href="/privacy" legalModalTrigger="privacy">{{ text().privacy }}</a>
        <a href="/copyright" legalModalTrigger="copyright">{{ text().copyright }}</a>
      </nav>
    </footer>
  `,
})
export class AppComponent {
  private readonly i18n = inject(I18nService);
  protected readonly text = computed(() => this.i18n.messages().app);
}
