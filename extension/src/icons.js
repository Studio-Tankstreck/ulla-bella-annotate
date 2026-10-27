// Ulla-Bella Extension — toolbar icon loading.
//
// Decodes the bundled toolbar icon PNGs into ImageData so the toolbar icon can
// be set via chrome.action.setIcon({ imageData }) instead of { path }. The
// path-based setIcon rejects the runtime-only -active icon files ("Could not
// load action icon 'icons/icon16-active.png'") even though they are valid,
// present PNGs; imageData bypasses that resource loader while keeping the exact
// same artwork.
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  } else {
    root.UllaBellaIcons = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const GREY = { 16: "icons/icon16.png", 32: "icons/icon32.png", 48: "icons/icon48.png", 128: "icons/icon128.png" };
  const ACTIVE = { 16: "icons/icon16-active.png", 32: "icons/icon32-active.png", 48: "icons/icon48-active.png", 128: "icons/icon128-active.png" };

  async function loadImageData(path) {
    const url = chrome.runtime.getURL(path);
    const resp = await fetch(url);
    if (!resp.ok) {
      throw new Error("fetch failed for " + path + ": HTTP " + resp.status);
    }
    const bitmap = await createImageBitmap(await resp.blob());
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext("2d");
    ctx.drawImage(bitmap, 0, 0);
    return ctx.getImageData(0, 0, bitmap.width, bitmap.height);
  }

  async function loadSet(paths) {
    const out = {};
    for (const size of Object.keys(paths)) {
      out[size] = await loadImageData(paths[size]);
    }
    return out;
  }

  return {
    loadGrey: function () { return loadSet(GREY); },
    loadActive: function () { return loadSet(ACTIVE); },
  };
});
