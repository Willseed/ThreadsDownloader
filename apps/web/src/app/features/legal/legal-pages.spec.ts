import { type Type } from '@angular/core';
import { type ComponentFixture, TestBed } from '@angular/core/testing';

import { CopyrightPageComponent } from './copyright-page.js';
import { PrivacyPageComponent } from './privacy-page.js';
import { TermsPageComponent } from './terms-page.js';

const RESEARCH_PURPOSE =
  '本服務之設置與營運目的僅為技術及學術研究，營運者不藉提供本服務獲取任何商業或經濟利益。';
const RESEARCH_BOUNDARY =
  '上述目的與非商業聲明不代表營運者或使用者已取得任何內容授權，不表示特定下載、保存或其他使用必然合法或符合著作權限制或例外，也不免除任何人依適用法律應負的責任。';
const OUTDATED_PENDING_COPY = [
  '暫不可正式上線',
  '營運者名稱仍待提供',
  '待營運者確認',
  '營運者識別與法務審閱尚未完成',
  '未完成的法務狀態',
  '未填寫營運者名稱',
  '正式上線前狀態',
  '正式上線前仍須經法務審閱',
  'pending-operator-identity-and-legal-review',
] as const;

function normalizedText(element: Element | null): string {
  return element?.textContent?.replace(/\s+/gu, ' ').trim() ?? '';
}

describe('legal pages', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [TermsPageComponent, PrivacyPageComponent, CopyrightPageComponent],
    }).compileComponents();
  });

  function render<T>(component: Type<T>): ComponentFixture<T> {
    const fixture = TestBed.createComponent(component);
    fixture.detectChanges();
    return fixture;
  }

  it.each([TermsPageComponent, PrivacyPageComponent, CopyrightPageComponent])(
    'identifies Pony without retaining pending production copy',
    (component) => {
      const fixture = render(component);
      const root = fixture.nativeElement as HTMLElement;
      const text = normalizedText(root);

      expect(text).toContain('營運者顯示名稱為 Pony');
      expect(text).toContain('本頁不構成法律意見');
      for (const outdatedCopy of OUTDATED_PENDING_COPY) {
        expect(root.outerHTML).not.toContain(outdatedCopy);
      }
    },
  );

  it.each([TermsPageComponent, CopyrightPageComponent])(
    'places the exact research statement immediately before its legal boundary',
    (component) => {
      const fixture = render(component);
      const paragraphs = [
        ...(fixture.nativeElement as HTMLElement).querySelectorAll<HTMLParagraphElement>(
          '.research-purpose-copy > p',
        ),
      ].map((paragraph) => normalizedText(paragraph));

      expect(paragraphs.slice(0, 2)).toEqual([RESEARCH_PURPOSE, RESEARCH_BOUNDARY]);
      expect(paragraphs[2]).toContain('公開可見、研究或非商業目的不等於授權');
      expect(paragraphs[3]).toContain('不繞過登入、技術措施或其他存取限制');
    },
  );

  it('states the terms without inventing a jurisdiction or third-party affiliation', () => {
    const fixture = render(TermsPageComponent);
    const root = fixture.nativeElement as HTMLElement;
    const text = normalizedText(root);

    expect(root.querySelector('main#main-content')).not.toBeNull();
    expect(text).toContain('不接受 Threads 或 Instagram 的 Cookie、帳號憑證或登入 token');
    expect(text).toContain('本服務不授予任何第三方內容權利');
    expect(text).toContain('依實際所在地、資料流、服務情況與適用法律定期審閱');
    expect(text).toContain('未獲其背書、授權、委託或合作');
  });

  it('discloses the implemented data flow, recipients, and logical retention limits', () => {
    const fixture = render(PrivacyPageComponent);
    const root = fixture.nativeElement as HTMLElement;
    const text = normalizedText(root);
    const retentionLabels = [...root.querySelectorAll<HTMLElement>('.retention-list dt')].map(
      (term) => normalizedText(term),
    );

    expect(root.querySelector('main#main-content')).not.toBeNull();
    expect(text).toContain('__Host-td_session');
    expect(text).toContain('HttpOnly');
    expect(text).toContain('SameSite=Lax');
    expect(text).toContain('連線 IP');
    expect(text).toContain('雜湊識別值');
    expect(text).toContain('Cloudflare Workers');
    expect(text).toContain('Threads 接收');
    expect(text).toContain('Instagram 內容傳遞網路（CDN）');
    expect(retentionLabels).toEqual([
      '匿名工作階段',
      'IP 限流',
      'Turnstile 防重放',
      '解析候選',
      '下載工作',
    ]);
    expect(text).toContain('最長 12 小時');
    expect(text).toContain('60 秒限流視窗');
    expect(text).toContain('防重放雜湊最長 5 分鐘');
    expect(text).toContain('候選安全中繼資料及密封授權最長 10 分鐘');
    expect(text).toContain('核發後 10 分鐘內開始');
    expect(text).toContain('絕對最長存續 1 小時');
    expect(text).toContain('不等同於對 Cloudflare 邊緣安全紀錄');
    const contact = root.querySelector<HTMLAnchorElement>('a[href="mailto:pony@pylot.dev"]');
    expect(contact?.textContent?.trim()).toBe('pony@pylot.dev');
    expect(contact?.getAttribute('aria-label')).toContain('隱私與資料處理詢問');
    expect(text).toContain('依其當時有效的政策與實際服務設定定期審閱');
  });

  it('exposes the approved production marker and copyright contact', () => {
    const fixture = render(CopyrightPageComponent);
    const root = fixture.nativeElement as HTMLElement;
    const text = normalizedText(root);
    const status = root.querySelector<HTMLElement>('[data-legal-status]');
    const contact = status?.querySelector<HTMLAnchorElement>('a[href="mailto:pony@pylot.dev"]');

    expect(root.querySelectorAll('[data-legal-status]')).toHaveLength(1);
    expect(status?.dataset['legalStatus']).toBe('approved-for-production');
    expect(normalizedText(status)).toContain('本服務營運者顯示名稱為 Pony');
    expect(normalizedText(status)).toContain('依實際所在地、服務情況與適用法律定期審閱');
    expect(contact?.textContent?.trim()).toBe('pony@pylot.dev');
    expect(contact?.getAttribute('aria-label')).toContain('著作權或下架通知');
    expect(text).toContain('不聲稱適用任何特定國家或地區的通知與下架、安全港或反通知制度');
  });

  it.each([TermsPageComponent, PrivacyPageComponent, CopyrightPageComponent])(
    'renders reusable legal copy without a second page landmark in modal mode',
    (component) => {
      const fixture = render(component);
      fixture.componentRef.setInput('modal', true);
      fixture.detectChanges();
      const root = fixture.nativeElement as HTMLElement;

      expect(root.querySelector('main')).toBeNull();
      expect(root.querySelector('.legal-modal-document')).not.toBeNull();
      expect(normalizedText(root)).toContain('營運者顯示名稱為 Pony');
    },
  );
});
