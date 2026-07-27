import { NgTemplateOutlet } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';

import { I18nService } from '../../core/i18n/i18n.js';
import { ResearchPurposeNoticeComponent } from './research-purpose-notice.js';

@Component({
  selector: 'app-terms-page',
  imports: [NgTemplateOutlet, ResearchPurposeNoticeComponent],
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
      <app-research-purpose-notice />

      <article class="legal-article">
        <section aria-labelledby="terms-scope-title">
          <h2 id="terms-scope-title">{{ text().scopeTitle }}</h2>
          <ul>
            <li>{{ text().scopePublic }}</li>
            <li>{{ text().scopeCredentials }}</li>
            <li>{{ text().scopeDelivery }}</li>
          </ul>
        </section>

        <section aria-labelledby="terms-rights-title">
          <h2 id="terms-rights-title">{{ text().rightsTitle }}</h2>
          <ul>
            <li>{{ text().rightsBasis }}</li>
            <li>{{ text().rightsOwnership }}</li>
            <li>{{ text().rightsUse }}</li>
            <li>{{ text().rightsAbuse }}</li>
          </ul>
        </section>

        <section aria-labelledby="terms-affiliation-title">
          <h2 id="terms-affiliation-title">{{ text().affiliationTitle }}</h2>
          <p>{{ text().affiliation }}</p>
        </section>

        <section aria-labelledby="terms-review-title">
          <h2 id="terms-review-title">{{ text().reviewTitle }}</h2>
          <p>{{ text().review }}</p>
        </section>
      </article>
    </ng-template>
  `,
})
export class TermsPageComponent {
  private readonly i18n = inject(I18nService);
  readonly modal = input(false);
  protected readonly text = computed(() => this.i18n.messages().terms);
}
