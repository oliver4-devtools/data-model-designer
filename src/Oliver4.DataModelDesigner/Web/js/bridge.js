// RPC across the WebView2 boundary. Every call returns a promise that settles when the
// host replies; unsolicited host events are dispatched to subscribers.

import { uid } from './util.js';

const pending = new Map();
const listeners = new Map();

const webview = window.chrome && window.chrome.webview ? window.chrome.webview : null;

if (webview) {
  webview.addEventListener('message', event => {
    let message;
    try {
      message = typeof event.data === 'string' ? JSON.parse(event.data) : event.data;
    } catch (error) {
      console.error('Unreadable host message', error, event.data);
      return;
    }

    if (message && message.event) {
      emit(message.event, message.payload);
      return;
    }

    if (!message || !message.id) return;

    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    inFlight.delete(message.id);

    if (message.ok) entry.resolve(message.payload);
    else entry.reject(Object.assign(new Error(message.error || 'The host reported an error.'), {
      detail: message.errorDetail,
      // The host answers a cancelled request with this exact text. Flagging it here means every
      // caller can tell "you stopped this" from "this went wrong" without matching on a string.
      cancelled: message.error === CANCELLED_TEXT
    }));
  });
}

/** Request ids the host is still working on, so the progress overlay can call a halt. */
const inFlight = new Set();

const CANCELLED_TEXT = 'Cancelled.';
const CANCEL_METHOD = 'work.cancel';

/** True when running inside the tool. False in a plain browser, which the module tolerates. */
export const isHosted = !!webview;

export function call(method, payload) {
  if (!webview) {
    return Promise.reject(new Error(
      'Not running inside XrmToolBox, so "' + method + '" is unavailable.'));
  }

  const id = uid('r');

  // The cancel call itself is not tracked: it would otherwise be in the set it is being used to
  // empty, and cancelling a cancellation is not a thing.
  if (method !== CANCEL_METHOD) inFlight.add(id);

  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    webview.postMessage(JSON.stringify({ id, method, payload: payload || {} }));
  });
}

/**
 * Asks the host to stop everything it is working on.
 *
 * It cancels every tracked call, not just one: the progress overlay covers the whole canvas, and
 * several calls can be in flight behind it at once - the explorer, a catalogue read and a metadata
 * load. Each one the host actually stops comes back as a rejected promise carrying `cancelled: true`.
 */
export function cancelAllWork() {
  const ids = Array.from(inFlight);
  if (!ids.length) return false;

  for (const id of ids) call(CANCEL_METHOD, { requestId: id }).catch(() => {});
  return true;
}

export function workInFlight() { return inFlight.size; }

/** True for the rejection the host sends when a request was cancelled rather than failing. */
export function isCancellation(error) {
  return !!(error && (error.cancelled || error.message === CANCELLED_TEXT));
}

export function on(eventName, handler) {
  if (!listeners.has(eventName)) listeners.set(eventName, new Set());
  listeners.get(eventName).add(handler);
  return () => listeners.get(eventName).delete(handler);
}

function emit(eventName, payload) {
  const set = listeners.get(eventName);
  if (!set) return;
  for (const handler of set) {
    try { handler(payload); } catch (error) { console.error('Event handler failed', eventName, error); }
  }
}

// ------------------------------------------------------------------ api --

export const host = {
  getAppInfo: () => call('app.info'),
  getConnection: () => call('connection.get'),
  listSolutions: () => call('solutions.list'),
  listTables: solutionId => call('tables.list', { solutionId }),
  /** Resolves to { tables, unreadable } - see the LoadTables case in HostBridge. */
  loadTables: logicalNames => call('tables.load', { logicalNames }),

  /** Relationships where both ends are inside the given set of tables. */
  discoverRelationships: logicalNames => call('relationships.discover', { logicalNames }),

  /** Breadth-first walk out from a start table. Options is a DiscoveryOptions shape. */
  exploreGraph: options => call('relationships.explore', { options }),

  /** What a delete or assign on one table reaches through cascade. Options is a CascadeOptions shape. */
  analyseCascade: options => call('cascade.analyse', { options }),

  findPaths: (from, to, maxDepth, maxPaths) => call('paths.find', { from, to, maxDepth, maxPaths }),

  openDiagram: (path, fromRecent) => call('diagram.open', { path, fromRecent: !!fromRecent }),
  saveDiagram: (document, path, saveAs) => call('diagram.save', { document, path, saveAs }),
  refreshDiagram: document => call('diagram.refresh', { document }),
  promote: (document, promotions) => call('diagram.promote', { document, promotions }),

  exportRun: request => call('export.run', request),

  getSettings: () => call('settings.get'),
  saveSettings: settings => call('settings.save', { settings }),

  message: (level, text) => call('ui.message', { level, text }),
  confirm: (caption, text) => call('ui.confirm', { caption, text }).then(r => !!(r && r.confirmed)),
  openUrl: url => call('ui.openUrl', { url }),
  setDirty: (dirty, title) => call('ui.dirty', { dirty, title })
};
