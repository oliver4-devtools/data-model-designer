// Shared UI primitives: modal shell, toasts, progress overlay and the context menu.

import { el, clear, $ } from './util.js';
import { cancelAllWork, isCancellation } from './bridge.js';

let activeModal = null;

// --------------------------------------------------------------- modals ---

/**
 * Opens a modal. `build` receives an api object so the content can close the dialog and
 * enable or disable the primary button as the user fills it in.
 */
export function openModal({ title, subtitle, width, height, body, footer, onClose, padded }) {
  // Through dismissActiveModal, not a bare closeModal, so a dialog opened over another one still
  // runs the outgoing dialog's onClose and the code that opened it is told it has gone. Every other
  // way of dismissing a dialog calls it too.
  dismissActiveModal();

  // Connect mode and the draw tools are waiting for the next click on a canvas this dialog is
  // about to cover. interact.js listens for this; an event rather than a call so the shared UI
  // layer does not take a dependency on the canvas layer above it.
  window.dispatchEvent(new CustomEvent('dmd:modal-opened'));

  const root = $('#modal-root');
  clear(root);
  root.hidden = false;

  // This dialog's identity, so its api can tell whether it is still the one on screen.
  //
  // #modal-root is permanent and shared, so without this a callback belonging to a dialog the user
  // has already dismissed - a host call that resolves late, a debounced search - could rewrite
  // another dialog's subtitle, disable its primary button, or close it.
  const record = { root, api: null, onClose, dismissOnBackdrop: null };
  const isCurrent = () => activeModal === record;

  const api = {
    close: result => {
      if (!isCurrent()) return;
      closeModal();
      if (onClose) onClose(result);
    },
    setPrimaryEnabled: enabled => {
      if (!isCurrent()) return;
      const button = root.querySelector('.modal-foot .btn.primary');
      if (button) button.disabled = !enabled;
    },
    setSubtitle: text => {
      if (!isCurrent()) return;
      const node = root.querySelector('.modal-sub');
      if (node) node.textContent = text || '';
    },
    root
  };

  const bodyNode = el('div', { class: 'modal-body' + (padded ? ' padded' : '') });
  const footNode = el('div', { class: 'modal-foot' });

  const modal = el('div', {
    class: 'modal',
    style: {
      width: typeof width === 'number' ? width + 'px' : (width || '620px'),
      height: typeof height === 'number' ? height + 'px' : (height || 'auto')
    }
  }, [
    el('div', { class: 'modal-head' }, [
      el('div', { class: 'modal-title' }, [
        el('span', { text: title }),
        subtitle ? el('span', { class: 'modal-sub', text: subtitle }) : null
      ]),
      el('button', { class: 'icon-btn', html: '&times;', onClick: () => api.close(null), title: 'Close' })
    ]),
    bodyNode,
    footNode
  ]);

  // Named, kept on the record, and removed in closeModal.
  //
  // #modal-root is a permanent element, so an anonymous listener added on every openModal would
  // accumulate, and a single click on the backdrop would fire a stale onClose for every dialog
  // closed earlier in the session.
  const dismissOnBackdrop = event => { if (event.target === root) api.close(null); };

  root.appendChild(modal);
  record.api = api;
  record.dismissOnBackdrop = dismissOnBackdrop;
  activeModal = record;

  const content = typeof body === 'function' ? body(api) : body;
  if (content) bodyNode.appendChild(content);

  const foot = typeof footer === 'function' ? footer(api) : footer;
  if (foot) footNode.appendChild(foot);
  else footNode.remove();

  root.addEventListener('mousedown', dismissOnBackdrop);

  document.addEventListener('keydown', escapeHandler);

  // Capture, so the dialog gets the Tab before anything behind it can act on it.
  document.addEventListener('keydown', trapTab, true);

  // Focus moves into the dialog as it opens. Left on whatever was behind it - usually the
  // command-bar button that was clicked - the first Tab would land on the diagram name in the bar
  // under the backdrop, where Enter opens the properties dialog straight over this one.
  focusModal(modal, bodyNode, footNode);

  return api;
}

/** Everything inside a dialog that Tab can reach, in document order. */
function focusableIn(node) {
  if (!node || typeof node.querySelectorAll !== 'function') return [];

  const found = node.querySelectorAll(
    'a[href], button, input, select, textarea, [tabindex]');

  return Array.from(found || []).filter(item =>
    !item.disabled && item.getAttribute('tabindex') !== '-1' && item.hidden !== true);
}

