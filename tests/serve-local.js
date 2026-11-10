// Try the whole website locally WITHOUT Google:  node tests/serve-local.js
// → http://localhost:8080/partner.html   (test login: admin@justlife.com / test-pass-123)
// Runs Code.gs in memory as a fake "web app" on :8081 and serves the site on :8080.
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const gas = require('./gas-mock');

const ROOT = path.join(__dirname, '..');
const SITE = Number(process.env.PORT || 8080);
const API = SITE + 1;

const rt = gas.load(path.join(ROOT, 'Code.gs'));
const G = rt.ctx;
G.setup();
const set = (k, v) => G.update_('Settings', G.read_('Settings').find((x) => x.key === k), { value: v });
set('AUTH_MODE', 'test');
set('TEST_PASSWORD', 'test-pass-123');
set('SITE_URL', `http://localhost:${SITE}/`);
const doc = G.read_('Doctors')[0];
G.update_('Doctors', doc, { email: 'doctor@justlife.com', sun: '08:00-22:00', mon: '08:00-22:00', tue: '08:00-22:00', wed: '08:00-22:00', thu: '08:00-22:00', fri: '08:00-22:00', sat: '08:00-22:00' });
const admin = { mode: 'test', email: 'admin@justlife.com', password: 'test-pass-123' };
const link = G.handle_({ action: 'createLink', data: { label: 'Demo', bookingRef: 'JL-DEMO-1', singleUse: false }, auth: admin }).data.token;

gas.serve(rt, API);
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json' };
http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  let file = decodeURIComponent(url.pathname);
  if (file === '/') file = '/index.html';
  if (file === '/config.js') { // point the site at the local fake web app
    const cfg = fs.readFileSync(path.join(ROOT, 'config.js'), 'utf8').replace(/APPS_SCRIPT_URL: '[^']*'/, `APPS_SCRIPT_URL: 'http://127.0.0.1:${API}/exec'`);
    res.writeHead(200, { 'Content-Type': 'text/javascript' }); return res.end(cfg);
  }
  const p = path.join(ROOT, path.normalize(file).replace(/^(\.\.[/\\])+/, ''));
  if (!p.startsWith(ROOT) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); return res.end('Not found'); }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(p)] || 'application/octet-stream' });
  return fs.createReadStream(p).pipe(res);
}).listen(SITE, () => {
  console.log(`Client booking : http://localhost:${SITE}/index.html?t=${link}`);
  console.log(`Staff portal   : http://localhost:${SITE}/partner.html  (admin@justlife.com or doctor@justlife.com / test-pass-123)`);
  console.log(`LINK_TOKEN=${link}`);
});
