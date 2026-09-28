#!/usr/bin/env node
// Lists top-level packages in node_modules that are never referenced by
// server-side code, directly or through another kept package. Browser-only
// dependencies are already bundled into static/ by webpack, so these are safe
// to delete from the runtime image.
//
// Conservative by design:
//  - every compiled file under _build/ except app/client/** counts as a root,
//    as do sandbox/**, every entry of bower_components/ (served statically,
//    symlinked into node_modules) and every html/js/css/json file in static/
//  - a package counts as referenced if its name appears in ANY string literal
//    of a root file or of any JS file inside another referenced package
//    (catches dynamic require("name") as well as static requires)
//  - the closure is iterated to a fixed point
//  - package.json "dependencies"/"optionalDependencies"/"peerDependencies" of
//    referenced packages are also kept
//
// Usage: node find-client-only-deps.js /grist
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
const STATIC_EXT = /\.(html?|(c|m)?js|css|json)$/i;

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

const pkgs = listPackages();
const pkgSet = new Set(pkgs);
const strRe = /["'`]((?:@[a-z0-9._~-]+\/)?[a-z0-9._~-]+)(?:\/[^"'`\s]*)?["'`]/gi;

function refsIn(file) {
  const found = new Set();
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return found; }
  let m;
  while ((m = strRe.exec(text))) {
    if (pkgSet.has(m[1])) found.add(m[1]);
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
// bower_components/ is served as static files and its entries are symlinks
// into node_modules; every entry there is needed at runtime.
try {
  for (const e of fs.readdirSync(path.join(root, 'bower_components'))) {
    if (e.startsWith('@')) {
      for (const s of fs.readdirSync(path.join(root, 'bower_components', e))) keep(`${e}/${s}`, 'bower_components');
    } else {
      keep(e, 'bower_components');
    }
  }
} catch {}
// static/ pages and assets can load packages through bower-style relative
// paths (e.g. "jquery/dist/jquery.min.js"); scan every html/js/css/json file.
for (const f of walk(path.join(root, 'static'), null, STATIC_EXT)) {
  for (const r of refsIn(f)) keep(r, path.relative(root, f));
}

while (queue.length) {
  const name = queue.shift();
  const dir = path.join(nm, name);
  try {
    const pj = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    for (const k of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
      for (const d of Object.keys(pj[k] || {})) keep(d, `${name} package.json ${k}`);
    }
  } catch {}
  for (const f of walk(dir)) {
    for (const r of refsIn(f)) keep(r, `${name}/${path.relative(dir, f)}`);
  }
}

const removable = pkgs.filter(p => !kept.has(p));
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
  console.log(`kept ${kept.size} / ${pkgs.length} packages; removable ${rows.length}, ${(sum / 1e6).toFixed(1)} MB`);
}
