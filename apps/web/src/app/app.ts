import { ChangeDetectionStrategy, Component, signal } from '@angular/core';
import { FormControl, ReactiveFormsModule, Validators } from '@angular/forms';

@Component({
  selector: 'app-root',
  imports: [ReactiveFormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <main class="downloader" aria-labelledby="page-title">
      <h1 id="page-title">Threads Downloader</h1>
      <p>請貼上公開貼文網址。下載連結將保持在本站網域。</p>

      <form (ngSubmit)="submit()" novalidate>
        <label for="target-url">公開貼文網址</label>
        <input
          id="target-url"
          name="targetUrl"
          type="url"
          autocomplete="url"
          [formControl]="targetUrl"
          aria-describedby="target-url-help target-url-error"
          required
        />
        <p id="target-url-help">僅接受授權下載的公開內容。</p>
        @if (targetUrl.invalid && targetUrl.touched) {
          <p id="target-url-error" class="error" role="alert">請輸入有效的網址。</p>
        }
        <button type="submit">準備下載</button>
      </form>

      <p aria-live="polite">{{ status() }}</p>
      <p><a href="mailto:abuse@example.invalid">檢舉濫用或權利問題</a></p>
    </main>
  `,
})
export class AppComponent {
  readonly targetUrl = new FormControl('', {
    nonNullable: true,
    validators: [Validators.required, Validators.pattern(/^https:\/\/.+/)],
  });
  readonly status = signal('尚未開始下載。');

  submit(): void {
    this.targetUrl.markAsTouched();
    this.status.set(
      this.targetUrl.valid ? '網址已驗證，尚未建立下載工作。' : '請修正表單中的錯誤。',
    );
  }
}