/**
 * Puts focus inside a newly opened dialog.
 *
 * The body first and the footer second, deliberately skipping the close cross in the header: it is
 * the first focusable thing in the markup, and a dialog that opens with the cross focused throws
 * itself away the moment the user presses Enter to accept it. A dialog with nothing focusable at
 * all takes focus itself, so Tab has somewhere inside to start from.
 */
function focusModal(modal, bodyNode, footNode) {
  const target = focusableIn(bodyNode)[0] || focusableIn(footNode)[0];

  if (target) { target.focus(); return; }

  modal.setAttribute('tabindex', '-1');
  modal.focus();
}

/** Keeps Tab inside the open dialog, so it cannot reach anything behind the backdrop. */
function trapTab(event) {
  if (event.key !== 'Tab' || !activeModal) return;

  const modal = activeModal.root.querySelector('.modal');
  if (!modal) return;

  const items = focusableIn(modal);
  const current = document.activeElement;

  // Nothing inside to move between, or focus has escaped the dialog altogether.
  if (!items.length || !modal.contains(current)) {
    event.preventDefault();
    (items[0] || modal).focus();
    return;
  }

  const first = items[0];
  const last = items[items.length - 1];

  if (event.shiftKey && current === first) { event.preventDefault(); last.focus(); return; }
  if (!event.shiftKey && current === last) { event.preventDefault(); first.focus(); }
}

function escapeHandler(event) {
  if (event.key !== 'Escape' || !activeModal) return;
  event.stopPropagation();
  dismissActiveModal();
}

/** Closes the open dialog and tells it it has gone. The one path every dismissal goes through. */
function dismissActiveModal() {
  if (!activeModal) return;
  const onClose = activeModal.onClose;
  closeModal();
  if (onClose) onClose(null);
}

export function closeModal() {
  document.removeEventListener('keydown', escapeHandler);
  document.removeEventListener('keydown', trapTab, true);

  const root = $('#modal-root');

  if (root) {
    if (activeModal && activeModal.dismissOnBackdrop) {
      root.removeEventListener('mousedown', activeModal.dismissOnBackdrop);
    }

    clear(root);
    root.hidden = true;
  }

  activeModal = null;
}

export function isModalOpen() { return !!activeModal; }

/**
 * Standard footer: optional left-hand content, then Cancel and a primary action.
 * Pass hideCancel for a dialog that only dismisses, where a second button says nothing extra.
 */
export function modalFooter(api, { primaryLabel, onPrimary, secondary, cancelLabel, primaryDisabled, hideCancel }) {
  return el('div', { style: { display: 'flex', gap: '8px', width: '100%', alignItems: 'center' } }, [
    secondary || null,
    el('span', { class: 'spacer', style: { flex: '1 1 auto' } }),
    hideCancel
      ? null
      : el('button', { class: 'btn', text: cancelLabel || 'Cancel', onClick: () => api.close(null) }),
    primaryLabel
      ? el('button', {
          class: 'btn primary',
          text: primaryLabel,
          disabled: !!primaryDisabled,
          onClick: () => onPrimary(api)
        })
      : null
  ]);
}

// --------------------------------------------------------------- toasts ---

/**
 * A message in the top-right corner of the canvas.
 *
  * Every toast carries an explicit close cross, so it is clear that even a sticky error can be
  * dismissed. Clicking anywhere on the message dismisses it too.
 */
export function toast(message, kind, options) {
  const opts = options || {};
  const root = $('#toast-root');

  const close = el('button', {
    class: 'toast-close', html: '&times;', title: 'Dismiss this message',
    onClick: event => { event.stopPropagation(); node.remove(); }
  });

  const node = el('div', { class: 'toast ' + (kind || 'info') }, [
    close,
    el('div', { class: 'toast-text', text: message }),
    opts.list && opts.list.length
      ? el('ul', {}, opts.list.map(item => el('li', { text: item })))
      : null,
    opts.action
      ? el('div', { style: { marginTop: '8px' } }, [
          el('button', {
            class: 'btn', text: opts.action.label,
            onClick: () => { node.remove(); opts.action.run(); }
          })
        ])
      : null
  ]);

  root.appendChild(node);

  const timeout = opts.sticky ? 0 : (opts.timeout || (kind === 'error' ? 9000 : 5000));
  if (timeout) setTimeout(() => node.remove(), timeout);

  node.addEventListener('click', event => {
    if (event.target.tagName !== 'BUTTON') node.remove();
  });

  return node;
}

