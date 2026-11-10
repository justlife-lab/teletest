// Automated tests for Code.gs — run with:  node tests/run-tests.js
// Executes the real Code.gs inside an in-memory Apps Script runtime.
'use strict';
const path = require('path');
const assert = require('assert');
const gas = require('./gas-mock');

const tokeninfo = {};
const rt = gas.load(path.join(__dirname, '..', 'Code.gs'), { tokeninfo });
const G = rt.ctx;
let pass = 0;
const results = [];
function test(name, fn) {
  try { fn(); pass++; results.push(`  ✓ ${name}`); } catch (e) { results.push(`  ✗ ${name}\n      ${e.message}`); process.exitCode = 1; }
}
const call = (action, data, auth) => G.handle_({ action, data: data || {}, auth });
const ok = (r) => { assert.ok(r.ok, `expected ok, got ${JSON.stringify(r)}`); return r.data; };
const err = (r, code) => { assert.ok(!r.ok, `expected error ${code}, got ok`); if (code) assert.strictEqual(r.code, code, r.error); return r; };
const setSetting = (k, v) => { const row = G.read_('Settings').find((x) => x.key === k); G.update_('Settings', row, { value: v }); };
const PDF = Buffer.from('%PDF-1.4 test file').toString('base64');
const client = (n) => ({ name: `Client ${n}`, email: `client${n}@example.com`, mobile: '+971501234567', contactMethod: 'WHATSAPP', bookingRef: `JL-${n}` });

// ---------------------------------------------------------------------------
G.setup();
test('setup creates all tabs, default settings and a sample doctor', () => {
  const names = rt.book.getSheets().map((s) => s.getName());
  ['Settings', 'Doctors', 'Leaves', 'Appointments', 'Upsells', 'Links', 'Log'].forEach((t) => assert.ok(names.includes(t), t));
  assert.ok(!names.includes('Sheet1'), 'empty Sheet1 removed');
  assert.strictEqual(G.settings_().ALLOWED_DOMAIN, 'justlife.com');
  assert.strictEqual(G.read_('Doctors').length, 1);
});

setSetting('AUTH_MODE', 'test');
setSetting('TEST_PASSWORD', 'test-pass-123');
const ADMIN = { mode: 'test', email: 'cx@justlife.com', password: 'test-pass-123' };

test('client page without a link is refused when PUBLIC_BOOKING = FALSE', () => {
  const d = ok(call('init', {}));
  assert.strictEqual(d.link.ok, false);
  assert.strictEqual(d.settings.authMode, 'test');
  err(call('book', { doctorId: 'x', date: '2030-01-01', start: '09:00', client: client(0) }), 'LINK');
});

test('staff login: gmail refused, wrong password refused, @justlife.com admin ok', () => {
  err(call('me', {}, { mode: 'test', email: 'someone@gmail.com', password: 'test-pass-123' }), 'DOMAIN');
  err(call('me', {}, { mode: 'test', email: 'cx@justlife.com', password: 'nope' }), 'AUTH');
  err(call('me', {}), 'AUTH');
  const me = ok(call('me', {}, ADMIN));
  assert.strictEqual(me.user.role, 'ADMIN');
  assert.ok(me.upsellServices.length >= 5);
});

// second doctor for permission tests
const d2 = ok(call('saveDoctor', { doctor: { name: 'Dr. Second', email: 'second@justlife.com', specialty: 'GP', status: 'ACTIVE', sun: '08:00-22:00', mon: '08:00-22:00', tue: '08:00-22:00', wed: '08:00-22:00', thu: '08:00-22:00', fri: '08:00-22:00', sat: '08:00-22:00' } }, ADMIN));
const DOC1 = G.read_('Doctors').find((d) => d.name === 'Dr. Sample Doctor');
ok(call('saveDoctor', { doctor: Object.assign({}, G.stripRow_(DOC1), { email: 'sample.doctor@justlife.com', sun: '07:00-23:00', mon: '07:00-23:00', tue: '07:00-23:00', wed: '07:00-23:00', thu: '07:00-23:00', fri: '07:00-23:00', sat: '07:00-23:00' }) }, ADMIN));

test('saveDoctor rejects badly written working hours', () => {
  err(call('saveDoctor', { doctor: { name: 'Dr. Bad', mon: '9 to 5' } }, ADMIN), 'VALIDATION');
  err(call('saveDoctor', { doctor: { name: 'Dr. Dup', email: 'second@justlife.com' } }, ADMIN), 'DUPLICATE');
});

