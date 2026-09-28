// Test harness: loads pbip-explorer.html's own app <script> into a Node VM, so the parsers and the
// usage analysis can be tested without a browser or any npm install. See run.js.
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const DEFAULT_HTML = path.join(__dirname, '..', 'pbip-explorer.html');

/* The app script is the <script> block that opens with 'use strict' — the other one is the
   embedded D3 bundle. Its trailing init() call wires up the page's DOM, so it's dropped. */
function appSource(htmlPath) {
  const html = fs.readFileSync(htmlPath, 'utf8');
  const m = html.match(/<script>\s*('use strict';[\s\S]*?)<\/script>/);
  if (!m) throw new Error(`app <script> block not found in ${htmlPath}`);
  return m[1].replace(/\binit\(\);\s*$/, '');
}

/* Just enough DOM for processFiles(): toasts, the App.els elements it writes counts and rendered
   HTML into, and createElement's text-in / escaped-HTML-out innerHTML, which older copies of the
   page (before esc() became a plain string function) rely on when run.js is pointed at them. */
function domGlobals(toasts) {
  const element = () => ({
    style: {}, dataset: {}, _text: '', _html: '',
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    querySelectorAll: () => [], querySelector: () => null, appendChild() {}, remove() {},
    set textContent(v) { this._text = String(v); }, get textContent() { return this._text; },
    set innerHTML(v) { this._html = v; }, get innerHTML() { return this._html; },
  });
  const escapeText = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return {
    element,
    document: {
      createElement: () => {
        const el = element();
        Object.defineProperty(el, 'innerHTML', { get() { return escapeText(el._text); }, set(v) { el._html = v; } });
        return el;
      },
      getElementById: () => null, querySelector: () => null, querySelectorAll: () => [], addEventListener() {},
      body: { appendChild: el => toasts.push(el._text) },
    },
    requestAnimationFrame: cb => setTimeout(cb, 0),
  };
}

/* Load the app and return the named top-level functions and constants — undefined when one
   doesn't exist, so a test reports "not defined" rather than crashing the run. With { dom: true }
   the DOM stubs above are installed, `toasts` collects every toast message, and `document` /
   `element` are exposed so a test can hand a render function its target element. The file loaded
   is pbip-explorer.html unless PBIP_HTML (set by run.js from its argument) names another. */
function loadApp(names, { dom = false } = {}) {
  const htmlPath = process.env.PBIP_HTML || DEFAULT_HTML;
  const toasts = [];
  const globals = { console, setTimeout, clearTimeout };
  let stubs = null;
  if (dom) { stubs = domGlobals(toasts); Object.assign(globals, { document: stubs.document, requestAnimationFrame: stubs.requestAnimationFrame }); }
  const ctx = vm.createContext(globals);
  const expose = names.map(n => `${JSON.stringify(n)}: typeof ${n} === 'undefined' ? undefined : ${n}`).join(', ');
  vm.runInContext(`${appSource(htmlPath)}\n;globalThis.__app = { ${expose} };`, ctx, { filename: htmlPath });
  const app = ctx.__app;
  if (stubs && app.App) app.App.els = new Proxy({}, { get: (t, k) => t[k] || (t[k] = stubs.element()) });
  app.toasts = toasts;
  if (stubs) { app.document = stubs.document; app.element = stubs.element; }
  return app;
}

/* A { path: content } map as the File-like objects processFiles() takes from a dropped folder. */
function fileList(files) {
  return Object.entries(files).map(([p, content]) => ({
    webkitRelativePath: p,
    name: p.split('/').pop(),
    text: async () => (typeof content === 'string' ? content : JSON.stringify(content)),
  }));
}

function eq(got, want, what) {
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    throw new Error(`${what}: expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
  }
}
function has(text, needle) { if (!text.includes(needle)) throw new Error(`missing: ${needle}`); }
function hasNot(text, needle) { if (text.includes(needle)) throw new Error(`unexpected: ${needle}`); }
function defined(fn, name) { if (typeof fn !== 'function') throw new Error(`${name}() not defined`); return fn; }

/* A suite is a list of { name, fn }; fn may be async. */
function suite() {
  const tests = [];
  return { tests, test: (name, fn) => tests.push({ name, fn }) };
}

module.exports = { loadApp, fileList, eq, has, hasNot, defined, suite };