// ------------------------------------------------------------- progress ---

let progressDepth = 0;
let cancelTimer = null;
let cancelWired = false;

/**
 * Set the moment Cancel is pressed and cleared when the overlay comes down.
 *
 * Telling the host to stop is a request, not a guarantee, and it is perfectly possible for the
 * cancellation to arrive just after the last point at which the service checks its token - in
 * which case the host answers with a perfectly good result for work the user has already
 * abandoned. A cancellable withProgress checks this once its work resolves and refuses the result,
 * so "I stopped that" means the same thing whichever side won the race.
 */
let cancelRequested = false;

/**
 * Whether the user has already been told the cancellation took. One Cancel press can reject
 * several promises - the host answers every request it stopped, and a caller that awaited two of
 * them in turn will see both - and "Stopped." three times over is noise about a thing the user
 * did on purpose. Cleared with cancelRequested when the overlay comes down.
 */
let cancelAcknowledged = false;

/** The rejection a cancelled operation produces, in the shape bridge.isCancellation recognises. */
function cancellation() {
  return Object.assign(new Error('Cancelled.'), { cancelled: true });
}

/**
 * How long a job runs before the overlay offers a way out.
 *
 * Not immediately: most host calls finish inside a few hundred milliseconds, and a Cancel button
 * that appears and disappears again reads as a flicker. Long enough to mean "this is taking a
 * while", short enough that nobody sits watching a bar with no way to stop it.
 */
const CANCEL_AFTER_MS = 1500;

/** Puts the overlay on screen. Deliberately separate from the depth count - see updateProgress. */
function paintProgress(message) {
  $('#progress-message').textContent = message || 'Working...';
  $('#progress-bar').style.width = '0%';
  $('#progress').hidden = false;
}

/**
 * @param options.cancellable whether the work behind this overlay can genuinely be abandoned with
 *        nothing half-done left behind. See withProgress for what that turns on.
 */
export function showProgress(message, options) {
  progressDepth++;
  paintProgress(message);
  armCancel(!!(options && options.cancellable));
}

export function updateProgress(message, percent) {
  // Paints, and does NOT touch the depth count. A progress event can arrive while the overlay is
  // down, and incrementing the counter then would leave a count that nothing ever decrements, so
  // the overlay could never come down by the normal route.
  if ($('#progress').hidden) paintProgress(message);

  if (message) $('#progress-message').textContent = message;
  if (typeof percent === 'number') $('#progress-bar').style.width = Math.max(0, Math.min(100, percent)) + '%';
}

export function hideProgress(force) {
  progressDepth = force ? 0 : Math.max(0, progressDepth - 1);
  if (progressDepth > 0) return;

  $('#progress').hidden = true;
  disarmCancel();
}

/**
 * The host says a request of its own has finished.
 *
 * Not the same thing as "the overlay should come down", which is why this is not hideProgress. The
 * host raises ProgressDone in the finally of *every* bridge request, and a caller that awaits two
 * of them in turn - load these tables, then find the relationships between them - has already
  * started the second by the time the first one's event is delivered. Taking the overlay down here
  * would leave the second half of the operation running with nothing on screen: no message, no
  * bar, and no Cancel button, because its timer would be cleared too.
 *
 * So the overlay belongs to whoever is inside a withProgress call, and this only cleans up after
 * host progress that nobody on this side is waiting on.
 */
export function hostProgressDone() {
  if (progressDepth > 0) return;

  $('#progress').hidden = true;
  disarmCancel();
}

/**
 * Wires and schedules the Cancel button.
 *
 * The host is told to stop; it is not assumed to have stopped. Some of what it does between
 * cancellation checks is a single blocking metadata call that has to come back before the token is
 * looked at again, so the message says the request is being stopped rather than that it has been,
 * and the overlay stays up until the host actually answers.
 */
