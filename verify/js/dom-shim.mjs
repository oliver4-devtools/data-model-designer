// Minimal DOM good enough to run the canvas modules headlessly.
// Verification only - never shipped.

class ClassList {
  constructor(node) { this.node = node; this.set = new Set(); }
  add(...names) { names.forEach(n => n && this.set.add(n)); this.sync(); }
  remove(...names) { names.forEach(n => this.set.delete(n)); this.sync(); }
  toggle(name, force) {
    const on = force === undefined ? !this.set.has(name) : !!force;
    if (on) this.set.add(name); else this.set.delete(name);
    this.sync();
    return on;
  }
  contains(name) { return this.set.has(name); }
  sync() { this.node.attributes['class'] = Array.from(this.set).join(' '); }
}

class Node {
  constructor(tagName, namespace) {
    this.tagName = tagName;
    this.namespace = namespace || null;
    this.attributes = {};
    this.childNodes = [];
    this.parentNode = null;
    this.style = new Proxy({}, { set: (t, k, v) => { t[k] = v; return true; } });
    this.dataset = {};
    this.classList = new ClassList(this);
    this._text = null;
    this.hidden = false;
    this.disabled = false;
    this.value = '';
    this.listeners = {};
  }

  get firstChild() { return this.childNodes[0] || null; }
  get children() { return this.childNodes.filter(n => n instanceof Node); }

  get textContent() {
    if (this._text !== null) return this._text;
    return this.childNodes.map(c => c.textContent).join('');
  }
  set textContent(value) { this._text = String(value); this.childNodes = []; }

  set innerHTML(value) { this._text = String(value).replace(/<[^>]*>/g, ''); this.childNodes = []; }
  get innerHTML() { return this._text || ''; }

  setAttribute(name, value) {
    this.attributes[name] = String(value);
    if (name === 'class') { this.classList.set = new Set(String(value).split(/\s+/).filter(Boolean)); }
  }
  getAttribute(name) { return name in this.attributes ? this.attributes[name] : null; }
  removeAttribute(name) { delete this.attributes[name]; }
  hasAttribute(name) { return name in this.attributes; }

  appendChild(child) {
    if (child.parentNode) child.parentNode.removeChild(child);
    child.parentNode = this;
    this.childNodes.push(child);
    return child;
  }
  append(...children) { children.filter(Boolean).forEach(c => this.appendChild(c)); }
  insertBefore(child, ref) {
    const index = ref ? this.childNodes.indexOf(ref) : -1;
    child.parentNode = this;
    if (index < 0) this.childNodes.push(child);
    else this.childNodes.splice(index, 0, child);
    return child;
  }
  removeChild(child) {
    const index = this.childNodes.indexOf(child);
    if (index >= 0) this.childNodes.splice(index, 1);
    child.parentNode = null;
    return child;
  }
  remove() { if (this.parentNode) this.parentNode.removeChild(this); }

  addEventListener(type, handler) { (this.listeners[type] = this.listeners[type] || []).push(handler); }
  removeEventListener(type, handler) {
    const list = this.listeners[type];
    if (!list) return;
    const index = list.indexOf(handler);
    if (index >= 0) list.splice(index, 1);
  }
  setPointerCapture() { }
  releasePointerCapture() { }

  // document.activeElement is tracked for real, because ui.js's Tab trap reads it to decide
  // whether focus has escaped the dialog. Without it that branch could never be exercised.
  focus() { this.focused = true; documentShim.activeElement = this; }

  /**
   * Enough of a selector match for the ones the canvas actually uses: an attribute with or
   * without a value, a class, an id, or a tag name - and any compound of those, so `a[href]` and
   * `.btn.primary` mean what they say.
   *
   * The hit tests in interact.js rely on `closest` to reach controls inside an SVG group - the
   * NOTE tag, a note's resize grip, an arrow's end handles. Compound support serves ui.js:
   * focusableIn asks for `a[href], button, input, select, textarea, [tabindex]` and trapTab
   * asks for `.modal`.
   */
  matches(selector) {
    const sel = String(selector).trim();
    if (!sel) return false;

    for (const part of compoundParts(sel)) {
      if (!matchSimple(this, part)) return false;
    }

    return true;
  }

  closest(selector) {
    const parts = String(selector).split(',').map(part => part.trim()).filter(Boolean);

    let node = this;
    while (node) {
      if (node.matches && parts.some(part => node.matches(part))) return node;
      node = node.parentNode;
    }

    return null;
  }

  contains(node) { return node === this || this.childNodes.some(c => c.contains && c.contains(node)); }

  getBoundingClientRect() { return { left: 0, top: 0, width: 1440, height: 900, right: 1440, bottom: 900 }; }
  get offsetWidth() { return 288; }

  querySelector(selector) {
    const found = this.querySelectorAll(selector);
    return found.length ? found[0] : null;
  }

  /**
   * Descendants matching a comma-separated selector list, in document order. Each alternative may
   * be a descendant chain of compound simple selectors - `.modal-foot .btn.primary` - which is
   * exactly what ui.js reaches for when it enables a primary button or rewrites a subtitle.
   */
  querySelectorAll(selector) {
    const alternatives = String(selector).split(',')
      .map(part => part.trim().split(/\s+/).filter(Boolean))
      .filter(chain => chain.length);

    const found = [];
    const walk = node => {
      for (const child of node.childNodes) {
        if (!(child instanceof Node)) continue;
        if (alternatives.some(chain => matchesChain(child, chain, this))) found.push(child);
        walk(child);
      }
    };

    walk(this);
    return found;
  }
}

