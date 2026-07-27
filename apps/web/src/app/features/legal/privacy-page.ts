import { NgTemplateOutlet } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';

import { I18nService } from '../../core/i18n/i18n.js';

@Component({
  selector: 'app-privacy-page',
  imports: [NgTemplateOutlet],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (modal()) {
      <div class="legal-modal-document">
        <ng-container [ngTemplateOutlet]="legalContent" />
      </div>
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
      <article class="legal-article">
        <section aria-labelledby="privacy-data-title">
          <h2 id="privacy-data-title">{{ text().dataTitle }}</h2>
          <ul>
            <li>{{ text().dataPost }}</li>
            <li>{{ text().dataCookie }}</li>
            <li>{{ text().dataIp }}</li>
            <li>{{ text().dataTurnstile }}</li>
            <li>{{ text().dataDownload }}</li>
          </ul>
        </section>

        <section aria-labelledby="privacy-purpose-title">
          <h2 id="privacy-purpose-title">{{ text().purposeTitle }}</h2>
          <p>{{ text().purpose }}</p>
        </section>

        <section aria-labelledby="privacy-recipient-title">
          <h2 id="privacy-recipient-title">{{ text().recipientTitle }}</h2>
          <ul>
            <li>{{ text().recipientCloudflare }}</li>
            <li>{{ text().recipientThreads }}</li>
            <li>{{ text().recipientInstagram }}</li>
          </ul>
          <p>{{ text().recipientBoundary }}</p>
        </section>

        <section aria-labelledby="privacy-retention-title">
          <h2 id="privacy-retention-title">{{ text().retentionTitle }}</h2>
          <dl class="retention-list">
            <div>
              <dt>{{ text().sessionLabel }}</dt>
              <dd>{{ text().sessionRetention }}</dd>
            </div>
            <div>
              <dt>{{ text().ipLabel }}</dt>
              <dd>{{ text().ipRetention }}</dd>
            </div>
            <div>
              <dt>{{ text().turnstileLabel }}</dt>
              <dd>{{ text().turnstileRetention }}</dd>
            </div>
            <div>
              <dt>{{ text().candidateLabel }}</dt>
              <dd>{{ text().candidateRetention }}</dd>
            </div>
            <div>
              <dt>{{ text().downloadLabel }}</dt>
              <dd>{{ text().downloadRetention }}</dd>
            </div>
          </dl>
          <p>{{ text().retentionBoundary }}</p>
        </section>

        <section aria-labelledby="privacy-security-title">
          <h2 id="privacy-security-title">{{ text().securityTitle }}</h2>
          <p>{{ text().security }}</p>
        </section>

        <section aria-labelledby="privacy-contact-title">
          <h2 id="privacy-contact-title">{{ text().contactTitle }}</h2>
          <p>{{ text().contact }}</p>
          <address>
            <a
              class="legal-contact-link"
              href="mailto:pony@pylot.dev"
              [attr.aria-label]="text().contactLabel"
              >pony@pylot.dev</a
            >
          </address>
        </section>

        <section aria-labelledby="privacy-review-title">
          <h2 id="privacy-review-title">{{ text().reviewTitle }}</h2>
          <p>{{ text().review }}</p>
        </section>
      </article>
    </ng-template>
  `,
})
export class PrivacyPageComponent {
  private readonly i18n = inject(I18nService);
  readonly modal = input(false);
  protected readonly text = computed(() => this.i18n.messages().privacy);
}
