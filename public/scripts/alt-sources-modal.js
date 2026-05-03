// Implements REQ-READ-002 — alt-sources modal open/close + responsive anchor.
// Static-served because Astro 5 directRenderScript inlines pure-import
// script tags and the site CSP `script-src 'self'` blocks the inline
// emit. The .ts source under src/scripts/alt-sources-modal.ts mirrors
// this file.

const DESKTOP_MIN_WIDTH_PX = 768;
const ANCHOR_GAP_PX = 8;
const ANCHOR_EDGE_MARGIN_PX = 12;

function getDialog() {
  return document.querySelector('[data-alt-sources-modal]');
}

function positionAnchored(triggerRect, viewport, dialog) {
  if (dialog.height + ANCHOR_EDGE_MARGIN_PX * 2 > viewport.height) {
    return null;
  }
  let left = triggerRect.left;
  if (left + dialog.width + ANCHOR_EDGE_MARGIN_PX > viewport.width) {
    left = viewport.width - dialog.width - ANCHOR_EDGE_MARGIN_PX;
  }
  if (left < ANCHOR_EDGE_MARGIN_PX) {
    left = ANCHOR_EDGE_MARGIN_PX;
  }
  let top = triggerRect.bottom + ANCHOR_GAP_PX;
  if (top + dialog.height + ANCHOR_EDGE_MARGIN_PX > viewport.height) {
    top = triggerRect.top - dialog.height - ANCHOR_GAP_PX;
    if (top < ANCHOR_EDGE_MARGIN_PX) {
      return null;
    }
  }
  return { top, left };
}

function applyAnchorOrCentre(dialog, trigger) {
  if (window.innerWidth < DESKTOP_MIN_WIDTH_PX) {
    dialog.removeAttribute('data-anchored');
    dialog.style.removeProperty('top');
    dialog.style.removeProperty('left');
    return;
  }
  const triggerRect = trigger.getBoundingClientRect();
  dialog.setAttribute('data-anchored', '1');
  dialog.style.top = '-9999px';
  dialog.style.left = '-9999px';
  requestAnimationFrame(() => {
    const dialogRect = dialog.getBoundingClientRect();
    const pos = positionAnchored(
      triggerRect,
      { width: window.innerWidth, height: window.innerHeight },
      { width: dialogRect.width, height: dialogRect.height },
    );
    if (pos === null) {
      dialog.removeAttribute('data-anchored');
      dialog.style.removeProperty('top');
      dialog.style.removeProperty('left');
      return;
    }
    dialog.style.top = `${pos.top}px`;
    dialog.style.left = `${pos.left}px`;
  });
}

function onTriggerClick(event) {
  const dialog = getDialog();
  if (dialog === null) return;
  event.preventDefault();
  if (typeof dialog.showModal !== 'function') return;
  const trigger = event.currentTarget;
  applyAnchorOrCentre(dialog, trigger);
  dialog.showModal();
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

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initModal, { once: true });
  } else {
    initModal();
  }
  document.addEventListener('astro:page-load', initModal);
  document.addEventListener('astro:before-swap', teardownModal);
}
