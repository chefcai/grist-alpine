#!/usr/bin/env python3
"""Functional test suite for a grist-alpine image (stdlib only).

Starts a throwaway container, exercises the server through its REST API and
static pages, restarts the container, re-checks, and inspects the logs.
Check IDs match the project test plan (A1..A18).

Usage:  tests/functional.py <image> [--port N] [--keep]
        (default port: a free local port)
Env:    DOCKER=podman to use podman instead of docker.
"""
import argparse
import io
import json
import os
import re
import socket
import struct
import subprocess
import sys
import time
import urllib.error
import urllib.request
import uuid
import zipfile
import zlib

USER_HEADER = "X-Test-User"
EMAIL = "test@example.com"
DOCKER = os.environ.get("DOCKER", "docker")
ANSI = re.compile(r"\x1b\[[0-9;]*m")

results = []


def check(cid, desc, ok, detail=""):
    results.append((cid, desc, bool(ok), detail))
    print(f"[{'PASS' if ok else 'FAIL'}] {cid} {desc}" + (f" -- {detail}" if detail else ""), flush=True)
    return ok


def sh(*args, check_rc=True):
    p = subprocess.run(args, capture_output=True, text=True)
    if check_rc and p.returncode != 0:
        raise RuntimeError(f"{' '.join(args)} failed: {p.stderr.strip()}")
    return p.stdout


class Api:
    def __init__(self, base):
        self.base = base

    def req(self, method, path, body=None, headers=None, raw=False, auth=True):
        h = {USER_HEADER: EMAIL} if auth else {}
        h.update(headers or {})
        data = None
        if body is not None and not isinstance(body, (bytes, bytearray)):
            data = json.dumps(body).encode()
            h.setdefault("Content-Type", "application/json")
        elif body is not None:
            data = bytes(body)
        r = urllib.request.Request(self.base + path, data=data, method=method, headers=h)
        with urllib.request.urlopen(r, timeout=60) as resp:
            payload = resp.read()
            return (resp.status, payload, dict(resp.headers)) if raw else json.loads(payload or b"null")

    def upload(self, path, fields, filename, content, ctype):
        bd = uuid.uuid4().hex
        parts = []
        for k, v in fields.items():
            parts.append(f'--{bd}\r\nContent-Disposition: form-data; name="{k}"\r\n\r\n{v}\r\n'.encode())
        parts.append(
            f'--{bd}\r\nContent-Disposition: form-data; name="upload"; filename="{filename}"\r\n'
            f"Content-Type: {ctype}\r\n\r\n".encode() + content + b"\r\n")
        parts.append(f"--{bd}--\r\n".encode())
        return self.req("POST", path, b"".join(parts), headers={
            "Content-Type": f"multipart/form-data; boundary={bd}",
            "X-Requested-With": "XMLHttpRequest"})


def make_png():
    """A valid 4x4 RGB PNG built without external libraries."""
    w = h = 4
    raw = b"".join(b"\x00" + bytes([200, 60, 60]) * w for _ in range(h))

    def chunk(t, d):
        return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b""))


def make_xlsx(rows):
    """Minimal XLSX (inline strings) readable by openpyxl."""
    def cell(ref, v):
        if isinstance(v, (int, float)):
            return f'<c r="{ref}"><v>{v}</v></c>'
        return f'<c r="{ref}" t="inlineStr"><is><t>{v}</t></is></c>'
    sheet_rows = []
    for i, row in enumerate(rows, 1):
        cells = "".join(cell(f"{chr(65 + j)}{i}", v) for j, v in enumerate(row))
        sheet_rows.append(f'<row r="{i}">{cells}</row>')
    files = {
        "[Content_Types].xml": '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>',
        "_rels/.rels": '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
        "xl/workbook.xml": '<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Purchases" sheetId="1" r:id="rId1"/></sheets></workbook>',
        "xl/_rels/workbook.xml.rels": '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
        "xl/worksheets/sheet1.xml": '<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>' + "".join(sheet_rows) + "</sheetData></worksheet>",
    }
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for name, text in files.items():
            z.writestr(name, text)
    return buf.getvalue()


def wait_up(api, seconds=90):
    for i in range(seconds):
        try:
            if api.req("GET", "/status", raw=True, auth=False)[0] == 200:
                return i + 1
        except Exception:
            pass
        time.sleep(1)
    return None


def records(api, doc, table):
    return [r["fields"] for r in api.req("GET", f"/api/docs/{doc}/tables/{table}/records")["records"]]


