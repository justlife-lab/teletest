// In-memory Google Apps Script runtime for testing Code.gs with Node.
// Usage: const gas = require('./gas-mock'); const rt = gas.load('../Code.gs');
//        rt.ctx.handle_({ action: 'init', data: {} })
'use strict';
const fs = require('fs');
const vm = require('vm');
const crypto = require('crypto');

function createRuntime(opts = {}) {
  let gid = 1;
  class Range {
    constructor(sh, r, c, nr, nc) { Object.assign(this, { sh, r, c, nr, nc }); }
    getDisplayValues() {
      const out = [];
      for (let i = 0; i < this.nr; i++) {
        const row = this.sh.cells[this.r - 1 + i] || [];
        const o = [];
        for (let j = 0; j < this.nc; j++) {
          let v = row[this.c - 1 + j];
          v = v == null ? '' : String(v);
          if (v.startsWith("'")) v = v.slice(1); // Sheets hides the leading apostrophe
          o.push(v);
        }
        out.push(o);
      }
      return out;
    }
    setNumberFormat(f) { this.fmt = f; return this; }
    setValues(vals) {
      if (vals.length !== this.nr || vals.some((r) => r.length !== this.nc)) throw new Error(`setValues: data ${vals.length}x${vals[0] && vals[0].length} does not match range ${this.nr}x${this.nc}`);
      vals.forEach((row, i) => row.forEach((v, j) => this._set(this.r + i, this.c + j, v)));
      return this;
    }
    setValue(v) { this._set(this.r, this.c, v); return this; }
    _set(r, c, v) {
      let val = v;
      if (typeof v === 'string' && this.fmt !== '@') {
        if (/^[+-]?\d+(\.\d+)?$/.test(v)) val = String(Number(v)); // what Sheets would do without plain-text format
        if (v.startsWith('=')) throw new Error(`FORMULA WRITTEN: ${v}`);
      }
      while (this.sh.cells.length < r) this.sh.cells.push([]);
      const row = this.sh.cells[r - 1];
      while (row.length < c) row.push('');
      row[c - 1] = val;
    }
    setFontWeight() { return this; }
    setBackground() { return this; }
  }
  class Sheet {
    constructor(name) { this.name = name; this.id = gid++; this.cells = []; }
    getName() { return this.name; }
    getLastRow() { let n = this.cells.length; while (n && !(this.cells[n - 1] || []).some((v) => v !== '' && v != null)) n--; return n; }
    getLastColumn() { return this.cells.reduce((m, r) => { let n = r.length; while (n && (r[n - 1] === '' || r[n - 1] == null)) n--; return Math.max(m, n); }, 0); }
    getRange(r, c, nr = 1, nc = 1) { if (r < 1 || c < 1 || nr < 1 || nc < 1) throw new Error(`bad range ${r},${c},${nr},${nc}`); return new Range(this, r, c, nr, nc); }
    deleteRow(r) { this.cells.splice(r - 1, 1); }
    setFrozenRows() {}
  }
  const sheets = [new Sheet('Sheet1')];
  const book = {
    getSheets: () => sheets,
    getSheetByName: (n) => sheets.find((s) => s.name === n) || null,
    insertSheet: (n) => { const s = new Sheet(n); sheets.push(s); return s; },
    deleteSheet: (s) => sheets.splice(sheets.indexOf(s), 1),
  };
  const props = {};
  const cache = new Map();
  const files = new Map();
  const mails = [];
  let fileSeq = 1;
  let locked = false;
  const tokeninfo = opts.tokeninfo || {}; // idToken -> payload
  const ctx = {
    console,
    SpreadsheetApp: { getActiveSpreadsheet: () => book, openByUrl: () => book, getUi: () => { throw new Error('no ui'); }, flush() {} },
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => (k in props ? props[k] : null), setProperty: (k, v) => { props[k] = String(v); } }) },
    LockService: { getScriptLock: () => ({ tryLock: () => { if (locked) return false; locked = true; return true; }, releaseLock: () => { locked = false; } }) },
    CacheService: { getScriptCache: () => ({ get: (k) => (cache.has(k) ? cache.get(k) : null), put: (k, v) => cache.set(k, v) }) },
    ContentService: { MimeType: { JSON: 'json' }, createTextOutput: (t) => ({ setMimeType: () => ({ text: t }) }) },
    MailApp: { sendEmail: (m) => mails.push(m) },
    Session: { getActiveUser: () => ({ getEmail: () => 'owner@justlife.com' }) },
    ScriptApp: { getProjectTriggers: () => [], newTrigger: () => ({ timeBased: () => ({ everyHours: () => ({ create() {} }) }) }) },
    UrlFetchApp: {
      fetch: (url) => {
        const tok = decodeURIComponent(String(url).split('id_token=')[1] || '');
        const p = tokeninfo[tok];
        return { getResponseCode: () => (p ? 200 : 400), getContentText: () => JSON.stringify(p || { error: 'invalid_token' }) };
      },
    },
    DriveApp: {
      createFolder: (name) => ({ getId: () => 'folder-1', name }),
      getFolderById: (id) => ({ getId: () => id, createFile: (blob) => { const f = { id: `drive-${fileSeq++}`, blob, trashed: false }; files.set(f.id, f); return { getId: () => f.id }; } }),
      getFileById: (id) => {
        const f = files.get(id);
        if (!f) throw new Error('No such file');
        return { getBlob: () => ({ getBytes: () => f.blob.bytes }), setTrashed: (t) => { f.trashed = t; } };
      },
    },
    Utilities: {
      formatDate: (d, tz, fmt) => {
        const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'long', }).formatToParts(d).map((p) => [p.type, p.value]));
        if (fmt === 'yyyy-MM-dd') return `${parts.year}-${parts.month}-${parts.day}`;
        if (fmt === 'EEEE, d MMMM yyyy') return d.toLocaleDateString('en-GB', { timeZone: tz, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).replace(/^(\w+) /, '$1, ');
        return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
      },
      getUuid: () => crypto.randomUUID(),
      computeDigest: (_alg, s) => Array.from(crypto.createHash('sha256').update(String(s)).digest()).map((b) => (b > 127 ? b - 256 : b)),
      DigestAlgorithm: { SHA_256: 'SHA_256' },
      base64EncodeWebSafe: (bytes) => Buffer.from(bytes.map((b) => (b + 256) % 256)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_'),
      base64Decode: (s) => Array.from(Buffer.from(s, 'base64')).map((b) => (b > 127 ? b - 256 : b)),
      base64Encode: (bytes) => Buffer.from(bytes.map((b) => (b + 256) % 256)).toString('base64'),
      newBlob: (bytes, mime, name) => ({ bytes, mime, name }),
    },
  };
  vm.createContext(ctx);
  return { ctx, book, props, mails, files, tokeninfo };
}