const single = ok(call('createLink', { label: 'Ahmed', bookingRef: 'JL-777', singleUse: true }, ADMIN)).token;
const multi = ok(call('createLink', { label: 'Reusable', singleUse: false }, ADMIN)).token;
let firstSlot;
let booked;

test('booking link opens the booking page with doctors and prefilled ref', () => {
  const d = ok(call('init', { t: single }));
  assert.strictEqual(d.link.ok, true);
  assert.strictEqual(d.link.bookingRef, 'JL-777');
  assert.strictEqual(d.doctors.length, 2);
  assert.ok(!('email' in d.doctors[0]), 'doctor emails are not public');
});

test('availability lists free slots inside working hours', () => {
  const a = ok(call('availability', { doctorId: d2.id, t: single })).doctors[d2.id];
  const days = Object.keys(a).sort();
  assert.ok(days.length >= 13, `days with slots: ${days.length}`);
  firstSlot = { date: days[1], start: a[days[1]][0] };
  assert.strictEqual(firstSlot.start, '08:00');
});

test('client books with a lab-result PDF; confirmation email sent', () => {
  const before = rt.mails.length;
  booked = ok(call('book', Object.assign({ t: single, doctorId: d2.id, client: client(1), files: [{ name: 'blood.pdf', base64: PDF }] }, firstSlot)));
  assert.match(booked.appointment.appointmentNo, /^JLTC-\d{6}$/);
  assert.strictEqual(booked.appointment.files, 1);
  assert.ok(booked.rescheduleToken.length >= 16);
  assert.ok(rt.mails.length >= before + 2, 'client + doctor emails');
  assert.match(rt.mails[before].subject, /Confirmed/);
});

test('single-use link cannot be used twice', () => {
  const d = ok(call('init', { t: single }));
  assert.strictEqual(d.link.ok, false);
  err(call('book', Object.assign({ t: single, doctorId: d2.id, client: client(2), date: firstSlot.date, start: '09:00' })), 'LINK');
});

test('same slot cannot be booked twice (double booking)', () => {
  err(call('book', Object.assign({ t: multi, doctorId: d2.id, client: client(3) }, firstSlot)), 'SLOT_TAKEN');
  const a = ok(call('availability', { doctorId: d2.id })).doctors[d2.id];
  assert.ok(!a[firstSlot.date].includes(firstSlot.start), 'booked slot hidden');
});

test('input validation and file checks', () => {
  err(call('book', { t: multi, doctorId: d2.id, date: firstSlot.date, start: '10:00', client: Object.assign(client(4), { email: 'bad' }) }), 'VALIDATION');
  err(call('book', { t: multi, doctorId: d2.id, date: firstSlot.date, start: '10:00', client: Object.assign(client(4), { mobile: '12' }) }), 'VALIDATION');
  err(call('book', { t: multi, doctorId: d2.id, date: firstSlot.date, start: '10:00', client: client(4), files: [{ name: 'x.pdf', base64: Buffer.from('<script>').toString('base64') }] }), 'UPLOAD');
  err(call('book', { t: multi, doctorId: d2.id, date: firstSlot.date, start: '10:17', client: client(4) }), 'SLOT_TAKEN');
});

test('client input is stored as text, never as a formula; 05x mobiles normalised', () => {
  const r = ok(call('book', { t: multi, doctorId: d2.id, date: firstSlot.date, start: '10:00', client: Object.assign(client(5), { name: '=IMPORTXML("http://evil")', mobile: '0501112233' }) }));
  const row = G.read_('Appointments').find((a) => a.appointmentNo === r.appointment.appointmentNo);
  assert.strictEqual(row.clientName, '=IMPORTXML("http://evil")');
  assert.strictEqual(row.clientMobile, '+971501112233');
});

test('client reschedules from their link; history kept; token moves to new version', () => {
  const look = ok(call('lookup', { r: booked.rescheduleToken }));
  assert.strictEqual(look.canReschedule, true);
  const res = ok(call('reschedule', { r: booked.rescheduleToken, doctorId: d2.id, date: firstSlot.date, start: '12:00', reason: 'meeting' }));
  assert.match(res.appointment.appointmentNo, /-R1$/);
  const all = G.read_('Appointments');
  const old = all.find((a) => a.appointmentNo === booked.appointment.appointmentNo);
  assert.strictEqual(old.status, 'RESCHEDULED');
  assert.strictEqual(old.rescheduleToken, '');
  const a = ok(call('availability', { doctorId: d2.id })).doctors[d2.id][firstSlot.date];
  assert.ok(a.includes('08:00') && !a.includes('12:00'), 'old slot freed, new slot taken');
  assert.strictEqual(ok(call('lookup', { r: booked.rescheduleToken })).appointment.start, '12:00');
});