def check_formulas(api, doc, label):
    rows = records(api, doc, "Receipts")
    r0 = rows[0] if rows else {}
    cats = {r["Name"]: r["Total"] for r in records(api, doc, "Categories")}
    expected = {"WithTax": 13.28, "Upper": "HOME DEPOT", "Month": 9, "IsoDate": "2026-09-29",
                "Masked": "Receipt ##", "PyVer": "3.11"}
    bad = {k: (r0.get(k), v) for k, v in expected.items() if r0.get(k) != v}
    ok_cats = abs(cats.get("Tools", 0) - 32.5) < 1e-9 and abs(cats.get("Paint", 0) - 8.0) < 1e-9
    return check(f"A5{label}", "Formulas (arith, text, DATE/MONTH, datetime, re, lookups/SUM, sys)",
                 not bad and ok_cats, "" if (not bad and ok_cats) else f"mismatch={bad} cats={cats}")


def asset_check(api, page):
    status, html, _ = api.req("GET", page, raw=True)
    html = html.decode("utf-8", "replace")
    m = re.search(r'<base href="([^"]*)"', html, re.I)
    base = re.sub(r"^https?://[^/]+", "", m.group(1)) if m else page.rsplit("/", 1)[0] + "/"
    assets = sorted(set(re.findall(r'(?:src|href)="([^"]+\.(?:js|css))"', html)))
    n = 0
    for a in assets:
        if a.startswith("//"):
            continue
        if re.match(r"https?://", a):
            url = re.sub(r"^https?://[^/]+", "", a)
        elif a.startswith("/"):
            url = a
        else:
            url = base.rstrip("/") + "/" + a.lstrip("./")
        try:
            code = api.req("GET", url, raw=True)[0]
        except urllib.error.HTTPError as e:
            code = e.code
        if code != 200:
            return False, f"{page}: {a} -> {code}"
        n += 1
    return n > 0, f"{page}: {n} assets"


LINKS_JS = r"""
const fs = require('fs'), path = require('path');
const deps = Object.keys(require('/grist/package.json').dependencies || {});
const out = [];
for (const dir of ['/grist/static', '/grist/bower_components']) {
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isSymbolicLink()) {
        const t = path.resolve(path.dirname(p), fs.readlinkSync(p));
        const m = t.match(/node_modules\/((?:@[^/]+\/)?[^/]+)/);
        if (m) out.push({ p: path.relative('/grist', p), pkg: m[1],
                          prod: deps.includes(m[1]), exists: fs.existsSync(t) });
      } else if (e.isDirectory()) walk(p);
    }
  })(dir);
}
console.log(JSON.stringify(out));
"""


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("image")
    ap.add_argument("--port", type=int, default=0)
    ap.add_argument("--keep", action="store_true")
    args = ap.parse_args()
    if not args.port:
        with socket.socket() as s:
            s.bind(("127.0.0.1", 0))
            args.port = s.getsockname()[1]
    name = f"grist-functional-{os.getpid()}"
    api = Api(f"http://127.0.0.1:{args.port}")

    sh(DOCKER, "run", "-d", "--name", name, "-p", f"127.0.0.1:{args.port}:8484",
       "-e", f"GRIST_FORWARD_AUTH_HEADER={USER_HEADER}", "-e", "GRIST_IGNORE_SESSION=true",
       "-e", f"GRIST_DEFAULT_EMAIL={EMAIL}", "-e", "GRIST_SINGLE_ORG=docs",
       "-e", "GRIST_SANDBOX_FLAVOR=gvisor", "-e", "GRIST_IN_SERVICE=true", args.image)
    try:
        run(api, name, args)
    except Exception as e:  # any unexpected exception is a failure
        check("ERR", "Unexpected exception", False, repr(e))
    finally:
        if not args.keep:
            sh(DOCKER, "rm", "-f", name, check_rc=False)

    failed = [r for r in results if not r[2]]
    print(f"\nSUMMARY: {len(results) - len(failed)}/{len(results)} checks passed")
    if failed:
        print("FAILED: " + ", ".join(r[0] for r in failed))
        sys.exit(1)
    print("RESULT: PASS")


