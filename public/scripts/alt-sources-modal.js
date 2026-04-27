// Implements REQ-READ-002 — alt-sources modal open/close.
// Static-served because Astro 5 directRenderScript inlines pure-import
// script tags and the site CSP `script-src 'self'` blocks the inline
// emit. The .ts source under src/scripts/alt-sources-modal.ts mirrors
// this file.

function getDialog() {
  return document.querySelector('[data-alt-sources-modal]');
}

function onTriggerClick(event) {
  const dialog = getDialog();
  if (dialog === null) return;
  event.preventDefault();
  if (typeof dialog.showModal === 'function') {
    dialog.showModal();
  }
}

function onCloseClick(event) {
  const dialog = getDialog();
  if (dialog === null) return;
  event.preventDefault();
  if (typeof dialog.close === 'function') {
    dialog.close();
  }
}

function onDialogClick(event) {
  const dialog = getDialog();
  if (dialog === null) return;
  if (event.target === dialog) {
    dialog.close();
  }
}

function initModal() {
  const dialog = getDialog();
  if (dialog === null) return;
  if (dialog.dataset.bound === '1') return;
  dialog.dataset.bound = '1';

  const triggers = document.querySelectorAll('[data-alt-sources-trigger]');
  triggers.forEach((t) => {
    t.addEventListener('click', onTriggerClick);
  });

  const closeBtn = dialog.querySelector('[data-alt-sources-close]');
  if (closeBtn !== null) {
    closeBtn.addEventListener('click', onCloseClick);
  }

  dialog.addEventListener('click', onDialogClick);
}

function teardownModal() {
  const dialog = getDialog();
  if (dialog === null) return;

  const triggers = document.querySelectorAll('[data-alt-sources-trigger]');
  triggers.forEach((t) => {
    t.removeEventListener('click', onTriggerClick);
  });

  const closeBtn = dialog.querySelector('[data-alt-sources-close]');
  if (closeBtn !== null) {
    closeBtn.removeEventListener('click', onCloseClick);
  }

  dialog.removeEventListener('click', onDialogClick);
  dialog.dataset.bound = '0';
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initModal, { once: true });
} else {
  initModal();
}
document.addEventListener('astro:page-load', initModal);
document.addEventListener('astro:before-swap', teardownModal);