let doctorAuth;
test('doctor signs in and sees only their own appointments', () => {
  doctorAuth = { mode: 'test', email: 'second@justlife.com', password: 'test-pass-123' };
  const me = ok(call('me', {}, doctorAuth));
  assert.strictEqual(me.user.role, 'DOCTOR');
  const other = ok(call('book', { t: multi, doctorId: DOC1.id, date: firstSlot.date, start: '13:00', client: client(6) }));
  const list = ok(call('appointments', {}, doctorAuth)).rows;
  assert.ok(list.length >= 2 && list.every((a) => a.doctorId === d2.id), 'only own');
  assert.ok(list.every((a) => a.status !== 'RESCHEDULED'), 'superseded versions hidden');
  const otherId = G.read_('Appointments').find((a) => a.appointmentNo === other.appointment.appointmentNo).id;
  err(call('appointment', { id: otherId }, doctorAuth), 'NOT_FOUND');
  err(call('doctors', {}, doctorAuth), 'FORBIDDEN');
});

test('consultation: start call, notes required, complete, upsells, lab result download', () => {
  const appt = G.read_('Appointments').find((a) => a.rescheduleToken === booked.rescheduleToken);
  err(call('startCall', { id: appt.id }, doctorAuth), 'STATE'); // future day
  G.update_('Appointments', appt, { date: G.todayKey_(), start: '00:00', end: '01:00' }); // pretend it's today
  const started = ok(call('startCall', { id: appt.id }, doctorAuth)).appointment;
  assert.strictEqual(started.status, 'CALLING');
  assert.ok(Number(started.callDelayMin) >= 0);
  err(call('complete', { id: appt.id, notes: { mainIssue: 'x' } }, doctorAuth), 'VALIDATION');
  let d = ok(call('addUpsell', { id: appt.id, upsell: { service: 'Lab Test', recommendedAmount: 250, status: 'RECOMMENDED' } }, doctorAuth));
  assert.strictEqual(d.upsells.length, 1);
  d = ok(call('updateUpsell', { id: appt.id, upsellId: d.upsells[0].id, upsell: { status: 'BOOKED', bookedAmount: 230 } }, doctorAuth));
  assert.strictEqual(d.upsells[0].status, 'BOOKED');
  d = ok(call('complete', { id: appt.id, notes: { mainIssue: 'Fatigue', assessment: 'Stable', recommendation: 'Vitamin panel' } }, doctorAuth));
  assert.strictEqual(d.appointment.status, 'COMPLETED');
  assert.strictEqual(d.appointment.files.length, 1);
  const f = ok(call('getFile', { appointmentId: appt.id, fileId: d.appointment.files[0].id }, doctorAuth));
  assert.strictEqual(Buffer.from(f.base64, 'base64').toString(), '%PDF-1.4 test file');
});

test('admin: book, reschedule, cancel, leave blocks days, dashboard KPIs', () => {
  const slots = ok(call('adminSlots', { doctorId: DOC1.id, date: firstSlot.date }, ADMIN)).slots;
  assert.ok(slots.length > 5);
  const nb = ok(call('adminBook', { doctorId: DOC1.id, date: firstSlot.date, start: slots[0], client: client(7) }, ADMIN));
  const mv = ok(call('adminReschedule', { id: nb.id, doctorId: d2.id, date: firstSlot.date, start: '15:00', reason: 'doctor change' }, ADMIN));
  const moved = ok(call('appointment', { id: mv.id }, ADMIN));
  assert.strictEqual(moved.appointment.doctorName, 'Dr. Second');
  assert.strictEqual(moved.history.length, 1);
  assert.ok(moved.log.some((l) => l.action === 'RESCHEDULED'));
  err(call('adminReschedule', { id: mv.id, doctorId: d2.id, date: firstSlot.date, start: '10:00' }, ADMIN), 'SLOT_TAKEN');
  ok(call('adminCancel', { id: mv.id, reason: 'client asked' }, ADMIN));
  const day = addDays(firstSlot.date, 3);
  const lv = ok(call('addLeave', { doctorId: d2.id, from: day, to: day, reason: 'Holiday' }, ADMIN));
  assert.ok(Array.isArray(lv.conflicts));
  assert.ok(!ok(call('availability', { doctorId: d2.id })).doctors[d2.id][day], 'leave day hidden');
  const dash = ok(call('dashboard', { from: G.todayKey_(), to: addDays(G.todayKey_(), 30) }, ADMIN));
  assert.ok(dash.totals.total >= 3);
  assert.strictEqual(dash.totals.completed, 1);
  assert.strictEqual(dash.totals.gmv, 230);
  assert.strictEqual(dash.totals.upsellConversionPct, 100);
  const links = ok(call('links', {}, ADMIN)).links;
  assert.strictEqual(links.find((l) => l.token === single).liveStatus, 'USED');
});

