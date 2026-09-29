#!/usr/bin/env node
// Lists top-level packages in node_modules that are never referenced by
// server-side code, directly or through another kept package. Browser-only
// dependencies are already bundled into static/ by webpack, so these are safe
// to delete from the runtime image.
//
// Conservative by design:
//  - roots: every compiled file under _build/ except app/client/**, all of
//    sandbox/**, every entry of bower_components/, and every symlink under
//    static/ that points into node_modules (static/ and bower_components/ are
//    served as files, so these symlinks are how browsers load e.g. the API
//    console's swagger-ui and the calendar widget's CSS). Other static/ files
//    are webpack bundles, which cannot load anything from node_modules.
//  - a package counts as referenced if its name appears in ANY string literal
//    of a root file or of any runtime JS file inside another referenced
//    package (catches dynamic require("name") as well as static requires)
//  - inside packages, non-runtime material is not scanned: tests, fixtures,
//    examples, docs, benchmarks, CI config, build/tool configs, JSON data,
//    bin/ folders and declared "bin" entry points (command-line tools), and a
//    browser/ build folder that Node's entry points (main/exports) don't use.
//    (Earlier versions scanned these and kept e.g. typescript because a test
//    fixture of another package mentioned it.)
//  - packages reached only through a served symlink are "asset-only": only the
//    linked files are served, so their code is not scanned, their
//    dependencies are not kept, and (with --asset-trim0) every other file in
//    them can be removed. bower_components/ entries are whole served folders
//    and are kept intact. If server code also references the package, it is a
//    normal (fully kept) package.
//  - the closure is iterated to a fixed point
//  - package.json "dependencies"/"optionalDependencies"/"peerDependencies" of
//    referenced packages are also kept (except peers marked optional in
//    peerDependenciesMeta, which are kept only if the code references them)
//
// Usage:
//   node find-client-only-deps.js /grist            report removable packages
//   node find-client-only-deps.js /grist --names    removable package names
//   node find-client-only-deps.js /grist --junk0    NUL-separated paths of
//       non-runtime folders/files inside kept packages (same rules as above)
//   node find-client-only-deps.js /grist --asset-trim0  NUL-separated paths
//       of files in asset-only packages that no served symlink points to
//   node find-client-only-deps.js /grist --trim0   NUL-separated paths from
//       the reviewed TRIM list, after re-checking each; exits 2 on a failed check
//   node find-client-only-deps.js /grist --require-reviewed   require() every
//       kept package named in TRIM or NOT_A_LOAD (run after pruning)
const fs = require('fs');
const path = require('path');

const root = process.argv[2] || '/grist';
const nm = path.join(root, 'node_modules');

function listPackages() {
  const out = [];
  for (const e of fs.readdirSync(nm)) {
    if (e.startsWith('.')) continue;
    if (e.startsWith('@')) {
      for (const s of fs.readdirSync(path.join(nm, e))) out.push(`${e}/${s}`);
    } else {
      out.push(e);
    }
  }
  return out;
}

const CODE_EXT = /\.(c|m)?js$|\.json$/;
const PKG_CODE_EXT = /\.(c|m)?js$/;
// Folders inside a package that never hold code the package loads at runtime.
const NON_RUNTIME_DIRS = new Set(['test', 'tests', '__tests__', '__mocks__', 'fixtures',
  'example', 'examples', 'docs', 'benchmark', 'benchmarks', 'coverage', '.github']);