/** Splits a compound simple selector - `a[href]`, `.btn.primary` - into its pieces. */
function compoundParts(selector) {
  return String(selector).match(/(\[[^\]]*\]|[.#]?[^.#\[]+)/g) || [];
}

function matchSimple(node, part) {
  if (part.startsWith('[')) {
    const inner = part.slice(1, -1);
    const eq = inner.indexOf('=');
    if (eq < 0) return node.hasAttribute(inner);

    const name = inner.slice(0, eq);
    const value = inner.slice(eq + 1).replace(/^["']|["']$/g, '');
    return node.getAttribute(name) === value;
  }

  if (part.startsWith('.')) return node.classList.contains(part.slice(1));
  if (part.startsWith('#')) return node.getAttribute('id') === part.slice(1);
  return node.tagName === part;
}

/** `a b c` - the node matches `c` and has ancestors matching `b` then `a`, all under `root`. */
function matchesChain(node, chain, root) {
  if (!node.matches(chain[chain.length - 1])) return false;

  let index = chain.length - 2;
  let ancestor = node.parentNode;

  while (index >= 0 && ancestor && ancestor !== root.parentNode) {
    if (ancestor.matches && ancestor.matches(chain[index])) index--;
    ancestor = ancestor.parentNode;
  }

  return index < 0;
}

const ids = new Map();

const documentShim = {
  createElement(tag) { return new Node(tag); },
  createElementNS(ns, tag) { return new Node(tag, ns); },
  createTextNode(text) { const n = new Node('#text'); n.textContent = text; return n; },
  getElementById(id) {
    if (!ids.has(id)) {
      const node = new Node('div');
      node.setAttribute('id', id);
      ids.set(id, node);
    }
    return ids.get(id);
  },
  querySelector(sel) {
    if (sel && sel.startsWith('#')) return documentShim.getElementById(sel.slice(1));
    return null;
  },
  querySelectorAll() { return []; },

  /**
   * document listeners are recorded and dispatched for real. ui.js puts the Escape handler and
   * the Tab trap on the document, so this is what lets a dialog be dismissed the way a user
   * dismisses one, with its onClose running.
   */
  addEventListener(type, handler, options) {
    (documentListeners[type] = documentListeners[type] || [])
      .push({ handler, once: !!(options && options.once) });
  },
  removeEventListener(type, handler) {
    const list = documentListeners[type];
    if (!list) return;
    const index = list.findIndex(entry => entry.handler === handler);
    if (index >= 0) list.splice(index, 1);
  },
  dispatchEvent(event) {
    for (const entry of (documentListeners[event.type] || []).slice()) {
      if (entry.once) documentShim.removeEventListener(event.type, entry.handler);
      entry.handler(event);
    }
    return true;
  },

  activeElement: null,
  body: new Node('body'),
  documentElement: new Node('html')
};

const documentListeners = {};

// Canvas measureText: a proportional approximation is enough for layout maths.
const canvasContext = {
  font: '',
  measureText(text) {
    const size = parseFloat(/(\d+(\.\d+)?)px/.exec(this.font)?.[1] || '12');
    return { width: String(text || '').length * size * 0.55 };
  },
  fillRect() { },
  drawImage() { },
  set fillStyle(v) { }
};

const originalCreateElement = documentShim.createElement;
documentShim.createElement = function (tag) {
  const node = originalCreateElement(tag);
  if (tag === 'canvas') {
    node.getContext = () => canvasContext;
    node.toDataURL = () => 'data:image/png;base64,';
  }
  return node;
};

function serialise(node) {
  if (node.tagName === '#text') return escapeXml(node.textContent);

  const attrs = Object.entries(node.attributes)
    .map(([k, v]) => ' ' + k + '="' + escapeXml(v) + '"').join('');

  const inner = node._text !== null
    ? escapeXml(node._text)
    : node.childNodes.map(serialise).join('');

  return '<' + node.tagName + attrs + '>' + inner + '</' + node.tagName + '>';
}

function escapeXml(value) {
  return String(value === null || value === undefined ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

class XMLSerializerShim {
  serializeToString(node) { return serialise(node); }
}

/**
 * window listeners are recorded and dispatched for real.
 *
 * This covers every keyboard shortcut, the document-replacing subscriptions, and the `dmd:`
 * events the modules use to talk to each other without importing each other.
 */
const windowListeners = {};

const windowShim = {
  addEventListener(type, handler) {
    (windowListeners[type] = windowListeners[type] || []).push(handler);
  },
  removeEventListener(type, handler) {
    const list = windowListeners[type];
    if (!list) return;
    const index = list.indexOf(handler);
    if (index >= 0) list.splice(index, 1);
  },
  dispatchEvent(event) {
    for (const handler of (windowListeners[event.type] || []).slice()) handler(event);
    return true;
  },
  innerWidth: 1440,
  innerHeight: 900,
  setTimeout,
  clearTimeout
};

export function installDom() {
  globalThis.document = documentShim;
  globalThis.window = windowShim;
  globalThis.XMLSerializer = XMLSerializerShim;
  globalThis.CustomEvent = class CustomEvent { constructor(type, init) { this.type = type; Object.assign(this, init); } };
  globalThis.Image = class Image { set src(v) { setTimeout(() => this.onload && this.onload(), 0); } };

  return { document: documentShim, window: windowShim };
}

export { Node };
