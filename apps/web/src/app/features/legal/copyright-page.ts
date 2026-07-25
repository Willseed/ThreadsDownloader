import { ChangeDetectionStrategy, Component } from '@angular/core';

import { ResearchPurposeNoticeComponent } from './research-purpose-notice.js';

@Component({
  selector: 'app-copyright-page',
  imports: [ResearchPurposeNoticeComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <main id="main-content" class="legal-page" aria-labelledby="page-title">
      <header class="legal-hero">
        <p class="eyebrow">LEGAL / COPYRIGHT</p>
        <h1 id="page-title">著作權與下架通知</h1>
        <p>公開於網路的內容仍可能受到著作權及其他權利保護。</p>
      </header>

      <app-research-purpose-notice />

      <article class="legal-article">
        <section aria-labelledby="copyright-rights-title">
          <h2 id="copyright-rights-title">權利邊界</h2>
          <p>
            公開可見不表示內容可任意下載、重製、保存、分享或為其他利用。研究或非商業目的亦不當然構成授權或任何法域下的限制與例外。內容及相關權利仍歸原權利人所有，使用者須依實際用途確認其權利或適法依據。
          </p>
        </section>

        <aside
          class="legal-status"
          aria-labelledby="copyright-status-title"
          data-legal-status="pending-operator-identity-and-legal-review"
        >
          <p class="status-badge">暫不可正式上線</p>
          <h2 id="copyright-status-title">營運者識別與法務審閱尚未完成</h2>
          <p>著作權與下架受理聯絡方式已提供。權利人或其授權代表可寄送通知至：</p>
          <address>
            <a
              class="legal-contact-link"
              href="mailto:pony@pylot.dev"
              aria-label="寄送著作權或下架通知至 pony@pylot.dev"
              >pony@pylot.dev</a
            >
          </address>
          <p>
            正式營運者名稱仍待提供，且本頁正式上線前仍須經法務審閱；在完成前，本頁不猜測營運者身分、法域或法定程序。
          </p>
        </aside>

        <section aria-labelledby="copyright-notice-title">
          <h2 id="copyright-notice-title">通知應包含的資料</h2>
          <p>為利依可核實事實進行合理檢視，通知者宜提供：</p>
          <ul>
            <li>通知者姓名或組織名稱，以及可回覆的聯絡方式。</li>
            <li>主張權利的作品及可核對的原始來源。</li>
            <li>涉及申訴的 Threads 網址、本站頁面或其他足以識別內容的資訊。</li>
            <li>通知者的權利基礎，以及希望服務採取的措施。</li>
            <li>足以確認通知內容正確性與授權身分的說明。</li>
          </ul>
        </section>

        <section aria-labelledby="copyright-process-title">
          <h2 id="copyright-process-title">流程界線</h2>
          <p>
            本頁目前只描述一般權利通知資訊，不聲稱適用任何特定國家或地區的通知與下架、安全港或反通知制度，也不捏造法定格式、處理期限、自動移除規則、責任認定、準據法或管轄。
          </p>
        </section>

        <section aria-labelledby="copyright-affiliation-title">
          <h2 id="copyright-affiliation-title">非官方隸屬</h2>
          <p>
            本服務並非 Meta、Instagram、Threads 或 SpaceX
            的官方產品，亦未獲其背書、授權、委託或合作。
          </p>
        </section>
      </article>
    </main>
  `,
})
export class CopyrightPageComponent {}