function armCancel(cancellable) {
  const button = $('#progress-cancel');
  if (!button) return;

  if (!cancelWired) {
    cancelWired = true;
    button.addEventListener('click', () => {
      button.disabled = true;
      button.textContent = 'Stopping...';

      // Both, always. The host is told to drop whatever it is doing, and the flag makes sure that
      // anything running inside the canvas is refused when it lands - a request the host has not
      // got is still a request the user made.
      cancelRequested = true;
      cancelAllWork();

      $('#progress-message').textContent = 'Stopping...';
    });
  }

  const actions = $('#progress-actions');

  // The wrapper is hidden as well as the button. Hiding only the button would leave an empty div
  // with a 12px top margin in the card, drawing a gap on every short operation.
  const hideButton = () => {
    if (actions) actions.hidden = true;
    button.hidden = true;
    button.disabled = false;
    button.textContent = 'Cancel';
  };

  // No button at all for work that cannot honestly be abandoned - see withProgress. A second,
  // uncancellable step after a cancellable one (rendering a PNG, then writing it) takes the
  // button away again rather than leaving a control that would now do nothing but mislead.
  if (!cancellable) {
    if (cancelTimer) { clearTimeout(cancelTimer); cancelTimer = null; }
    hideButton();
    return;
  }

  if (cancelTimer) return;

  hideButton();

  cancelTimer = setTimeout(() => {
    cancelTimer = null;
    if ($('#progress').hidden) return;

    button.hidden = false;
    if (actions) actions.hidden = false;
  }, CANCEL_AFTER_MS);
}

function disarmCancel() {
  if (cancelTimer) { clearTimeout(cancelTimer); cancelTimer = null; }
  cancelRequested = false;
  cancelAcknowledged = false;

  const actions = $('#progress-actions');
  if (actions) actions.hidden = true;

  const button = $('#progress-cancel');
  if (!button) return;

  button.hidden = true;
  button.disabled = false;
  button.textContent = 'Cancel';
}

/**
 * Runs an async operation with the progress overlay up and errors surfaced as a toast.
 *
 * Pass { quiet: true } when the caller wants to raise its own message instead - two toasts about
 * the same failure is worse than either one on its own. The error is still logged and rethrown.
 *
 * Pass { cancellable: true } only when abandoning the work leaves nothing half-done. That means
 * the read-only metadata calls, and only those: tables.load, relationships.discover,
 * relationships.explore, cascade.analyse, paths.find and diagram.refresh, which are the six bridge
 * methods that take a CancellationToken and check it.
 *
  * Saving, exporting and promoting are not cancellable. The host has no token for them, so
  * pressing Cancel could not stop the write - it would only make the canvas discard an answer
  * describing a file that is already on disk, and then tell the user nothing was written while
  * their diagram sat marked as unsaved.
 */
export async function withProgress(message, work, options) {
  const opts = options || {};
  showProgress(message, opts);

  try {
    const result = await work();

    // Checked after the work resolves, not before. The point is the job the host knows nothing
    // about - a PNG rasterise, a long local build - which cannot be interrupted part way, so the
    // only place to honour the cancellation is at the moment it produces its answer. Refusing the
    // answer is what stops the caller acting on it.
    if (opts.cancellable && cancelRequested) throw cancellation();

    return result;
  } catch (error) {
    // A cancellation is the user getting what they asked for, not a failure. It gets one quiet
    // acknowledgement rather than a sticky red error saying "Cancelled."
    if (isCancellation(error)) {
      if (!cancelAcknowledged) {
        cancelAcknowledged = true;
        toast('Stopped. Nothing on the diagram was changed.', 'info');
      }
      throw error;
    }

    console.error(error);

    if (!opts.quiet) {
      toast(error && error.message ? error.message : String(error), 'error', { sticky: true });
    }

    throw error;
  } finally {
    hideProgress();
  }
}

// ------------------------------------------------------ canvas furniture ---

/**
 * Where a piece of draggable canvas furniture actually sits, clamped into the window.
 *
 * Pure, and pure on purpose: the position is stored in the diagram, so a legend dragged to the
 * bottom-right of a 27-inch monitor is read back on a laptop where that point is off the screen
 * entirely - and a piece of furniture nobody can reach is a piece of furniture nobody can put
 * back. The clamp is applied when the position is *drawn* rather than when it is stored, so
 * making the window small and then large again does not quietly rewrite where the user put it.
 *
 * `insets` is the space to keep clear of each edge. The top one is what stops the legend being
 * parked underneath the command bar, which floats over the canvas and would swallow it.
 */
