import { ComponentFixture, TestBed } from '@angular/core/testing';

import { AppComponent } from './app.js';

describe('AppComponent', () => {
  let fixture: ComponentFixture<AppComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({ imports: [AppComponent] }).compileComponents();
    fixture = TestBed.createComponent(AppComponent);
    fixture.detectChanges();
  });

  it('shows an accessible URL input', () => {
    const input = fixture.nativeElement.querySelector('input') as HTMLInputElement;

    expect(input.labels?.item(0)?.textContent).toContain('公開貼文網址');
  });

  it('reports a validation error after invalid submission', () => {
    fixture.componentInstance.submit();
    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).toContain('請修正表單中的錯誤。');
  });
});
