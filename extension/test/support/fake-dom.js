"use strict";

// Minimal hand-rolled DOM for exercising the REAL extension/src/content.js under
// Node. Deliberately tiny: content.js only needs element creation, classList,
// textContent, appendChild/removeChild, a FLAT querySelector (memoized per
// parent), and event listeners.
//
// Flat querySelector caveat (same as the older shims): a compound selector like
// ".a .b" is not traversed — tests must chain the same path content.js uses.

function classListApi(list) {
  list.add = function () {
    for (let i = 0; i < arguments.length; i++) {
      const c = arguments[i];
      if (c && list.indexOf(c) === -1) list.push(c);
    }
  };
  list.remove = function () {
    for (let i = 0; i < arguments.length; i++) {
      const j = list.indexOf(arguments[i]);
      if (j >= 0) list.splice(j, 1);
    }
  };
  list.contains = function (c) {
    return list.indexOf(c) !== -1;
  };
  list.toggle = function (c, on) {
    const has = list.indexOf(c) !== -1;
    const want = on === undefined ? !has : !!on;
    if (want && !has) list.push(c);
    if (!want && has) list.splice(list.indexOf(c), 1);
    return want;
  };
  return list;
}

// setDefaultRect lets a test give every freshly created element a specific box,
// so viewport-dependent layout (the comment popover) can be exercised. The rect
// honours style.maxHeight/maxWidth, which is what CSS does to a box.
let DEFAULT_RECT = null;

function setDefaultRect(rect) {
  DEFAULT_RECT = rect ? Object.assign({}, rect) : null;
}

function resetDefaultRect() {
  DEFAULT_RECT = null;
}

function makeEl(tag) {
  const classList = classListApi([]);
  const children = [];
  const listeners = Object.create(null);
  const queried = new Map();
  let innerHTML = "";

  const el = {
    tagName: String(tag || "div").toUpperCase(),
    nodeType: 1,
    id: "",
    style: {},
    textContent: "",
    innerText: "",
    value: "",
    type: "",
    title: "",
    hidden: false,
    disabled: false,
    parentElement: null,
    children: children,
    classList: classList,
    attrs: {},
    isConnected: true,
    _listeners: listeners,
    classNameHas: function (name) {
      return classList.indexOf(name) !== -1;
    },
    closest: function (sel) {
      let node = el;
      while (node && node.nodeType === 1) {
        if (selectorMatches(node, sel)) return node;
        node = node.parentElement;
      }
      return null;
    },
    getBoundingClientRect: function () {
      const base = el._rect || DEFAULT_RECT || {
        x: 0,
        y: 0,
        top: 0,
        left: 0,
        width: 100,
        height: 30,
        right: 100,
        bottom: 30,
      };
      const rect = {
        x: base.left,
        y: base.top,
        top: base.top,
        left: base.left,
        width: base.width,
        height: base.height,
        right: base.left + base.width,
        bottom: base.top + base.height,
      };
      // A box never renders larger than its max-height/max-width (CSS).
      const maxH = parseFloat(el.style && el.style.maxHeight);
      const maxW = parseFloat(el.style && el.style.maxWidth);
      if (Number.isFinite(maxH) && rect.height > maxH) {
        rect.height = maxH;
        rect.bottom = rect.top + maxH;
      }
      if (Number.isFinite(maxW) && rect.width > maxW) {
        rect.width = maxW;
        rect.right = rect.left + maxW;
      }
      return rect;
    },
    appendChild: function (child) {
      child.parentElement = el;
      child.isConnected = true;
      children.push(child);
      return child;
    },
    removeChild: function (child) {
      const i = children.indexOf(child);
      if (i >= 0) children.splice(i, 1);
      child.parentElement = null;
      child.isConnected = false;
      return child;
    },
    remove: function () {
      if (el.parentElement) el.parentElement.removeChild(el);
    },
    setAttribute: function (k, v) {
      el.attrs[k] = String(v);
      if (k === "id") el.id = String(v);
    },
    getAttribute: function (k) {
      return Object.prototype.hasOwnProperty.call(el.attrs, k) ? el.attrs[k] : null;
    },
    focus: function () {},
    addEventListener: function (type, fn) {
      listeners[type] = fn;
    },
    removeEventListener: function (type) {
      delete listeners[type];
    },
    // querySelector first looks at REAL appended children (so tests can read
    // what content.js rendered), then falls back to a memoized placeholder so
    // the panel markup created via innerHTML still answers every lookup.
    querySelector: function (sel) {
      for (const child of children) {
        if (selectorMatches(child, sel)) return child;
        const nested = child.querySelector(sel);
        if (nested && !nested._placeholder) return nested;
      }
      if (!queried.has(sel)) {
        const fake = makeEl("span");
        fake._placeholder = true;
        queried.set(sel, fake);
      }
      return queried.get(sel);
    },
    querySelectorAll: function () {
      return [];
    },
    dispatch: function (type, ev) {
      const fn = listeners[type];
      if (typeof fn === "function") return fn(ev || {});
      return undefined;
    },
  };

  Object.defineProperty(el, "className", {
    get: function () {
      return classList.join(" ");
    },
    set: function (v) {
      classList.length = 0;
      String(v || "")
        .split(/\s+/)
        .forEach(function (c) {
          if (c && classList.indexOf(c) === -1) classList.push(c);
        });
    },
  });

  // content.js detaches nodes via .parentNode (the DOM property), while this
  // shim tracks parentElement — alias them so removeMarkers/removePanel work.
  Object.defineProperty(el, "parentNode", {
    get: function () {
      return el.parentElement;
    },
  });

  Object.defineProperty(el, "innerHTML", {
    get: function () {
      return innerHTML;
    },
    set: function (v) {
      innerHTML = String(v);
      children.length = 0;
      queried.clear();
    },
  });

  return el;
}