export function clampToViewport(x, y, size, viewport, insets) {
  const edges = insets || {};
  const top = finiteOr(edges.top, 8);
  const left = finiteOr(edges.left, 8);
  const right = finiteOr(edges.right, 8);
  const bottom = finiteOr(edges.bottom, 8);

  const width = Math.max(0, finiteOr(size && size.width, 0));
  const height = Math.max(0, finiteOr(size && size.height, 0));
  const viewWidth = Math.max(0, finiteOr(viewport && viewport.width, 0));
  const viewHeight = Math.max(0, finiteOr(viewport && viewport.height, 0));

  // A window smaller than the thing being placed cannot satisfy both edges at once. The near edge
  // wins: the far one is off screen whatever happens, and the near one is where the pointer is.
  const maxX = Math.max(left, viewWidth - width - right);
  const maxY = Math.max(top, viewHeight - height - bottom);

  return {
    x: Math.min(Math.max(finiteOr(x, left), left), maxX),
    y: Math.min(Math.max(finiteOr(y, top), top), maxY)
  };
}

/**
 * A stored position for a piece of furniture, or null when it has never been placed.
 *
  * Tests the type before the value. `Number(null)` is 0 and 0 is a perfectly finite number, so a
  * guard written as `Number.isFinite(Number(settings.legendX))` would read "never dragged" as
  * "dragged to the top-left corner" - and a new diagram carries both properties as an explicit
  * null.
 */
export function furniturePosition(x, y) {
  if (typeof x !== 'number' || typeof y !== 'number') return null;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;

  return { x, y };
}