function load(codePath, opts) {
  const rt = createRuntime(opts);
  vm.runInContext(fs.readFileSync(codePath, 'utf8'), rt.ctx, { filename: 'Code.gs' });
  return rt;
}

/** Serves the runtime like a deployed Apps Script web app (POST → 302 → JSON with CORS). */
function serve(rt, port) {
  const http = require('http');
  const pending = new Map();
  return http.createServer(async (req, res) => {
    const cors = { 'Access-Control-Allow-Origin': '*' };
    if (req.method === 'OPTIONS') { res.writeHead(405, cors); return res.end(); } // Apps Script has no preflight support
    if (req.method === 'POST') {
      if (req.headers['content-type'] && !/^text\/plain/.test(req.headers['content-type'])) { res.writeHead(400, cors); return res.end('needs text/plain'); }
      const chunks = []; for await (const c of req) chunks.push(c);
      const out = rt.ctx.doPost({ postData: { contents: Buffer.concat(chunks).toString() } });
      const k = crypto.randomUUID();
      pending.set(k, out.text);
      res.writeHead(302, Object.assign({ Location: `http://127.0.0.1:${port}/echo?k=${k}` }, cors));
      return res.end();
    }
    const k = new URL(req.url, 'http://x').searchParams.get('k');
    res.writeHead(200, Object.assign({ 'Content-Type': 'application/json' }, cors));
    res.end(k ? pending.get(k) || '{}' : rt.ctx.doGet({ parameter: {} }).text);
    if (k) pending.delete(k);
  }).listen(port);
}

module.exports = { load, serve };
