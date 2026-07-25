import { ChangeDetectionStrategy, Component } from '@angular/core';

@Component({
  selector: 'app-research-purpose-notice',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="research-purpose" aria-labelledby="research-purpose-title">
      <h2 id="research-purpose-title">研究目的與法律界線</h2>
      <div class="research-purpose-copy">
        <p>
          本服務之設置與營運目的僅為技術及學術研究，營運者不藉提供本服務獲取任何商業或經濟利益。
        </p>
        <p>
          上述目的與非商業聲明不代表營運者或使用者已取得任何內容授權，不表示特定下載、保存或其他使用必然合法或符合著作權限制或例外，也不免除任何人依適用法律應負的責任。
        </p>
        <p>
          公開可見、研究或非商業目的不等於授權。使用者必須擁有內容、取得有效授權，或依實際適用法律確實得為預定使用。
        </p>
        <p>
          本服務只處理無需登入即可由一般公眾存取的 Threads
          貼文，不處理私人、須登入或受限制內容，也不繞過登入、技術措施或其他存取限制。
        </p>
      </div>
    </section>
  `,
})
export class ResearchPurposeNoticeComponent {}