function finiteOr(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

// --------------------------------------------------------- context menu ---

export function showContextMenu(x, y, items) {
  const menu = $('#context-menu');
  clear(menu);

  for (const item of items) {
    if (!item) continue;

    if (item.separator) { menu.appendChild(el('div', { class: 'sep' })); continue; }
    if (item.label && !item.run && !item.custom) {
      menu.appendChild(el('div', { class: 'menu-label', text: item.label }));
      continue;
    }
    if (item.custom) { menu.appendChild(item.custom); continue; }

    menu.appendChild(el('button', {
      class: (item.danger ? 'danger' : '') + (item.checked ? ' is-on' : ''),
      text: (item.checked ? '✓  ' : '') + item.text,
      disabled: item.disabled,
      onClick: () => { hideContextMenu(); item.run(); }
    }));
  }

  menu.hidden = false;
  menu.style.left = '0px';
  menu.style.top = '0px';

  // The menu is capped to the window and scrolls inside that cap.
  //
  // Without the cap, a tall menu would measure taller than the window and the clamp below would
  // produce a negative top, running the first items off the screen - and those are the overflow
  // commands the responsive pass has just taken off the toolbar, the ones most likely to be
  // wanted. The command bar can only shed buttons because they stay reachable here, so this has to
  // hold at any window height.
  const margin = 8;
  menu.style.maxHeight = Math.max(120, window.innerHeight - margin * 2) + 'px';

  const rect = menu.getBoundingClientRect();
  menu.style.left = Math.max(margin, Math.min(x, window.innerWidth - rect.width - margin)) + 'px';
  menu.style.top = Math.max(margin, Math.min(y, window.innerHeight - rect.height - margin)) + 'px';

  menu.scrollTop = 0;

  setTimeout(() => {
    document.addEventListener('mousedown', hideOnOutside, { once: true });
    document.addEventListener('wheel', hideOnWheelOutside, { once: true });
  }, 0);
}

function hideOnOutside(event) {
  if ($('#context-menu').contains(event.target)) {
    document.addEventListener('mousedown', hideOnOutside, { once: true });
    return;
  }
  hideContextMenu();
}

/**
 * A wheel over the canvas closes the menu; a wheel over the menu scrolls it, so a long menu can
 * be scrolled to reach its lower items without being dismissed.
 */
function hideOnWheelOutside(event) {
  if ($('#context-menu').contains(event.target)) {
    document.addEventListener('wheel', hideOnWheelOutside, { once: true });
    return;
  }
  hideContextMenu();
}

export function hideContextMenu() {
  const menu = $('#context-menu');
  if (menu) { menu.hidden = true; clear(menu); }
}

// ---------------------------------------------------------- form pieces ---

/**
 * A labelled control. Pass { required: true } to mark it with a red asterisk - the same marker
 * used everywhere, so "must be filled in" reads the same in every dialog.
 */
export function field(label, control, hint, options) {
  const opts = options || {};

  return el('label', { class: 'field' }, [
    el('span', {
      style: { display: 'block', fontSize: '11px', color: 'var(--ink-4)', marginBottom: '4px' }
    }, [
      label,
      opts.required ? el('span', { class: 'req', text: '*', title: 'Required' }) : null
    ]),
    control,
    hint ? el('div', { class: 'small muted', text: hint, style: { marginTop: '4px' } }) : null
  ]);
}

/**
 * Marks a control as an unfilled mandatory box. Kept here so the red-outline treatment is
 * defined once rather than reinvented per dialog.
 */
export function markRequired(node, isEmpty) {
  if (!node || !node.classList) return node;
  node.classList.toggle('needs-value', !!isEmpty);
  return node;
}

/** A borderless input for use inside a grid row. */
export function cellInput(value, onInput, attrs) {
  const options = attrs || {};

  return el('input', Object.assign({
    type: 'text',
    value: value || '',
    class: 'cell-input' + (options.mono ? ' mono' : ''),
    onInput: event => onInput(event.target.value)
  }, options.attrs || {}));
}

export function textInput(value, onInput, attrs) {
  return el('input', Object.assign({
    type: 'text',
    value: value || '',
    onInput: event => onInput(event.target.value)
  }, attrs || {}));
}

export function textArea(value, onInput, attrs) {
  return el('textarea', Object.assign({
    value: value || '',
    onInput: event => onInput(event.target.value)
  }, attrs || {}));
}

export function select(options, value, onChange) {
  const node = el('select', {
    onChange: event => onChange(event.target.value)
  }, options.map(option => el('option', {
    value: option.value,
    text: option.label,
    selected: option.value === value
  })));

  node.value = value;
  return node;
}

/**
 * A tick box.
 *
  * Not an <input type="checkbox">: the tick is drawn so it can carry the app's own styling in both
  * themes, and the keyboard support is provided here so every toggle stays reachable by Tab -
  * tabindex, the checkbox role, aria-checked kept in step with the tick, and Enter and Space going
  * through the same toggle path as a click.
 */
export function checkbox(label, checked, onChange) {
  const box = el('span', { class: 'chk' + (checked ? ' is-on' : ''), html: checked ? '&#10003;' : '' });

  const toggle = () => {
    const next = !box.classList.contains('is-on');
    box.classList.toggle('is-on', next);
    box.innerHTML = next ? '&#10003;' : '';
    node.setAttribute('aria-checked', next ? 'true' : 'false');
    onChange(next);
  };

  const node = el('div', {
    class: 'toggle',
    tabindex: '0',
    role: 'checkbox',
    'aria-checked': checked ? 'true' : 'false',
    onClick: toggle,
    onKeyDown: event => {
      if (event.key !== 'Enter' && event.key !== ' ' && event.key !== 'Spacebar') return;
      // Space scrolls the page and Enter submits whatever the dialog counts as its default action;
      // on a control the user is operating, neither is what they asked for.
      event.preventDefault();
      toggle();
    }
  }, [box, el('span', { text: label })]);

  return node;
}

export function statusBadge(status) {
  if (!status || status === 'Existing') return null;
  return el('span', { class: 'badge badge-' + status.toLowerCase(), text: status.toUpperCase() });
}

/**
  * The "Version x.y.z" line under a tool name, and how it fills itself in late.
 *
 * The About box and the feature guide both describe behaviour that changes between releases, so a
 * page of either that cannot name the release is a page that cannot be trusted - and app.info is
 * fetched once at boot, where it can fail. `pending`, when given, is a promise for a second try:
 * the line draws at once from whatever is already known and repaints when that try settles, so
 * neither dialog has to wait on a host round trip before it can appear.
 */
export function versionLine(info, pending) {
  const node = el('div', { class: 'small muted' });

  const paint = (version, waiting) => {
    node.textContent = version
      ? 'Version ' + version
      : waiting ? 'Checking version...' : 'Version unavailable';
  };

  paint(info && info.version, !!pending);

  // Repainting a node whose dialog has since been closed is harmless - it is detached by then.
  if (pending) pending.then(fresh => paint(fresh && fresh.version, false), () => paint(null, false));

  return node;
}