test('client cancel from link', () => {
  const r = ok(call('book', { t: multi, doctorId: d2.id, date: addDays(firstSlot.date, 1), start: '09:00', client: client(8) }));
  ok(call('cancel', { r: r.rescheduleToken, reason: 'not needed' }));
  const l = ok(call('lookup', { r: r.rescheduleToken }));
  assert.strictEqual(l.appointment.status, 'CANCELLED');
  assert.strictEqual(l.canReschedule, false);
});

test('Google sign-in: verified @justlife.com accepted; other domains / wrong client ID refused', () => {
  setSetting('AUTH_MODE', 'google');
  setSetting('GOOGLE_CLIENT_ID', 'client-123.apps.googleusercontent.com');
  const exp = Math.floor(Date.now() / 1000) + 3600;
  tokeninfo['a.b.good'] = { aud: 'client-123.apps.googleusercontent.com', email: 'Manager@justlife.com', email_verified: 'true', hd: 'justlife.com', exp: String(exp), name: 'Manager' };
  tokeninfo['a.b.gmail'] = { aud: 'client-123.apps.googleusercontent.com', email: 'manager@gmail.com', email_verified: 'true', exp: String(exp) };
  tokeninfo['a.b.aud'] = { aud: 'other-client', email: 'x@justlife.com', email_verified: 'true', hd: 'justlife.com', exp: String(exp) };
  assert.strictEqual(ok(call('me', {}, { mode: 'google', idToken: 'a.b.good' })).user.email, 'manager@justlife.com');
  err(call('me', {}, { mode: 'google', idToken: 'a.b.gmail' }), 'DOMAIN');
  err(call('me', {}, { mode: 'google', idToken: 'a.b.aud' }), 'CONFIG');
  err(call('me', {}, { mode: 'google', idToken: 'a.b.unknown' }), 'AUTH');
  err(call('me', {}, ADMIN), 'AUTH'); // test logins stop working in google mode
  setSetting('ADMIN_EMAILS', 'boss@justlife.com');
  err(call('me', {}, { mode: 'google', idToken: 'a.b.good' }), 'FORBIDDEN');
  setSetting('ADMIN_EMAILS', '');
});

test('reminders: sent once, at the right offset', () => {
  const r = ok(call('book', { t: multi, doctorId: d2.id, date: addDays(firstSlot.date, 2), start: '09:00', client: client(9) }));
  const row = G.read_('Appointments').find((a) => a.appointmentNo === r.appointment.appointmentNo);
  const soon = new Date(Date.now() + 20 * 3600e3);
  const key = G.Utilities.formatDate(soon, 'Asia/Dubai', 'yyyy-MM-dd');
  const hhmm = new Date(soon.getTime() + 4 * 3600e3).toISOString().slice(11, 16);
  G.update_('Appointments', row, { date: key, start: hhmm, end: hhmm, createdAt: new Date(Date.now() - 5 * 86400e3).toISOString() });
  const before = rt.mails.length;
  const n1 = G.sendReminders();
  const n2 = G.sendReminders();
  assert.ok(n1 >= 1, `first run sent ${n1}`);
  assert.strictEqual(n2, 0);
  assert.ok(rt.mails.slice(before).some((m) => /Reminder/.test(m.subject)));
});

test('web app entry points return JSON', () => {
  const out = JSON.parse(G.doPost({ postData: { contents: JSON.stringify({ action: 'init', data: {} }) } }).text);
  assert.strictEqual(out.ok, true);
  assert.strictEqual(JSON.parse(G.doPost({ postData: { contents: 'not json' } }).text).ok, false);
  assert.strictEqual(JSON.parse(G.doGet({ parameter: {} }).text).ok, true);
});

function addDays(k, n) { const d = new Date(`${k}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }

console.log(results.join('\n'));
console.log(`\n${pass}/${results.length} passed`);