// Scanned-for-references exclusions additionally skip bin/ (command-line
// scripts run by hand, never loaded by require()); bin/ is not deleted.
const SKIP_SCAN_DIRS = new Set([...NON_RUNTIME_DIRS, 'bin']);
// Reviewed names that a package mentions (in code or in package.json
// dependency fields) but never loads when the server require()s it, per package.
//   browser-or-node: navigator.userAgent.includes("jsdom") (environment sniffing)
//   typeorm: commands/InitCommand.js writes "ts-node"/"typescript" into the
//     package.json of a new project ("typeorm init"); commands/ is only used
//     by the typeorm CLI, and require("typeorm") loads neither (checked in
//     the built image: no commands/, cli, ts-node or typescript in require.cache).
//   argparse: "ts-node" appears only in a code comment.
//   jszip: deps.js is a maintainer script (require("madge"), require("typescript"))
//     next to the package; jszip's entry point (lib/index.js) never loads it.
//   @gristlabs/sqlite3: node-gyp (optional dependency) builds the add-on from
//     source at install time; at runtime the prebuilt build/Release add-on loads.
//   handlebars: uglify-js (optional dependency) is used only by
//     lib/precompiler.js, the "handlebars" command's --min option.
//   web-encoding: @zxing/text-encoding (optional dependency) is used only by
//     src/lib.react-native.js; the Node entry uses the built-in TextEncoder.
const NOT_A_LOAD = {
  '@gristlabs/sqlite3': new Set(['node-gyp']),
  'handlebars': new Set(['uglify-js']),
  'web-encoding': new Set(['@zxing/text-encoding']),
  'browser-or-node': new Set(['jsdom']),
  'typeorm': new Set(['ts-node', 'typescript']),
  'argparse': new Set(['ts-node']),
  'jszip': new Set(['typescript']),
};
// Reviewed folders/files inside kept packages that the server never loads and
// browsers never fetch: browser/AMD/UMD/IIFE bundles, minified copies, and ES
// module copies. --trim0 re-checks each one and fails the build if Node's
// require() entry point resolves into it, if any scanned file names it (as
// "<pkg>/<path>" or, inside the package, as a relative path), or if a served
// symlink points into it. Entries:
//   'path'                        a folder or file
//   { dir, except: [...] }        every entry of a folder except the listed ones
//   { path, esm: true }           an ES module copy that Node would use for
//                                 import (not require); also fails if any ES
//                                 module file or dynamic import() loads the package
// The server (_build) is CommonJS and loads packages with require().
const TRIM = {
  'exceljs': ['dist'],                 // browser bundles; Node entry excel.js -> lib/
  'typeorm': ['browser'],              // browser build; Node entry index.js
  'handlebars': ['dist/amd', 'dist/handlebars.amd.js', 'dist/handlebars.amd.min.js',
    'dist/handlebars.js', 'dist/handlebars.min.js', 'dist/handlebars.runtime.amd.js',
    'dist/handlebars.runtime.amd.min.js', 'dist/handlebars.runtime.js',
    'dist/handlebars.runtime.min.js'], // Node entry lib/index.js -> dist/cjs
  'moment': ['min', 'src', 'dist'],    // minified and ESM copies; no "exports", Node entry moment.js
  'luxon': ['build/amd', 'build/cjs-browser', 'build/es6', 'build/global'], // Node: build/node
  'i18next': ['dist/umd', 'i18next.min.js', { path: 'dist/esm', esm: true }], // Node: dist/cjs
  // csv packages: require -> dist/cjs, import -> lib/; dist/esm is unused by Node
  'csv': ['dist/umd', 'dist/iife', 'dist/esm'],
  'csv-generate': ['dist/umd', 'dist/iife', 'dist/esm'],
  'csv-parse': ['dist/umd', 'dist/iife', 'dist/esm'],
  'csv-stringify': ['dist/umd', 'dist/iife', 'dist/esm'],
  'stream-transform': ['dist/umd', 'dist/iife', 'dist/esm'],
  'xmlbuilder2': ['lib/xmlbuilder2.min.js'],         // "browser" field; Node: lib/index
  'bluebird': ['js/browser'],                         // Node: js/release
  'minio': [{ path: 'dist/esm', esm: true }],         // Node require: dist/main
  'bullmq': ['dist/esm'],                             // no "exports"; Node: dist/cjs
  'dayjs': ['esm'],                                   // no "exports"; Node: dayjs.min.js
  'tar': [{ path: 'dist/esm', esm: true }],           // Node require: dist/commonjs
  'async': ['dist/async.mjs'],                        // no "exports"; Node: dist/async.js
  'axios': ['dist/browser', 'dist/esm', 'dist/axios.js', 'dist/axios.min.js'], // Node: dist/node (import: index.js -> lib/)
  'jose': ['dist/browser', { path: 'dist/node/esm', esm: true }], // Node require: dist/node/cjs
  'grainjs': ['dist/esm'],                            // no "exports"; Node: dist/cjs
  'jszip': ['dist'],                                  // browser bundles; Node: lib/index
  'underscore': ['amd'],                              // AMD copies; not in "exports"
  'bignumber.js': ['bignumber.mjs'],                  // no "exports"; Node: bignumber.js
  '@gristlabs/sqlite3': ['deps', 'src'],             // C/C++ build sources; Node loads build/Release/node_sqlite3.node
  'lodash': ['core.min.js'],                          // Node: lodash.js (fp.js loads lodash.min.js, kept)
  // Served whole from bower_components; the pages load only
  // dist/jquery-ui.min.js and dist/themes/smoothness/ (checked by --trim0).
  'jquery-ui': ['ui', 'themes', 'dist/jquery-ui.js', { dir: 'dist/themes', except: ['smoothness'] }],
};
// Packages served whole through bower_components/ whose files browsers could
// request by any path; only these reviewed ones may have TRIM entries.
const SERVED_REVIEWED = new Set(['jquery-ui']);
// Tool/build configuration files that are never loaded at runtime.
const NON_RUNTIME_FILE = /\.(config|conf)\.(c|m)?js$|^(webpack|rollup|gulpfile|gruntfile|karma|jest|vite|babel)[\w.-]*\.(c|m)?js$|^\.eslintrc/i;

