import { ChangeDetectionStrategy, Component } from '@angular/core';

import { ResearchPurposeNoticeComponent } from './research-purpose-notice.js';

@Component({
  selector: 'app-terms-page',
  imports: [ResearchPurposeNoticeComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <main id="main-content" class="legal-page" aria-labelledby="page-title">
      <header class="legal-hero">
        <p class="eyebrow">LEGAL / TERMS</p>
        <h1 id="page-title">使用條款</h1>
        <p>使用本服務前，請閱讀本服務的技術範圍、權利要求與法律界線。</p>
      </header>

      <app-research-purpose-notice />

      <article class="legal-article">
        <section aria-labelledby="terms-scope-title">
          <h2 id="terms-scope-title">服務範圍</h2>
          <ul>
            <li>本服務只接受支援網域中、無需登入即可存取的公開 Threads 貼文網址。</li>
            <li>
              本服務不接受 Threads 或 Instagram 的 Cookie、帳號憑證或登入
              token，也不得用來處理私人、受限制或須規避技術措施的內容。
            </li>
            <li>
              本服務提供公開貼文的影片候選解析與同源下載交付；來源可用性、內容完整性及瀏覽器最終儲存結果仍可能受來源與使用者環境影響。
            </li>
          </ul>
        </section>

        <section aria-labelledby="terms-rights-title">
          <h2 id="terms-rights-title">使用者責任與權利</h2>
          <ul>
            <li>使用者提交前須確認自己擁有內容、取得有效授權，或依適用法律得為預定使用。</li>
            <li>
              內容及相關著作權、商標與其他權利仍歸原權利人所有；本服務不授予任何第三方內容權利。
            </li>
            <li>
              下載後的保存、編輯、重製、再發布、分享或其他利用，由使用者依實際用途確認權利基礎與法律責任。
            </li>
            <li>不得藉本服務侵害他人權利、干擾服務安全，或規避來源平台的存取控制。</li>
          </ul>
        </section>

        <section aria-labelledby="terms-affiliation-title">
          <h2 id="terms-affiliation-title">第三方與非隸屬聲明</h2>
          <p>
            本服務並非 Meta、Instagram、Threads 或 SpaceX
            的官方產品，亦未獲其背書、授權、委託或合作。第三方內容與標誌的權利仍屬各權利人。
          </p>
        </section>

        <section aria-labelledby="terms-review-title">
          <h2 id="terms-review-title">營運者與定期審閱</h2>
          <p>
            本服務營運者顯示名稱為
            Pony。本頁不構成法律意見，亦不對特定下載作合法性判定；營運者應依實際所在地、資料流、服務情況與適用法律定期審閱本條款，並在營運條件或法律變動時更新。
          </p>
        </section>
      </article>
    </main>
  `,
})
export class TermsPageComponent {}
