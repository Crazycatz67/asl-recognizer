// =============================================================================
// js/sheet.js — reusable bottom-sheet / modal dialog controller (Browser UI)
// =============================================================================
// WHAT: One show/hide controller for every sheet and dialog in the app (S4b;
//   this is also S6's dialog fix — built once, reused by every sheet/dialog
//   rather than each one hand-rolling its own show/hide + escape handling).
//   Modal sheets get the full accessible-dialog treatment (focus trap, inert
//   background, Escape and backdrop close, focus restore).
//
// WHERE IT SITS: UI plumbing only. Today main.js uses it once, for the
//   non-modal reference panel (`refSheet`); the modal path is exercised by
//   tools/selftest.js and ready for future dialogs. Not part of recognition.
//
// PUBLIC API:
//   createSheet(el, opts) → { open, close, toggle, isOpen, destroy }
//
//   const sheet = createSheet(el, opts);
//   sheet.open()      -> show it. modal: traps Tab focus inside `el`,
//                        makes the rest of the page inert, remembers
//                        whatever had focus so close() can restore it.
//                        non-modal: just toggles the open class — the
//                        rest of the page stays fully usable (the
//                        reference panel is meant to be read WHILE still
//                        signing at the camera behind it, not a dialog).
//   sheet.close()     -> hide it, restore focus for modal sheets
//   sheet.toggle()
//   sheet.isOpen()    -> current state
//   sheet.destroy()   -> drop listeners, remove any backdrop this created
//
// opts:
//   modal      (default false) — focus trap + inert siblings + Escape/
//              backdrop-click close + focus restore. Off = a plain
//              peek/expand toggle with none of that (the reference panel).
//   openClass  (default "sheet-open") — class toggled on `el`
//   inertRoot  (default document.body) — modal only: every DIRECT CHILD of
//              this element OTHER than the one containing `el` gets
//              `inert` while open, however deeply `el` is actually nested
//              inside that child (see `siblingsToInert` below)
//   backdrop   (default: auto-created `<div class="sheet-backdrop">` when
//              modal) — an element whose click closes the sheet; pass
//              `false` to skip the backdrop entirely
//   onOpen / onClose — lifecycle hooks, called after the DOM update
//
// GOTCHA: open() sets `el.hidden = false` but close() only removes the open
//   class (it never sets hidden back), so the closed look must come from CSS
//   on `openClass`, not from the `hidden` attribute.

// ---- focus helpers ----

// Selector for natively focusable, enabled elements (tabindex=-1 excluded).
const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

// Focusable descendants of `el` that are actually rendered (have a layout box).
function focusablesIn(el) {
  return [...el.querySelectorAll(FOCUSABLE)].filter((n) => n.getClientRects().length > 0);
}

// Which of `root`'s DIRECT children to make inert: everything except the
// one that contains `el` (or is `el`) — works regardless of how deep `el`
// is actually nested inside that child.
function siblingsToInert(el, root) {
  if (!root.contains(el)) return [];
  let node = el;
  while (node.parentElement && node.parentElement !== root) node = node.parentElement;
  return [...root.children].filter((c) => c !== node);
}

// ---- public factory ----

/**
 * Wrap an element as an open/close-able sheet or modal dialog.
 * @param {HTMLElement} el  the sheet element
 * @param {{modal?: boolean, openClass?: string, inertRoot?: HTMLElement,
 *   backdrop?: HTMLElement|false, onOpen?: () => void, onClose?: () => void}} [opts]
 * @returns {{open: () => void, close: () => void, toggle: () => void,
 *   isOpen: () => boolean, destroy: () => void}}
 */
export function createSheet(el, opts = {}) {
  const modal = !!opts.modal;
  const openClass = opts.openClass || "sheet-open";
  const inertRoot = opts.inertRoot || document.body;
  let open = false;
  let inerted = [];
  let lastFocused = null;
  let backdrop = null;

  if (modal && opts.backdrop !== false) {
    backdrop = opts.backdrop || document.createElement("div");
    if (!opts.backdrop) {
      backdrop.className = "sheet-backdrop";
      el.parentElement?.insertBefore(backdrop, el);
    }
    backdrop.addEventListener("click", () => close());
  }

  // ---- keyboard: Escape closes, Tab / Shift+Tab wrap inside a modal ----
  function onKeydown(e) {
    if (!modal || !open) return;
    if (e.key === "Escape") {
      e.preventDefault();
      close();
      return;
    }
    if (e.key !== "Tab") return;
    const f = focusablesIn(el);
    if (!f.length) {
      e.preventDefault();
      return;
    }
    const first = f[0], last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    } else if (!el.contains(document.activeElement)) {
      // focus somehow escaped (e.g. a programmatic .focus() elsewhere) —
      // pull it back in rather than letting Tab continue from outside
      e.preventDefault();
      first.focus();
    }
  }
  document.addEventListener("keydown", onKeydown);

  // ---- open / close ----
  // (named open_ because `open` is the state flag above)
  function open_() {
    if (open) return;
    open = true;
    el.classList.add(openClass);
    el.hidden = false;
    if (modal) {
      lastFocused = document.activeElement;
      inerted = siblingsToInert(el, inertRoot);
      for (const n of inerted) n.inert = true;
      if (backdrop) backdrop.hidden = false;
      (focusablesIn(el)[0] || el).focus?.();
    }
    opts.onOpen?.();
  }
  function close() {
    if (!open) return;
    open = false;
    el.classList.remove(openClass);
    if (modal) {
      for (const n of inerted) n.inert = false;
      inerted = [];
      if (backdrop) backdrop.hidden = true;
      lastFocused?.focus?.();
      lastFocused = null;
    }
    opts.onClose?.();
  }

  return {
    open: open_,
    close,
    toggle() { open ? close() : open_(); },
    isOpen() { return open; },
    destroy() {
      document.removeEventListener("keydown", onKeydown);
      for (const n of inerted) n.inert = false;
      if (backdrop && !opts.backdrop) backdrop.remove();
    },
  };
}
