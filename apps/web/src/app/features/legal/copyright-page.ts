import { NgTemplateOutlet } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';

import { I18nService } from '../../core/i18n/i18n.js';
import { ResearchPurposeNoticeComponent } from './research-purpose-notice.js';

@Component({
  selector: 'app-copyright-page',
  imports: [NgTemplateOutlet, ResearchPurposeNoticeComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (modal()) {
      <div class="legal-modal-document"><ng-container [ngTemplateOutlet]="legalContent" /></div>
    } @else {
      <main id="main-content" class="legal-page" aria-labelledby="page-title">
        <header class="legal-hero">
          <p class="eyebrow">{{ text().eyebrow }}</p>
          <h1 id="page-title">{{ text().title }}</h1>
          <p>{{ text().introduction }}</p>
        </header>
        <ng-container [ngTemplateOutlet]="legalContent" />
      </main>
    }

    <ng-template #legalContent>
      <app-research-purpose-notice />
      <article class="legal-article">
        <section aria-labelledby="copyright-rights-title">
          <h2 id="copyright-rights-title">{{ text().rightsTitle }}</h2>
          <p>{{ text().rights }}</p>
        </section>

        <aside
          class="legal-status"
          aria-labelledby="copyright-status-title"
          data-legal-status="approved-for-production"
        >
          <p class="status-badge">{{ text().statusBadge }}</p>
          <h2 id="copyright-status-title">{{ text().statusTitle }}</h2>
          <p>{{ text().statusContact }}</p>
          <address>
            <a
              class="legal-contact-link"
              href="mailto:pony@pylot.dev"
              [attr.aria-label]="text().contactLabel"
              >pony@pylot.dev</a
            >
          </address>
          <p>{{ text().statusBoundary }}</p>
        </aside>

        <section aria-labelledby="copyright-notice-title">
          <h2 id="copyright-notice-title">{{ text().noticeTitle }}</h2>
          <p>{{ text().noticeIntro }}</p>
          <ul>
            <li>{{ text().noticeIdentity }}</li>
            <li>{{ text().noticeWork }}</li>
            <li>{{ text().noticeLocation }}</li>
            <li>{{ text().noticeBasis }}</li>
            <li>{{ text().noticeAccuracy }}</li>
          </ul>
        </section>

        <section aria-labelledby="copyright-process-title">
          <h2 id="copyright-process-title">{{ text().processTitle }}</h2>
          <p>{{ text().process }}</p>
        </section>

        <section aria-labelledby="copyright-affiliation-title">
          <h2 id="copyright-affiliation-title">{{ text().affiliationTitle }}</h2>
          <p>{{ text().affiliation }}</p>
        </section>
      </article>
    </ng-template>
  `,
})
export class CopyrightPageComponent {
  private readonly i18n = inject(I18nService);
  readonly modal = input(false);
  protected readonly text = computed(() => this.i18n.messages().copyright);
}