def run(api, name, args):
    t = wait_up(api)
    if not check("A1", "Server answers /status", t, f"{t}s" if t else "timeout"):
        return
    node_v = sh(DOCKER, "exec", name, "node", "--version").strip()
    py_v = sh(DOCKER, "exec", name, "python3", "--version").strip()
    check("A2", "Node 22 and Python 3.11", node_v.startswith("v22.") and py_v.startswith("Python 3.11"),
          f"{node_v}, {py_v}")
    intl = sh(DOCKER, "exec", name, "node", "-e",
              "console.log(JSON.stringify(["
              "new Intl.NumberFormat('de-DE',{style:'currency',currency:'EUR'}).format(1234.5),"
              "new Intl.DateTimeFormat('fr-FR',{month:'long'}).format(new Date(2026,8,29)),"
              "new Intl.NumberFormat('hi-IN').format(1234567)]))").strip()
    check("A17", "Full ICU locale data (de-DE, fr-FR, hi-IN formatting)",
          json.loads(intl) == ["1.234,50\u00a0\u20ac", "septembre", "12,34,567"], intl)

    ws = api.req("GET", "/api/orgs/current/workspaces")[0]["id"]
    doc = api.req("POST", f"/api/workspaces/{ws}/docs", {"name": "functional"})
    api.req("POST", f"/api/docs/{doc}/tables", {"tables": [
        {"id": "Categories", "columns": [
            {"id": "Name", "fields": {"type": "Text"}},
            {"id": "Total", "fields": {"type": "Numeric", "isFormula": True,
                                       "formula": "SUM(Receipts.lookupRecords(Category=$Name).Amount)"}}]},
        {"id": "Receipts", "columns": [
            {"id": "Store", "fields": {"type": "Text"}},
            {"id": "Category", "fields": {"type": "Text"}},
            {"id": "Amount", "fields": {"type": "Numeric"}},
            {"id": "Photo", "fields": {"type": "Attachments"}},
            {"id": "WithTax", "fields": {"type": "Numeric", "isFormula": True, "formula": "round($Amount * 1.0625, 2)"}},
            {"id": "Upper", "fields": {"type": "Text", "isFormula": True, "formula": "$Store.upper()"}},
            {"id": "Month", "fields": {"type": "Numeric", "isFormula": True, "formula": "MONTH(DATE(2026, 9, 29))"}},
            {"id": "IsoDate", "fields": {"type": "Text", "isFormula": True,
                                        "formula": "import datetime\nreturn datetime.date(2026, 9, 29).isoformat()"}},
            {"id": "Masked", "fields": {"type": "Text", "isFormula": True,
                                       "formula": "re.sub(r'\\d', '#', 'Receipt 42')"}},
            {"id": "PyVer", "fields": {"type": "Text", "isFormula": True,
                                      "formula": "import sys\nreturn '%d.%d' % sys.version_info[:2]"}}]}]})
    check("A4", "Create document and tables", bool(doc), doc)

    api.req("POST", f"/api/docs/{doc}/tables/Categories/records",
            {"records": [{"fields": {"Name": "Tools"}}, {"fields": {"Name": "Paint"}}]})
    api.req("POST", f"/api/docs/{doc}/tables/Receipts/records", {"records": [
        {"fields": {"Store": "Home Depot", "Category": "Tools", "Amount": 12.5}},
        {"fields": {"Store": "Hardware", "Category": "Tools", "Amount": 20}},
        {"fields": {"Store": "Paint shop", "Category": "Paint", "Amount": 8}}]})
    api.req("PATCH", f"/api/docs/{doc}/tables/Receipts/records",
            {"records": [{"id": 2, "fields": {"Store": "Harbor Freight"}}]})
    stores = [r["Store"] for r in records(api, doc, "Receipts")]
    check("A6", "Add, update and read records", stores == ["Home Depot", "Harbor Freight", "Paint shop"], str(stores))
    check_formulas(api, doc, "")

    _, x, _ = api.req("GET", f"/api/docs/{doc}/download/xlsx", raw=True)
    xlsx_ok = x[:2] == b"PK" and "xl/workbook.xml" in zipfile.ZipFile(io.BytesIO(x)).namelist()
    _, c, _ = api.req("GET", f"/api/docs/{doc}/download/csv?tableId=Receipts", raw=True)
    csv_ok = "Harbor Freight" in c.decode("utf-8", "replace")
    _, g, _ = api.req("GET", f"/api/docs/{doc}/download", raw=True)
    grist_ok = g[:16] == b"SQLite format 3\x00"
    check("A7", "Downloads: XLSX, CSV, .grist", xlsx_ok and csv_ok and grist_ok,
          f"xlsx={xlsx_ok} csv={csv_ok} grist={grist_ok}")

    csv_doc = api.upload("/api/docs", {"workspaceId": ws}, "receipts.csv",
                         b"Item,Amount\nNails,3.5\nTape,2\n", "text/csv")
    t_csv = api.req("GET", f"/api/docs/{csv_doc}/tables")["tables"][0]["id"]
    rows = records(api, csv_doc, t_csv)
    check("A8", "Import CSV", rows == [{"Item": "Nails", "Amount": 3.5}, {"Item": "Tape", "Amount": 2}], str(rows))

    xlsx_doc = api.upload("/api/docs", {"workspaceId": ws}, "purchases.xlsx",
                          make_xlsx([["Item", "Amount"], ["Roller", 9.48], ["Tray", 4.98]]),
                          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
    t_x = api.req("GET", f"/api/docs/{xlsx_doc}/tables")["tables"][0]["id"]
    rows = records(api, xlsx_doc, t_x)
    check("A9", "Import XLSX", rows == [{"Item": "Roller", "Amount": 9.48}, {"Item": "Tray", "Amount": 4.98}],
          str(rows))

    png = make_png()
    att = api.upload(f"/api/docs/{doc}/attachments", {}, "receipt.png", png, "image/png")
    att_id = att[0]
    api.req("PATCH", f"/api/docs/{doc}/tables/Receipts/records",
            {"records": [{"id": 1, "fields": {"Photo": ["L", att_id]}}]})
    _, got, _ = api.req("GET", f"/api/docs/{doc}/attachments/{att_id}/download", raw=True)
    meta = api.req("GET", f"/api/docs/{doc}/attachments/{att_id}")
    photo = records(api, doc, "Receipts")[0].get("Photo")
    check("A10", "Attachment upload, link, byte-exact download, metadata",
          got == png and meta.get("fileName") == "receipt.png" and photo == ["L", att_id],
          f"bytes_equal={got == png} meta={meta.get('fileName')} cell={photo}")

    _, key_raw, _ = api.req("POST", "/api/profile/apiKey", {}, raw=True)
    key = key_raw.decode().strip().strip('"')
    try:
        docs = api.req("GET", f"/api/workspaces/{ws}", headers={"Authorization": f"Bearer {key}"}, auth=False)
        names = sorted(d["name"] for d in docs.get("docs", []))
        key_ok = "functional" in names
    except urllib.error.HTTPError as e:
        key_ok, names = False, f"HTTP {e.code}"
    check("A11", "API key create and Bearer use", key_ok, str(names))

    states = api.req("GET", f"/api/docs/{doc}/states").get("states", [])
    check("A12", "Document action history", len(states) >= 5, f"{len(states)} states")

    # A18: files the server serves through symlinks into node_modules
    # (static/ and bower_components/). Links to dev-only packages are broken in
    # upstream's production image too, so only production dependencies count.
    links = json.loads(sh(DOCKER, "exec", name, "node", "-e", LINKS_JS))
    missing = [l["p"] for l in links if l["prod"] and not l["exists"]]
    _, home, _ = api.req("GET", "/", raw=True)
    m = re.search(r'<base href="([^"]*)"', home.decode("utf-8", "replace"), re.I)
    base = re.sub(r"^https?://[^/]+", "", m.group(1)) if m else "/"
    http_bad = []
    for l in links:
        if l["prod"] and l["p"].startswith("static/") and l["exists"]:
            url = base.rstrip("/") + "/" + l["p"][len("static/"):]
            try:
                code = api.req("GET", url, raw=True)[0]
            except urllib.error.HTTPError as e:
                code = e.code
            if code != 200:
                http_bad.append(f"{url} -> {code}")
    prod_links = [l["p"] for l in links if l["prod"]]
    check("A18", "Served symlinks into node_modules (production deps) exist and return 200",
          not missing and not http_bad,
          f"checked {len(prod_links)}; missing={missing} http={http_bad}")

    all_ok, details = True, []
    for page in ["/", f"/doc/{doc}", "/apiconsole"]:
        ok, d = asset_check(api, page)
        all_ok &= ok
        details.append(d)
    check("A13", "Web pages load every script and stylesheet", all_ok, "; ".join(details))

    sh(DOCKER, "restart", name)
    t = wait_up(api)
    persisted = False
    if t:
        rows = records(api, doc, "Receipts")
        persisted = len(rows) == 3 and rows[0].get("Photo") == ["L", att_id]
    check("A14", "Restart: server returns, data and attachment link persist", t and persisted,
          f"up after {t}s" if t else "timeout")
    if t:
        check_formulas(api, doc, "-after-restart")

    logs = ANSI.sub("", subprocess.run([DOCKER, "logs", name], capture_output=True, text=True).stdout +
                    subprocess.run([DOCKER, "logs", name], capture_output=True, text=True).stderr)
    check("A3", "gVisor sandbox active", "gvisor check ok" in logs and "flavor=gvisor" in logs)
    bad = [l for l in logs.splitlines()
           if re.search(r"\b(error|exception|unhandled)\b", l, re.I)]
    check("A15", "No error/exception lines in server log", not bad, "\n    ".join(bad[:8]))

    size = sh(DOCKER, "image", "inspect", args.image, "--format", "{{.Size}}").strip()
    check("A16", "Image size recorded", True, f"{int(size) / 1e6:.0f} MB")


if __name__ == "__main__":
    main()