// selectorMatches supports the subset content.js and the tests use:
// "#id", "tag", ".class" (optionally repeated), "tag.class".
function selectorMatches(el, sel) {
  const s = String(sel || "").trim();
  if (!s || !el || el.nodeType !== 1) return false;
  if (s[0] === "#") return el.id === s.slice(1);
  const parts = s.split(".");
  const tag = parts.shift();
  if (tag && el.tagName.toLowerCase() !== tag.toLowerCase()) return false;
  for (const c of parts) {
    if (!el.classList || !el.classList.contains(c)) return false;
  }
  return true;
}

function makePageEl(tag, text, opts) {
  const o = opts || {};
  const el = makeEl(tag);
  if (o.id) el.id = o.id;
  if (o.className) el.className = o.className;
  el.innerText = text || "";
  el.textContent = text || "";
  return el;
}

function makeDocument(opts) {
  const o = opts || {};
  const page = o.page || [];
  const documentElement = makeEl("html");
  const listeners = Object.create(null);

  const doc = {
    title: o.title || "Example",
    documentElement: documentElement,
    _page: page,
    _listeners: listeners,
    addEventListener: function (type, fn) {
      (listeners[type] = listeners[type] || []).push(fn);
    },
    removeEventListener: function (type, fn) {
      const list = listeners[type] || [];
      const i = list.indexOf(fn);
      if (i >= 0) list.splice(i, 1);
    },
    createElement: function (tag) {
      return makeEl(tag);
    },
    querySelector: function (sel) {
      const found = doc.querySelectorAll(sel);
      return found.length ? found[0] : null;
    },
    querySelectorAll: function (sel) {
      return page.filter(function (el) {
        return selectorMatches(el, sel);
      });
    },
    dispatch: function (type, ev) {
      const list = (listeners[type] || []).slice();
      for (const fn of list) fn(ev || {});
    },
    hasListener: function (type) {
      return !!(listeners[type] && listeners[type].length);
    },
  };
  return doc;
}

module.exports = {
  makeEl: makeEl,
  makePageEl: makePageEl,
  makeDocument: makeDocument,
  selectorMatches: selectorMatches,
  setDefaultRect: setDefaultRect,
  resetDefaultRect: resetDefaultRect,
};