function* walk(dir, skip, ext = CODE_EXT) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (skip && skip(p)) continue;
    if (e.isDirectory()) yield* walk(p, skip, ext);
    // package.json files are handled via their dependency fields only; scanning
    // them as text would count devDependencies and scripts as references.
    else if (e.name !== 'package.json' && ext.test(e.name)) yield p;
  }
}

function skipInPackage(p) {
  return SKIP_SCAN_DIRS.has(path.basename(p)) || NON_RUNTIME_FILE.test(path.basename(p));
}

const pkgs = listPackages();
const pkgSet = new Set(pkgs);
const strRe = /["'`]((?:@[a-z0-9._~-]+\/)?[a-z0-9._~-]+)(\/[^"'`\s]*)?["'`]/gi;
// Packages some scanned file loads via a "<pkg>/browser..." subpath; their
// browser/ folder is then scanned even if Node's main entry avoids it.
const browserRefs = new Set();

function refsIn(file) {
  const found = new Set();
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return found; }
  let m;
  while ((m = strRe.exec(text))) {
    if (pkgSet.has(m[1])) {
      found.add(m[1]);
      if (m[2] && /^\/browser(\/|$)/.test(m[2])) browserRefs.add(m[1]);
    }
  }
  // Paths that point into node_modules, e.g. "node_modules/some-pkg/dist".
  const pathRe = /node_modules\/((?:@[a-z0-9._~-]+\/)?[a-z0-9._~-]+)/gi;
  while ((m = pathRe.exec(text))) {
    if (pkgSet.has(m[1])) found.add(m[1]);
  }
  return found;
}

const kept = new Set();
const queue = [];
// Asset-only packages: name -> Set of absolute served target paths, or 'ALL'
// for bower_components folders (served whole).
const assets = new Map();
function keepAsset(name, target, why) {
  if (!pkgSet.has(name)) return;
  if (target === 'ALL' || assets.get(name) === 'ALL') { assets.set(name, 'ALL'); }
  else { if (!assets.has(name)) assets.set(name, new Set()); assets.get(name).add(target); }
  if (process.env.VERBOSE) console.error(`asset ${name}  <- ${why}`);
}
function keep(name, why) {
  if (!pkgSet.has(name) || kept.has(name)) return;
  kept.add(name);
  queue.push(name);
  if (process.env.VERBOSE) console.error(`keep ${name}  <- ${why}`);
}

// Roots: all compiled code except browser-only code.
const clientDir = path.join(root, '_build', 'app', 'client');
for (const f of walk(path.join(root, '_build'), p => p === clientDir)) {
  for (const r of refsIn(f)) keep(r, path.relative(root, f));
}
// Anything the sandbox/launcher scripts name.
for (const f of walk(path.join(root, 'sandbox'))) {
  for (const r of refsIn(f)) keep(r, path.relative(root, f));
}
// Served symlinks into node_modules (static/ and bower_components/).
function pkgOfTarget(target) {
  const rel = path.relative(nm, target);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  const parts = rel.split(path.sep);
  return parts[0].startsWith('@') ? `${parts[0]}/${parts[1]}` : parts[0];
}
(function visitLinks(d) {
  let entries;
  try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = path.join(d, e.name);
    if (e.isSymbolicLink()) {
      const target = path.resolve(path.dirname(p), fs.readlinkSync(p));
      const pkg = pkgOfTarget(target);
      if (pkg) keepAsset(pkg, target, `served symlink ${path.relative(root, p)}`);
    } else if (e.isDirectory()) {
      visitLinks(p);
    }
  }
})(path.join(root, 'static'));
// bower_components/ is served as static files and its entries are symlinks
// into node_modules; every entry there is needed at runtime.
try {
  for (const e of fs.readdirSync(path.join(root, 'bower_components'))) {
    if (e.startsWith('@')) {
      for (const s of fs.readdirSync(path.join(root, 'bower_components', e))) keepAsset(`${e}/${s}`, 'ALL', 'bower_components');
    } else {
      keepAsset(e, 'ALL', 'bower_components');
    }
  }
} catch {}

// Where Node's require() of the package lands: "main", or exports["."]
// resolved with the conditions a CommonJS Node server matches.
const NODE_CONDITIONS = new Set(['node', 'require', 'default']);
function nodeEntries(pj) {
  const out = [];
  if (typeof pj.main === 'string') out.push(pj.main);
  const pick = (e) => {
    if (typeof e === 'string') return out.push(e);
    if (Array.isArray(e)) return e.forEach(pick);
    if (!e || typeof e !== 'object') return;
    // Node takes the first key, in object order, that matches its conditions.
    for (const c of Object.keys(e)) if (NODE_CONDITIONS.has(c)) return pick(e[c]);
  };
  const ex = pj.exports;
  if (ex !== undefined) {
    const isSubpathMap = ex && typeof ex === 'object' && !Array.isArray(ex) &&
      Object.keys(ex).some(k => k.startsWith('.'));
    pick(isSubpathMap ? ex['.'] : ex);
  }
  return out;
}

const browserSkipped = new Set();
function scanPackage(name, includeBrowser) {
  const dir = path.join(nm, name);
  let pj = {};
  try { pj = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')); } catch {}
  const ignore = NOT_A_LOAD[name] || new Set();
  if (!includeBrowser) {
    for (const k of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
      for (const d of Object.keys(pj[k] || {})) {
        // Peers marked optional are only needed for opt-in features; if the
        // package's code actually loads one, the code scan below keeps it.
        if (k === 'peerDependencies' && pj.peerDependenciesMeta?.[d]?.optional) continue;
        if (ignore.has(d)) continue;
        keep(d, `${name} package.json ${k}`);
      }
    }
  }
  // Per-package exclusions: declared command-line entry points (package.json
  // "bin"), and a browser/ build folder when Node's entry point does not
  // point into it and nothing loads a "<pkg>/browser" subpath.
  const skipPaths = new Set();
  const bins = typeof pj.bin === 'string' ? [pj.bin] : Object.values(pj.bin || {});
  for (const b of bins) skipPaths.add(path.resolve(dir, b));
  const browserDir = path.join(dir, 'browser');
  const entryInBrowser = nodeEntries(pj).some(e => path.resolve(dir, e).startsWith(browserDir + path.sep));
  if (!entryInBrowser && !browserRefs.has(name) && !includeBrowser) {
    skipPaths.add(browserDir);
    if (fs.existsSync(browserDir)) browserSkipped.add(name);
  }
  const skip = p => skipPaths.has(p) || skipInPackage(p);
  // includeBrowser: a second pass that scans only the browser/ folder.
  const start = includeBrowser ? browserDir : dir;
  for (const f of walk(start, skip, PKG_CODE_EXT)) {
    for (const r of refsIn(f)) if (!ignore.has(r)) keep(r, `${name}/${path.relative(dir, f)}`);
  }
}

// Repeat until stable: a later file may load "<pkg>/browser" after <pkg> was
// scanned with its browser/ folder skipped.
for (;;) {
  while (queue.length) scanPackage(queue.shift(), false);
  const late = [...browserSkipped].filter(n => browserRefs.has(n));
  if (!late.length) break;
  for (const n of late) {
    browserSkipped.delete(n);
    if (process.env.VERBOSE) console.error(`rescan ${n}/browser  <- "${n}/browser" subpath is referenced`);
    scanPackage(n, true);
  }
}

if (process.argv.includes('--require-reviewed')) {
  // After pruning: every kept package that the reviewed tables (TRIM,
  // NOT_A_LOAD) reduced must still load with require() from the app root.
  const names = [...new Set([...Object.keys(TRIM), ...Object.keys(NOT_A_LOAD)])].filter(n => kept.has(n)).sort();
  for (const n of names) require(require.resolve(n, { paths: [root] }));
  console.log(`require() ok: ${names.join(', ')}`);
  process.exit(0);
}

if (process.argv.includes('--trim0')) {
  const esc = x => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Text files that could name a trimmed path: server code, sandbox, served
  // pages/scripts/styles (not following symlinks), and every kept package.
  const texts = [];
  const textExt = /\.(c|m)?js$|\.json$|\.html?$|\.css$|\.hbs$/;
  for (const d of ['_build', 'sandbox', 'static']) for (const f of walk(path.join(root, d), null, textExt)) texts.push(f);
  for (const n of new Set([...kept, ...assets.keys()])) for (const f of walk(path.join(nm, n), null, textExt)) texts.push(f);
  const errors = [];
  const esmNames = new Set();   // packages with an ES module copy trimmed
  const checks = [];   // { name, t, abs, dir, named, relative }
  for (const [name, entries] of Object.entries(TRIM)) {
    const dir = path.join(nm, name);
    if (!kept.has(name) && !assets.has(name)) continue;   // package removed anyway
    let pj = {};
    try { pj = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')); } catch {}
    const targets = [];
    for (const e of entries) {
      if (typeof e === 'string') { targets.push(e); continue; }
      if (e.path) { targets.push(e.path); if (e.esm) esmNames.add(name); continue; }
      let list = [];
      try { list = fs.readdirSync(path.join(dir, e.dir)); } catch {}
      for (const x of list) if (!e.except.includes(x)) targets.push(`${e.dir}/${x}`);
      for (const x of e.except) if (!list.includes(x)) errors.push(`${name}/${e.dir}/${x} (kept) is missing`);
    }
    for (const t of targets) {
      const abs = path.join(dir, t);
      if (!fs.existsSync(abs)) continue;
      // Asset-only packages are never require()d, so their entry point is moot.
      if (kept.has(name) && nodeEntries(pj).some(x => { const r = path.resolve(dir, x); return r === abs || r.startsWith(abs + path.sep); })) {
        errors.push(`${name}/${t}: Node entry point resolves into it`);
        continue;
      }
      // A file may be named with or without its own extension (require
      // resolves "x" to "x.js"); a different extension is a different file.
      const ext = (t.match(/\.(c|m)?js$/) || [''])[0];
      const bare = t.slice(0, t.length - ext.length);
      const tail = `${esc(bare)}(?:${esc(ext)})?(?![\\w.-])`;
      checks.push({
        name, t, abs, dir,
        named: new RegExp(`${esc(name)}/${tail}`),
        relative: new RegExp(`["'\`](\\.{1,2}/)+${tail}`),
      });
    }
  }
  const inside = (f, abs) => f === abs || f.startsWith(abs + path.sep);
  const inAnyTarget = f => checks.some(c => inside(f, c.abs));
  // Served symlinks must not point into a trimmed path.
  (function links(d) {
    let ents;
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isSymbolicLink()) {
        let real; try { real = fs.realpathSync(p); } catch { continue; }
        for (const c of checks) if (inside(real, fs.realpathSync(c.abs))) errors.push(`${c.name}/${c.t}: served symlink ${path.relative(root, p)} points into it`);
      } else if (e.isDirectory()) links(p);
    }
  })(path.join(root, 'static'));
  // bower_components/ entries link to whole packages; a link to a package
  // root is fine (its trims are covered by the name checks), a link into a
  // trimmed path is not.
  let bower = [];
  try { bower = fs.readdirSync(path.join(root, 'bower_components')); } catch {}
  for (const e of bower.flatMap(e => e.startsWith('@')
    ? fs.readdirSync(path.join(root, 'bower_components', e)).map(x => `${e}/${x}`) : [e])) {
    let real; try { real = fs.realpathSync(path.join(root, 'bower_components', e)); } catch { continue; }
    for (const c of checks) {
      if (inside(real, fs.realpathSync(c.abs))) errors.push(`${c.name}/${c.t}: bower_components/${e} points into it`);
      else if (inside(fs.realpathSync(c.abs), real) && !SERVED_REVIEWED.has(c.name)) errors.push(`${c.name}/${c.t}: package is served whole as bower_components/${e}`);
    }
  }
  // ES module copies: nothing may load these packages through import.
  if (esmNames.size) {
    const typeModule = new Map();
    const isModuleType = dir => {
      if (!typeModule.has(dir)) {
        let t = false; try { t = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).type === 'module'; } catch {}
        typeModule.set(dir, t);
      }
      return typeModule.get(dir);
    };
    const pkgRoot = f => {
      const rel = path.relative(nm, f).split(path.sep);
      const i = rel.lastIndexOf('node_modules');
      const base = i >= 0 ? rel.slice(0, i + 1) : [];
      const rest = rel.slice(base.length);
      const n = rest[0].startsWith('@') ? rest.slice(0, 2) : rest.slice(0, 1);
      return path.join(nm, ...base, ...n);
    };
    const names = [...esmNames].map(esc).join('|');
    const importRe = new RegExp(`(\\bfrom\\s*|\\bimport\\s*\\(?\\s*)["'\`](${names})(/[^"'\`]*)?["'\`]`);
    for (const f of texts) {
      if (inAnyTarget(f)) continue;
      const underNm = f.startsWith(nm + path.sep);
      let s; try { s = fs.readFileSync(f, 'utf8'); } catch { continue; }
      const isEsm = underNm ? (/\.mjs$/.test(f) || (/\.js$/.test(f) && isModuleType(pkgRoot(f)))) : /\bimport\s*\(/.test(s);
      if (!isEsm) continue;
      const m = importRe.exec(s);
      if (m) errors.push(`${m[2]}: ES module copy trimmed but ${path.relative(root, f)} imports it`);
    }
  }
  const failed = new Set();
  for (const f of texts) {
    // Files inside any trimmed path are removed too, so they don't count.
    if (inAnyTarget(f)) continue;
    let s = null;
    for (const c of checks) {
      if (failed.has(c)) continue;
      if (s === null) { try { s = fs.readFileSync(f, 'utf8'); } catch { s = ''; } }
      // Relative paths only count inside the package itself, not inside
      // packages nested in its own node_modules/.
      const inPkg = f.startsWith(c.dir + path.sep) && path.basename(f) !== 'package.json' &&
        !path.relative(c.dir, f).split(path.sep).includes('node_modules');
      if (c.named.test(s) || (inPkg && c.relative.test(s))) {
        failed.add(c);
        errors.push(`${c.name}/${c.t}: named in ${path.relative(root, f)}`);
      }
    }
  }
  const out = checks.filter(c => !failed.has(c)).map(c => c.abs);
  if (errors.length) {
    console.error('trim check failed:\n  ' + errors.join('\n  '));
    process.exit(2);
  }
  process.stdout.write(out.map(p => p + '\0').join(''));
  process.exit(0);
}

