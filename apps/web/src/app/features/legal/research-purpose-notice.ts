import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';

import { I18nService } from '../../core/i18n/i18n.js';

@Component({
  selector: 'app-research-purpose-notice',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="research-purpose" aria-labelledby="research-purpose-title">
      <h2 id="research-purpose-title">{{ text().title }}</h2>
      <div class="research-purpose-copy">
        <p>{{ text().purpose }}</p>
        <p>{{ text().boundary }}</p>
        <p>{{ text().authorization }}</p>
        <p>{{ text().access }}</p>
      </div>
    </section>
  `,
})
export class ResearchPurposeNoticeComponent {
  private readonly i18n = inject(I18nService);
  protected readonly text = computed(() => this.i18n.messages().researchPurpose);
}
