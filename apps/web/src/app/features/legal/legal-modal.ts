import { NgComponentOutlet } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  Directive,
  ElementRef,
  HostListener,
  Injectable,
  computed,
  effect,
  inject,
  input,
  signal,
  untracked,
  viewChild,
  type Type,
} from '@angular/core';
import { Router } from '@angular/router';

import { I18nService } from '../../core/i18n/i18n.js';

export type LegalDocumentKind = 'terms' | 'privacy' | 'copyright';

const LEGAL_DOCUMENT_LOADERS: Readonly<Record<LegalDocumentKind, () => Promise<Type<unknown>>>> = {
  terms: () =>
    import('./terms-page.js').then(({ TermsPageComponent }): Type<unknown> => TermsPageComponent),
  privacy: () =>
    import('./privacy-page.js').then(
      ({ PrivacyPageComponent }): Type<unknown> => PrivacyPageComponent,
    ),
  copyright: () =>
    import('./copyright-page.js').then(
      ({ CopyrightPageComponent }): Type<unknown> => CopyrightPageComponent,
    ),
};

@Injectable({ providedIn: 'root' })
class LegalModalState {
  readonly opened = signal(false);
  readonly kind = signal<LegalDocumentKind>('terms');
  readonly document = signal<Type<unknown> | null>(null);
  readonly loading = signal(false);
  readonly error = signal(false);
  readonly returnFocus = signal<HTMLElement | null>(null);
  private generation = 0;

  open(kind: LegalDocumentKind, trigger: HTMLElement): void {
    this.generation += 1;
    this.returnFocus.set(trigger);
    this.kind.set(kind);
    this.opened.set(true);
    this.document.set(null);
    this.error.set(false);
    this.loading.set(true);
    void this.load(kind, this.generation);
  }

  close(): void {
    if (!this.opened()) {
      return;
    }
    this.generation += 1;
    this.opened.set(false);
    this.loading.set(false);
    this.error.set(false);
    this.document.set(null);
  }

  retry(): void {
    if (!this.opened() || this.loading()) {
      return;
    }
    this.generation += 1;
    this.document.set(null);
    this.error.set(false);
    this.loading.set(true);
    void this.load(this.kind(), this.generation);
  }

  restoreFocus(): void {
    const target = this.returnFocus();
    this.returnFocus.set(null);
    if (target?.isConnected) {
      target.focus();
    }
  }

  private async load(kind: LegalDocumentKind, generation: number): Promise<void> {
    try {
      const document = await LEGAL_DOCUMENT_LOADERS[kind]();
      if (!this.opened() || this.kind() !== kind || this.generation !== generation) {
        return;
      }
      this.document.set(document);
      this.loading.set(false);
    } catch {
      if (!this.opened() || this.kind() !== kind || this.generation !== generation) {
        return;
      }
      this.loading.set(false);
      this.error.set(true);
    }
  }
}

@Directive({
  selector: 'a[legalModalTrigger]',
})
export class LegalModalTriggerDirective {
  readonly kind = input.required<LegalDocumentKind>({ alias: 'legalModalTrigger' });
  private readonly modal = inject(LegalModalState);
  private readonly router = inject(Router);

  @HostListener('click', ['$event'])
  open(event: MouseEvent): void {
    if (
      event.defaultPrevented ||
      event.button !== 0 ||
      event.altKey ||
      event.ctrlKey ||
      event.metaKey ||
      event.shiftKey
    ) {
      return;
    }
    if (this.router.url !== '/' && !this.router.url.startsWith('/?')) {
      return;
    }
    const trigger = event.currentTarget;
    if (!(trigger instanceof HTMLElement)) {
      return;
    }
    event.preventDefault();
    this.modal.open(this.kind(), trigger);
  }
}

@Component({
  selector: 'app-legal-modal-outlet',
  imports: [NgComponentOutlet],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <dialog
      #dialog
      class="legal-modal"
      aria-modal="true"
      [attr.aria-labelledby]="titleId()"
      [attr.aria-busy]="loading() ? 'true' : null"
      (cancel)="cancel($event)"
      (close)="closedByBrowser()"
    >
      <div class="legal-modal-frame">
        <header class="legal-modal-header">
          <div>
            <p class="eyebrow">{{ text().eyebrow }}</p>
            <h2 [id]="titleId()">{{ title() }}</h2>
          </div>
          <button #closeButton type="button" class="legal-modal-close" (click)="close()">
            {{ text().close }}
          </button>
        </header>

        <div class="legal-modal-body">
          @if (loading()) {
            <p class="legal-modal-status" role="status">{{ text().loading }}</p>
          } @else if (error()) {
            <div class="legal-modal-error" role="alert">
              <p>{{ text().error }}</p>
              <button type="button" (click)="retry()">{{ text().retry }}</button>
            </div>
          } @else if (document(); as legalDocument) {
            <ng-container
              *ngComponentOutlet="legalDocument; inputs: modalDocumentInputs"
            ></ng-container>
          }
        </div>
      </div>
    </dialog>
  `,
})
export class LegalModalOutletComponent {
  private readonly modal = inject(LegalModalState);
  private readonly i18n = inject(I18nService);
  private readonly dialog = viewChild.required<ElementRef<HTMLDialogElement>>('dialog');
  private readonly closeButton = viewChild.required<ElementRef<HTMLButtonElement>>('closeButton');
  protected readonly loading = this.modal.loading;
  protected readonly error = this.modal.error;
  protected readonly document = this.modal.document;
  protected readonly modalDocumentInputs = { modal: true };
  protected readonly text = computed(() => this.i18n.messages().legalModal);
  protected readonly title = computed(() => {
    const messages = this.i18n.messages();
    return {
      terms: messages.terms.title,
      privacy: messages.privacy.title,
      copyright: messages.copyright.title,
    }[this.modal.kind()];
  });
  protected readonly titleId = computed(() => `legal-modal-${this.modal.kind()}-title`);
  private readonly synchronizeDialog = effect(() => {
    const opened = this.modal.opened();
    const dialog = this.dialog().nativeElement;
    const closeButton = this.closeButton().nativeElement;

    untracked(() => {
      if (opened && !dialog.open) {
        if (typeof dialog.showModal === 'function') {
          dialog.showModal();
        } else {
          dialog.setAttribute('open', '');
        }
        queueMicrotask(() => closeButton.focus());
      } else if (!opened && dialog.open) {
        if (typeof dialog.close === 'function') {
          dialog.close();
        } else {
          dialog.removeAttribute('open');
        }
        queueMicrotask(() => this.modal.restoreFocus());
      }
    });
  });

  protected close(): void {
    this.modal.close();
  }

  protected retry(): void {
    this.modal.retry();
  }

  protected cancel(event: Event): void {
    event.preventDefault();
    this.modal.close();
  }

  protected closedByBrowser(): void {
    if (this.modal.opened()) {
      this.modal.close();
    }
    queueMicrotask(() => this.modal.restoreFocus());
  }
}