if (process.argv.includes('--junk0')) {
  // Non-runtime folders and Markdown docs inside kept packages (licenses kept).
  const out = [];
  const visit = (d) => {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        if (NON_RUNTIME_DIRS.has(e.name)) out.push(p); else visit(p);
      } else if (/\.(md|markdown)$/i.test(e.name) && !/^licen[cs]e/i.test(e.name)) {
        out.push(p);
      }
    }
  };
  for (const name of kept) visit(path.join(nm, name));
  for (const [name, targets] of assets) if (!kept.has(name) && targets === 'ALL') visit(path.join(nm, name));
  process.stdout.write(out.map(p => p + '\0').join(''));
  process.exit(0);
}

const removable = pkgs.filter(p => !kept.has(p) && !assets.has(p));

if (process.argv.includes('--asset-trim0')) {
  const out = [];
  for (const [name, targets] of assets) {
    if (kept.has(name) || targets === 'ALL') continue;
    const dir = path.join(nm, name);
    const stack = [dir];
    while (stack.length) {
      const d = stack.pop();
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) stack.push(p);
        else if (!targets.has(p) && p !== path.join(dir, 'package.json') && !/^licen[cs]e/i.test(e.name)) out.push(p);
      }
    }
  }
  process.stdout.write(out.map(p => p + '\0').join(''));
  process.exit(0);
}
function sizeOf(dir) {
  let total = 0;
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.isFile()) total += fs.statSync(p).size;
    }
  }
  return total;
}
let sum = 0;
const rows = removable.map(p => { const s = sizeOf(path.join(nm, p)); sum += s; return [s, p]; })
  .sort((a, b) => b[0] - a[0]);
if (process.argv.includes('--names')) {
  console.log(rows.map(r => r[1]).join('\n'));
} else {
  for (const [s, p] of rows) console.log(`${(s / 1e6).toFixed(1).padStart(7)} MB  ${p}`);
  const assetOnly = [...assets.keys()].filter(n => !kept.has(n));
  console.log(`kept ${kept.size} / ${pkgs.length} packages (+${assetOnly.length} asset-only: ${assetOnly.join(', ')}); removable ${rows.length}, ${(sum / 1e6).toFixed(1)} MB`);
}
