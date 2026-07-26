import { NgTemplateOutlet } from '@angular/common';
import { ChangeDetectionStrategy, Component, input } from '@angular/core';

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
          <p class="eyebrow">LEGAL / PRIVACY</p>
          <h1 id="page-title">隱私與資料處理說明</h1>
          <p>本頁依目前程式碼所實作的資料流，說明本服務處理的資料、用途、接收者與邏輯保存期限。</p>
        </header>
        <ng-container [ngTemplateOutlet]="legalContent" />
      </main>
    }

    <ng-template #legalContent>
      <article class="legal-article">
        <section aria-labelledby="privacy-data-title">
          <h2 id="privacy-data-title">處理的資料</h2>
          <ul>
            <li>
              使用者輸入的公開 Threads
              貼文網址、權利確認，以及解析後的貼文短碼、候選檔名、尺寸、長度與其他安全中繼資料。
            </li>
            <li>
              本服務設定匿名的 <code>__Host-td_session</code> 工作階段 Cookie；其屬性為
              <code>HttpOnly</code>、<code>Secure</code>、<code>SameSite=Lax</code>
              且限本站路徑。伺服器另處理工作階段與 CSRF token 的雜湊及到期時間。
            </li>
            <li>
              連線 IP
              會在請求處理期間用於安全驗證，並以帶有服務端金鑰的雜湊識別值進行短期限流；本頁不宣稱服務完全不處理
              IP。
            </li>
            <li>Cloudflare Turnstile 驗證 token、其短期防重放雜湊、驗證時間與安全請求識別資料。</li>
            <li>
              下載工作所需的不透明識別碼、密封的來源媒體網址、檔案安全中繼資料、Range
              區間、工作狀態、租約與時間戳記。
            </li>
          </ul>
        </section>

        <section aria-labelledby="privacy-purpose-title">
          <h2 id="privacy-purpose-title">處理目的</h2>
          <p>
            上述資料用於建立匿名工作階段、驗證同源請求、解析公開貼文、將下載交付給瀏覽器、支援中斷續傳，以及防止重放、濫用與超額並行。服務不要求使用者提供
            Threads 或 Instagram 的登入 Cookie、帳號密碼或存取
            token，也不會把這類登入憑證轉交來源服務。
          </p>
        </section>

        <section aria-labelledby="privacy-recipient-title">
          <h2 id="privacy-recipient-title">資料接收者與外部服務</h2>
          <ul>
            <li>
              Cloudflare Workers 與 Durable Objects 處理本站請求、短期狀態與串流；Cloudflare
              Turnstile 接收驗證 token、連線 IP 及驗證所需的瀏覽器與請求資料。
            </li>
            <li>Threads 接收伺服器為讀取使用者所提交公開貼文而發出的 HTTPS 請求。</li>
            <li>
              Instagram 內容傳遞網路（CDN）接收伺服器為確認媒體與交付 Range 內容而發出的 HTTPS
              請求。
            </li>
          </ul>
          <p>
            因此，本服務不宣稱沒有第三方處理。Cloudflare
            基礎設施的邊緣安全紀錄、備份與其各自保存政策不由此應用程式程式碼決定，應依其當時有效的政策與實際服務設定定期審閱。
          </p>
        </section>

        <section aria-labelledby="privacy-retention-title">
          <h2 id="privacy-retention-title">應用程式邏輯保存期限</h2>
          <dl class="retention-list">
            <div>
              <dt>匿名工作階段</dt>
              <dd>
                Cookie、工作階段雜湊與 CSRF 雜湊最長 12 小時；到期後由工作階段儲存的鬧鐘清除。
              </dd>
            </div>
            <div>
              <dt>IP 限流</dt>
              <dd>
                解析事件使用 60 秒限流視窗，作用中的解析許可最長 30
                秒。建立匿名工作階段時，帶有服務端金鑰的 IP
                雜湊、核發額度事件及必要的不透明預約資料最長保留 12 小時；短效預約為 30
                秒，無待處理資料後刪除該限流狀態。
              </dd>
            </div>
            <div>
              <dt>Turnstile 防重放</dt>
              <dd>原始 token 只在驗證流程中處理；應用程式保存其防重放雜湊最長 5 分鐘。</dd>
            </div>
            <div>
              <dt>解析候選</dt>
              <dd>
                貼文短碼、候選安全中繼資料及密封授權最長 5 分鐘；建立與保留候選的暫態租約為 30 秒。
              </dd>
            </div>
            <div>
              <dt>下載工作</dt>
              <dd>
                須在核發後 2 分鐘內開始；開始後閒置期限為 10 分鐘，絕對最長存續 1 小時。完成後保留
                90 秒以支援必要的瀏覽器請求；串流租約最長 15 分鐘，且不超過工作期限。
              </dd>
            </div>
          </dl>
          <p>
            上述期限是應用程式內的邏輯到期與刪除規則，不等同於對 Cloudflare
            邊緣安全紀錄、基礎設施備份、使用者瀏覽器紀錄或第三方系統保存期限的保證。
          </p>
        </section>

        <section aria-labelledby="privacy-security-title">
          <h2 id="privacy-security-title">安全界線</h2>
          <p>
            應用程式以雜湊值處理工作階段、CSRF token、IP 與 Turnstile token
            等識別資料，並密封保存來源媒體網址；但候選中繼資料、Range
            狀態與其他服務狀態不因此全部成為加密資料。本頁不作「所有資料皆加密」、「完全無紀錄」或「資料立即物理刪除」的聲明。
          </p>
        </section>

        <section aria-labelledby="privacy-contact-title">
          <h2 id="privacy-contact-title">隱私與資料處理聯絡</h2>
          <p>本服務營運者顯示名稱為 Pony。如對本服務的隱私或資料處理有疑問，可寄送電子郵件至：</p>
          <address>
            <a
              class="legal-contact-link"
              href="mailto:pony@pylot.dev"
              aria-label="寄送隱私與資料處理詢問至 pony@pylot.dev"
              >pony@pylot.dev</a
            >
          </address>
        </section>

        <section aria-labelledby="privacy-review-title">
          <h2 id="privacy-review-title">定期審閱提醒</h2>
          <p>
            本頁不構成法律意見。營運者應依實際所在地、資料流、Cloudflare
            的實際設定與當時有效的保存政策定期審閱本頁，並在相關條件變動時更新。
          </p>
        </section>
      </article>
    </ng-template>
  `,
})
export class PrivacyPageComponent {
  readonly modal = input(false);
}
