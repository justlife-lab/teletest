/**
 * =============================================================================
 * Justlife Teleconsultation — Google Apps Script backend
 * =============================================================================
 * The Google Sheet is the database. This script is the API the website
 * (index.html / partner.html on GitHub Pages) talks to.
 *
 *   Tabs (created by Justlife ▸ Setup):
 *     Settings      key | value | description     ← edit settings here
 *     Doctors       one row per doctor, working hours per weekday
 *     Leaves        doctor leave / holidays
 *     Appointments  one row per booking version (reschedules keep history)
 *     Upsells       services recommended by doctors
 *     Links         booking links created by CX
 *     Log           audit trail
 *
 * SETUP (see README.md for screenshots-level detail)
 *   1. Open your Google Sheet → Extensions → Apps Script.
 *   2. Replace Code.gs with this file. Project Settings ▸ "Show appsscript.json"
 *      → replace it with appsscript.json from the repo. Save.
 *   3. Reload the sheet → menu Justlife ▸ Setup (approve permissions).
 *   4. Fill the Settings tab (GOOGLE_CLIENT_ID, SITE_URL, …).
 *   5. Deploy → New deployment → Web app → Execute as: Me, Who has access:
 *      Anyone → Deploy → copy the /exec URL into config.js ▸ APPS_SCRIPT_URL.
 *   6. Justlife ▸ Install reminder trigger.
 *   After every change to this file: Deploy → Manage deployments → ✏️ → Version:
 *   New version → Deploy (the URL stays the same).
 * =============================================================================
 */

// Leave '' when this script is opened from the sheet (Extensions → Apps Script).
// For a standalone script project, paste the Google Sheet link here.
var SHEET_URL = '';

var TZ = 'Asia/Dubai';
var TZ_OFFSET = '+04:00'; // Dubai has no daylight saving time

var TABS = {
  Settings: ['key', 'value', 'description'],
  Doctors: ['id', 'name', 'email', 'specialty', 'languages', 'experienceYears', 'bio', 'phone', 'whatsapp', 'photoUrl', 'status', 'sortOrder',
    'sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'createdAt', 'updatedAt'],
  Leaves: ['id', 'doctorId', 'doctorName', 'from', 'to', 'reason', 'createdBy', 'createdAt'],
  Appointments: ['id', 'appointmentNo', 'status', 'date', 'start', 'end', 'doctorId', 'doctorName', 'clientName', 'clientEmail', 'clientMobile',
    'bookingRef', 'contactMethod', 'clientNotes', 'files', 'source', 'linkToken', 'rescheduleToken', 'rescheduledFrom', 'rescheduleCount',
    'callStartedAt', 'callEndedAt', 'callDelayMin', 'outcome', 'mainIssue', 'assessment', 'recommendation', 'furtherTests', 'followUp',
    'adminNotes', 'cancelReason', 'remindersSent', 'createdBy', 'createdAt', 'updatedAt'],
  Upsells: ['id', 'appointmentId', 'appointmentNo', 'doctorName', 'service', 'status', 'recommendedAmount', 'bookedAmount', 'bookingRef', 'createdBy', 'createdAt', 'updatedAt'],
  Links: ['token', 'label', 'bookingRef', 'singleUse', 'expiresOn', 'status', 'uses', 'createdBy', 'createdAt'],
  Log: ['time', 'user', 'action', 'appointmentNo', 'details'],
};

var DEFAULT_SETTINGS = [
  ['APP_NAME', 'Justlife Teleconsultation', 'Name shown on the website and in emails'],
  ['SITE_URL', '', 'Public link of the website, e.g. https://justlife-lab.github.io/teleconsult/ (used in emails)'],
  ['AUTH_MODE', 'google', 'google = Google sign-in (@ALLOWED_DOMAIN only). test = email + TEST_PASSWORD (temporary)'],
  ['GOOGLE_CLIENT_ID', '', 'Google OAuth Web client ID — must be identical to GOOGLE_CLIENT_ID in config.js'],
  ['ALLOWED_DOMAIN', 'justlife.com', 'Only Google accounts on this domain can open the staff portal'],
  ['ADMIN_EMAILS', '', 'Optional, comma-separated. Empty = every @ALLOWED_DOMAIN user who is not a doctor is an admin'],
  ['TEST_PASSWORD', '', 'Only used when AUTH_MODE = test (min 8 characters)'],
  ['PUBLIC_BOOKING', 'FALSE', 'TRUE = anyone with the website link can book. FALSE = clients need a booking link from CX'],
  ['BOOKING_HORIZON_DAYS', '14', 'How many days ahead clients can book'],
  ['MIN_NOTICE_MINUTES', '30', 'Earliest bookable slot = now + this many minutes'],
  ['SLOT_MINUTES', '60', 'Consultation window length'],
  ['RESCHEDULE_CUTOFF_HOURS', '2', 'Clients can reschedule/cancel online until this many hours before'],
  ['MAX_RESCHEDULES', '3', 'Max online reschedules per booking'],
  ['ALLOW_CLIENT_CANCEL', 'TRUE', 'Clients may cancel from their link'],
  ['ON_TIME_TOLERANCE_MINUTES', '5', 'A call is on time if started within this many minutes of the window start'],
  ['REMINDER_HOURS', '24,2', 'Reminder emails, hours before the appointment (comma-separated, empty = off)'],
  ['SEND_EMAILS', 'TRUE', 'Send confirmation / reschedule / cancel / reminder emails'],
  ['NOTIFY_DOCTOR', 'TRUE', 'Email the doctor when a booking is assigned to them'],
  ['MAX_UPLOAD_MB', '5', 'Max size per lab-result file (PDF/JPG/PNG)'],
  ['UPSELL_SERVICES', 'Lab Test:250, IV Therapy:350, Follow-up Consultation:0, Doctor Home Visit:400, Physiotherapy:300, Nurse Visit:200', 'Service:price list for the upsell picker'],
  ['SUPPORT_EMAIL', 'healthcare@justlife.com', 'Shown to clients'],
  ['SUPPORT_PHONE', '+971 4 000 0000', 'Shown to clients'],
];

var ACTIVE = ['SCHEDULED', 'CALLING', 'COMPLETED', 'NO_SHOW']; // statuses that occupy a slot
var DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
var UPSELL_STATUSES = ['RECOMMENDED', 'INTERESTED', 'BOOKED', 'COMPLETED', 'NOT_INTERESTED'];

// =============================================================================
// Sheet helpers
// =============================================================================
var _ss = null;
function ss_() {
  if (!_ss) _ss = SHEET_URL ? SpreadsheetApp.openByUrl(SHEET_URL) : SpreadsheetApp.getActiveSpreadsheet();
  if (!_ss) throw new Error('No spreadsheet: open this script from the sheet, or set SHEET_URL at the top of Code.gs.');
  return _ss;
}

function sheet_(name) {
  var sh = ss_().getSheetByName(name);
  if (!sh) {
    sh = ss_().insertSheet(name);
    var head = TABS[name];
    sh.getRange(1, 1, 1, head.length).setValues([head]).setFontWeight('bold').setBackground('#e3f7ff');
    sh.setFrozenRows(1);
  }
  return sh;
}

/** All rows of a tab as objects ({_row} = sheet row number). */
function read_(name) {
  var sh = sheet_(name);
  var last = sh.getLastRow();
  var head = TABS[name];
  if (last < 2) return [];
  var width = Math.max(sh.getLastColumn(), head.length);
  var values = sh.getRange(1, 1, last, width).getDisplayValues();
  var cols = values[0];
  var out = [];
  for (var i = 1; i < values.length; i++) {
    var r = values[i];
    if (!r.join('')) continue;
    var o = { _row: i + 1 };
    for (var j = 0; j < head.length; j++) {
      var c = cols.indexOf(head[j]);
      o[head[j]] = c >= 0 ? r[c] : '';
    }
    out.push(o);
  }
  return out;
}

/** Values are written as plain text so phones (+971…), dates and IDs stay exact and nothing runs as a formula. */
function textify_(v) {
  if (v === null || v === undefined) return '';
  var s = String(v);
  return /^[=+\-@]/.test(s) && !/^[+\-]?\d/.test(s) ? "'" + s : s;
}

function colIndex_(name) {
  var sh = sheet_(name);
  var cols = sh.getRange(1, 1, 1, Math.max(1, sh.getLastColumn())).getDisplayValues()[0];
  var missing = TABS[name].filter(function (h) { return cols.indexOf(h) < 0; });
  if (missing.length) { // repair header row if someone removed a column
    sh.getRange(1, cols.length + 1, 1, missing.length).setValues([missing]).setFontWeight('bold');
    cols = cols.concat(missing);
  }
  return cols;
}

function append_(name, obj) {
  var sh = sheet_(name);
  var cols = colIndex_(name);
  var row = cols.map(function (c) { return textify_(obj[c]); });
  var r = sh.getLastRow() + 1;
  sh.getRange(r, 1, 1, row.length).setNumberFormat('@').setValues([row]);
  obj._row = r;
  return obj;
}

function update_(name, rowObj, patch) {
  var sh = sheet_(name);
  var cols = colIndex_(name);
  if ('updatedAt' in rowObj || TABS[name].indexOf('updatedAt') >= 0) patch.updatedAt = nowIso_();
  Object.keys(patch).forEach(function (k) {
    var c = cols.indexOf(k);
    if (c < 0) return;
    sh.getRange(rowObj._row, c + 1).setNumberFormat('@').setValue(textify_(patch[k]));
    rowObj[k] = patch[k] === null || patch[k] === undefined ? '' : String(patch[k]);
  });
  return rowObj;
}

function deleteRow_(name, rowObj) { sheet_(name).deleteRow(rowObj._row); }

function settings_() {
  var s = {};
  DEFAULT_SETTINGS.forEach(function (d) { s[d[0]] = d[1]; });
  read_('Settings').forEach(function (r) { if (r.key) s[r.key.trim()] = String(r.value).trim(); });
  return s;
}
function num_(s, key) { var n = Number(s[key]); return isFinite(n) ? n : Number(DEFAULT_SETTINGS.filter(function (d) { return d[0] === key; })[0][1]); }
function bool_(s, key) { return /^(true|yes|1)$/i.test(String(s[key])); }

function lock_() {
  var l = LockService.getScriptLock();
  if (!l.tryLock(20000)) throw fail_('The system is busy. Please try again in a moment.', 'BUSY');
  return l;
}

function log_(user, action, appointmentNo, details) {
  try {
    append_('Log', { time: nowIso_(), user: user || 'client', action: action, appointmentNo: appointmentNo || '', details: typeof details === 'string' ? details : JSON.stringify(details || '') });
  } catch (e) { /* never break the action because of logging */ }
}

// =============================================================================
// Time helpers (Dubai = UTC+4, no DST)
// =============================================================================
function nowIso_() { return new Date().toISOString(); }
function todayKey_() { return Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd'); }
function at_(dateKey, hhmm) { return new Date(dateKey + 'T' + hhmm + ':00' + TZ_OFFSET); }
function addDays_(key, n) { var d = new Date(key + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
function dow_(key) { return new Date(key + 'T12:00:00Z').getUTCDay(); }
function mins_(hhmm) { var p = String(hhmm).split(':'); return Number(p[0]) * 60 + Number(p[1] || 0); }
function hhmm_(m) { return ('0' + Math.floor(m / 60)).slice(-2) + ':' + ('0' + (m % 60)).slice(-2); }
function isKey_(k) { return /^\d{4}-\d{2}-\d{2}$/.test(String(k)); }
function isClock_(t) { return /^([01]\d|2[0-3]):[0-5]\d$/.test(String(t)); }

/** "09:00-13:00, 16:00-20:00" → [{start:540,end:780},…] */
function periods_(text) {
  return String(text || '').split(/[,;]+/).map(function (p) {
    var m = p.trim().match(/^(\d{1,2})[:.](\d{2})\s*[-–]\s*(\d{1,2})[:.](\d{2})$/);
    if (!m) return null;
    var a = Number(m[1]) * 60 + Number(m[2]);
    var b = Number(m[3]) * 60 + Number(m[4]);
    return b > a ? { start: a, end: b } : null;
  }).filter(Boolean).sort(function (x, y) { return x.start - y.start; });
}

// =============================================================================
// Availability
// =============================================================================
function onLeave_(leaves, doctorId, key) {
  return leaves.some(function (l) { return l.doctorId === doctorId && l.from <= key && (l.to || l.from) >= key; });
}

/**
 * Free slot start times ('HH:mm') for one doctor on one date.
 * opts.excludeId: appointment that may be moved within its own slot.
 * opts.admin: staff booking — notice/horizon rules relaxed.
 */
function freeSlots_(doctor, key, ctx, opts) {
  opts = opts || {};
  var s = ctx.settings;
  var dur = num_(s, 'SLOT_MINUTES');
  if (doctor.status !== 'ACTIVE') return [];
  if (onLeave_(ctx.leaves, doctor.id, key)) return [];
  var now = Date.now();
  var earliest = opts.admin ? now - (dur - 5) * 60000 : now + num_(s, 'MIN_NOTICE_MINUTES') * 60000;
  var horizon = addDays_(todayKey_(), (opts.admin ? 120 : num_(s, 'BOOKING_HORIZON_DAYS')) - 1);
  if (key > horizon) return [];
  var busy = ctx.appointments.filter(function (a) {
    return a.doctorId === doctor.id && a.date === key && ACTIVE.indexOf(a.status) >= 0 && a.id !== opts.excludeId;
  }).map(function (a) { return { start: mins_(a.start), end: mins_(a.end) }; });
  var out = [];
  periods_(doctor[DAYS[dow_(key)]]).forEach(function (p) {
    for (var m = p.start; m + dur <= p.end; m += dur) {
      if (at_(key, hhmm_(m)).getTime() < earliest) continue;
      var clash = busy.some(function (b) { return m < b.end && m + dur > b.start; });
      if (!clash) out.push(hhmm_(m));
    }
  });
  return out;
}

function context_() {
  return { settings: settings_(), doctors: read_('Doctors'), leaves: read_('Leaves'), appointments: read_('Appointments') };
}

function sortDoctors_(list) {
  return list.slice().sort(function (a, b) { return (Number(a.sortOrder) || 0) - (Number(b.sortOrder) || 0) || a.name.localeCompare(b.name); });
}

function publicDoctor_(d) {
  return { id: d.id, name: d.name, specialty: d.specialty, languages: d.languages, experienceYears: d.experienceYears, bio: d.bio, photoUrl: d.photoUrl };
}

// =============================================================================
// Public (client) API
// =============================================================================
function linkState_(link, s) {
  if (!link) return { ok: false, message: 'This booking link is not valid. Please contact Justlife Healthcare for a new link.' };
  if (link.status === 'CANCELLED') return { ok: false, message: 'This booking link is no longer active. Please contact Justlife Healthcare.' };
  if (link.expiresOn && link.expiresOn < todayKey_()) return { ok: false, message: 'This booking link has expired. Please contact Justlife Healthcare for a new link.' };
  if (bool_(link, 'singleUse') && Number(link.uses) > 0) return { ok: false, message: 'This booking link has already been used. Please contact Justlife Healthcare if you need another appointment.' };
  return { ok: true };
}

function findLink_(token) {
  if (!token) return null;
  return read_('Links').filter(function (l) { return l.token === token; })[0] || null;
}

function publicSettings_(s) {
  return {
    appName: s.APP_NAME, authMode: s.AUTH_MODE === 'test' ? 'test' : 'google', allowedDomain: s.ALLOWED_DOMAIN,
    slotMinutes: num_(s, 'SLOT_MINUTES'), horizonDays: num_(s, 'BOOKING_HORIZON_DAYS'), maxUploadMb: num_(s, 'MAX_UPLOAD_MB'),
    allowCancel: bool_(s, 'ALLOW_CLIENT_CANCEL'), cutoffHours: num_(s, 'RESCHEDULE_CUTOFF_HOURS'),
    supportEmail: s.SUPPORT_EMAIL, supportPhone: s.SUPPORT_PHONE, publicBooking: bool_(s, 'PUBLIC_BOOKING'),
  };
}

var PUBLIC = {
  /** Settings + doctors for the booking page. */
  init: function (p) {
    var s = settings_();
    var out = { settings: publicSettings_(s), today: todayKey_() };
    if (p.r) {
      out.mode = 'reschedule';
    } else if (p.t) {
      var st = linkState_(findLink_(p.t), s);
      out.link = st.ok ? { ok: true, bookingRef: findLink_(p.t).bookingRef } : st;
    } else {
      out.link = bool_(s, 'PUBLIC_BOOKING') ? { ok: true, bookingRef: '' } : { ok: false, message: 'Please use the booking link sent to you by Justlife Healthcare.' };
    }
    out.doctors = sortDoctors_(read_('Doctors').filter(function (d) { return d.status === 'ACTIVE'; })).map(publicDoctor_);
    return out;
  },

  /** Free slots: { days: { 'YYYY-MM-DD': ['09:00', …] } } for one doctor (or all when doctorId empty). */
  availability: function (p) {
    var ctx = context_();
    var excludeId = '';
    if (p.r) { var own = byToken_(ctx.appointments, p.r); if (own) excludeId = own.id; }
    var from = isKey_(p.from) && p.from > todayKey_() ? p.from : todayKey_();
    var days = Math.min(Number(p.days) || num_(ctx.settings, 'BOOKING_HORIZON_DAYS'), 60);
    var docs = ctx.doctors.filter(function (d) { return d.status === 'ACTIVE' && (!p.doctorId || d.id === p.doctorId); });
    var out = {};
    docs.forEach(function (d) {
      var map = {};
      for (var i = 0; i < days; i++) {
        var k = addDays_(from, i);
        var slots = freeSlots_(d, k, ctx, { excludeId: excludeId });
        if (slots.length) map[k] = slots;
      }
      out[d.id] = map;
    });
    return { doctors: out };
  },

  /** Create a booking. Runs under a lock: two clients can never get the same slot. */
  book: function (p) {
    var c = validateClient_(p.client || {});
    if (!isKey_(p.date) || !isClock_(p.start)) throw fail_('Please choose a date and time.');
    var s0 = settings_();
    var files = saveFiles_(p.files, s0, c.name); // outside the lock (Drive is slow)
    var lock = lock_();
    var appt;
    try {
      var ctx = context_();
      var link = null;
      if (p.t) {
        link = findLink_(p.t);
        var st = linkState_(link, ctx.settings);
        if (!st.ok) throw fail_(st.message, 'LINK');
      } else if (!bool_(ctx.settings, 'PUBLIC_BOOKING')) {
        throw fail_('Please use the booking link sent to you by Justlife Healthcare.', 'LINK');
      }
      var doctor = ctx.doctors.filter(function (d) { return d.id === p.doctorId; })[0];
      if (!doctor || doctor.status !== 'ACTIVE') throw fail_('This doctor is currently unavailable. Please choose another doctor.', 'UNAVAILABLE');
      if (freeSlots_(doctor, p.date, ctx).indexOf(p.start) < 0) {
        throw fail_('Sorry, this time slot has just been booked by another client. Please select another available time.', 'SLOT_TAKEN');
      }
      appt = createAppointment_(ctx, doctor, p.date, p.start, c, {
        source: link ? 'CLIENT_LINK' : 'WEBSITE', linkToken: link ? link.token : '', files: files, createdBy: 'client',
      });
      if (link) update_('Links', link, { uses: (Number(link.uses) || 0) + 1 });
      log_('client:' + c.email, 'BOOKING_CREATED', appt.appointmentNo, appt.doctorName + ' ' + appt.date + ' ' + appt.start);
    } catch (e) {
      trashFiles_(files);
      throw e;
    } finally { lock.releaseLock(); }
    notify_('CONFIRMED', appt);
    return { appointment: clientView_(appt), rescheduleToken: appt.rescheduleToken };
  },

  /** Appointment behind a reschedule link. */
  lookup: function (p) {
    var s = settings_();
    var a = byToken_(read_('Appointments'), p.r);
    if (!a) throw fail_('This link is not valid or the appointment is no longer active.', 'INVALID');
    var e = selfService_(a, s);
    return { appointment: clientView_(a), canReschedule: e.reschedule, canCancel: e.cancel, reason: e.reason, settings: publicSettings_(s) };
  },

  reschedule: function (p) {
    if (!isKey_(p.date) || !isClock_(p.start)) throw fail_('Please choose a date and time.');
    var lock = lock_();
    var next;
    var old;
    try {
      var ctx = context_();
      old = byToken_(ctx.appointments, p.r);
      if (!old) throw fail_('This link is not valid or the appointment is no longer active.', 'INVALID');
      var e = selfService_(old, ctx.settings);
      if (!e.reschedule) throw fail_(e.reason || 'This appointment can no longer be rescheduled online. Please contact Justlife Healthcare.', 'CLOSED');
      var doctor = ctx.doctors.filter(function (d) { return d.id === (p.doctorId || old.doctorId); })[0];
      if (!doctor || freeSlots_(doctor, p.date, ctx, { excludeId: old.id }).indexOf(p.start) < 0) {
        throw fail_('Sorry, this time slot has just been booked by another client. Please select another available time.', 'SLOT_TAKEN');
      }
      next = moveAppointment_(ctx, old, doctor, p.date, p.start, 'client', 'CLIENT_RESCHEDULE', p.reason);
    } finally { lock.releaseLock(); }
    notify_('RESCHEDULED', next, old);
    return { appointment: clientView_(next), rescheduleToken: next.rescheduleToken };
  },

  cancel: function (p) {
    var lock = lock_();
    var a;
    try {
      var s = settings_();
      a = byToken_(read_('Appointments'), p.r);
      if (!a) throw fail_('This link is not valid or the appointment is no longer active.', 'INVALID');
      var e = selfService_(a, s);
      if (!e.cancel) throw fail_(e.reason || 'This appointment can no longer be cancelled online. Please contact Justlife Healthcare.', 'CLOSED');
      update_('Appointments', a, { status: 'CANCELLED', cancelReason: String(p.reason || 'Cancelled by client').slice(0, 300) });
      log_('client:' + a.clientEmail, 'CLIENT_CANCELLED', a.appointmentNo, p.reason || '');
    } finally { lock.releaseLock(); }
    notify_('CANCELLED', a);
    return { ok: true };
  },
};

function byToken_(appointments, token) {
  if (!token || String(token).length < 10) return null;
  return appointments.filter(function (a) { return a.rescheduleToken === token; })[0] || null;
}

function selfService_(a, s) {
  if (a.status !== 'SCHEDULED') return { reschedule: false, cancel: false, reason: a.status === 'CANCELLED' ? 'This appointment has been cancelled.' : 'This appointment can no longer be changed online.' };
  var hoursLeft = (at_(a.date, a.start).getTime() - Date.now()) / 3600000;
  if (hoursLeft < num_(s, 'RESCHEDULE_CUTOFF_HOURS')) {
    return { reschedule: false, cancel: false, reason: 'This appointment can no longer be changed online. Please contact Justlife Healthcare: ' + s.SUPPORT_PHONE };
  }
  return {
    reschedule: Number(a.rescheduleCount || 0) < num_(s, 'MAX_RESCHEDULES'),
    cancel: bool_(s, 'ALLOW_CLIENT_CANCEL'),
    reason: Number(a.rescheduleCount || 0) < num_(s, 'MAX_RESCHEDULES') ? '' : 'The maximum number of online reschedules has been reached. Please contact Justlife Healthcare.',
  };
}

function clientView_(a) {
  return {
    appointmentNo: a.appointmentNo, status: a.status, date: a.date, start: a.start, end: a.end,
    doctorName: a.doctorName, doctorId: a.doctorId, contactMethod: a.contactMethod, bookingRef: a.bookingRef,
    clientFirstName: String(a.clientName).split(' ')[0], email: a.clientEmail, rescheduleCount: Number(a.rescheduleCount || 0),
    files: parseFiles_(a.files).length,
  };
}

function validateClient_(c) {
  var name = String(c.name || '').trim().slice(0, 100);
  var email = String(c.email || '').trim().toLowerCase().slice(0, 150);
  var mobile = String(c.mobile || '').replace(/[^\d+]/g, '');
  if (name.length < 2) throw fail_('Please enter your full name.', 'VALIDATION');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) throw fail_('Please enter a valid email address.', 'VALIDATION');
  if (!/^\+?\d{7,15}$/.test(mobile)) throw fail_('Please enter a valid mobile number, e.g. +971 50 123 4567.', 'VALIDATION');
  if (/^05\d{8}$/.test(mobile)) mobile = '+971' + mobile.slice(1);
  var method = c.contactMethod === 'PHONE' ? 'PHONE' : 'WHATSAPP';
  return {
    name: name, email: email, mobile: mobile, contactMethod: method,
    bookingRef: String(c.bookingRef || '').trim().slice(0, 40), notes: String(c.notes || '').trim().slice(0, 1000),
  };
}

function newId_() { return Utilities.getUuid(); }
function token_(n) {
  var abc = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  var bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, Utilities.getUuid() + Utilities.getUuid() + Date.now());
  var out = '';
  for (var i = 0; i < (n || 12); i++) out += abc[(bytes[i] + 256) % abc.length];
  return out;
}

function createAppointment_(ctx, doctor, date, start, c, extra) {
  var used = {};
  ctx.appointments.forEach(function (a) { used[a.appointmentNo] = 1; });
  var no;
  do { no = 'JLTC-' + (100000 + Math.floor(Math.random() * 900000)); } while (used[no]);
  var dur = num_(ctx.settings, 'SLOT_MINUTES');
  var a = {
    id: newId_(), appointmentNo: no, status: 'SCHEDULED', date: date, start: start, end: hhmm_(mins_(start) + dur),
    doctorId: doctor.id, doctorName: doctor.name, clientName: c.name, clientEmail: c.email, clientMobile: c.mobile,
    bookingRef: c.bookingRef, contactMethod: c.contactMethod, clientNotes: c.notes, files: JSON.stringify(extra.files || []),
    source: extra.source, linkToken: extra.linkToken || '', rescheduleToken: token_(16), rescheduledFrom: '', rescheduleCount: 0,
    adminNotes: extra.adminNotes || '', remindersSent: '', createdBy: extra.createdBy, createdAt: nowIso_(), updatedAt: nowIso_(),
  };
  append_('Appointments', a);
  ctx.appointments.push(a);
  return a;
}

/** Reschedule = old row → RESCHEDULED, new row → SCHEDULED (history is kept). */
function moveAppointment_(ctx, old, doctor, date, start, by, source, reason) {
  var n = Number(old.rescheduleCount || 0) + 1;
  var dur = num_(ctx.settings, 'SLOT_MINUTES');
  var next = {
    id: newId_(), appointmentNo: old.appointmentNo.replace(/-R\d+$/, '') + '-R' + n, status: 'SCHEDULED', date: date, start: start,
    end: hhmm_(mins_(start) + dur), doctorId: doctor.id, doctorName: doctor.name, clientName: old.clientName, clientEmail: old.clientEmail,
    clientMobile: old.clientMobile, bookingRef: old.bookingRef, contactMethod: old.contactMethod, clientNotes: old.clientNotes,
    files: old.files, source: source, linkToken: old.linkToken, rescheduleToken: old.rescheduleToken, rescheduledFrom: old.id,
    rescheduleCount: n, adminNotes: old.adminNotes, remindersSent: '', createdBy: by, createdAt: nowIso_(), updatedAt: nowIso_(),
  };
  update_('Appointments', old, { status: 'RESCHEDULED', rescheduleToken: '', cancelReason: reason ? 'Rescheduled: ' + String(reason).slice(0, 200) : '' });
  append_('Appointments', next);
  ctx.appointments.push(next);
  log_(by, 'RESCHEDULED', next.appointmentNo, old.doctorName + ' ' + old.date + ' ' + old.start + ' → ' + next.doctorName + ' ' + date + ' ' + start + (reason ? ' (' + reason + ')' : ''));
  return next;
}

// =============================================================================
// Files (lab results) — private Drive folder owned by the script owner
// =============================================================================
function folder_() {
  var p = PropertiesService.getScriptProperties();
  var id = p.getProperty('DRIVE_FOLDER_ID');
  if (id) { try { return DriveApp.getFolderById(id); } catch (e) { /* recreate */ } }
  var f = DriveApp.createFolder('Justlife Teleconsultation — Lab results (private)');
  p.setProperty('DRIVE_FOLDER_ID', f.getId());
  return f;
}

var MIME_OK = { 'application/pdf': '%PDF', 'image/jpeg': 'ÿØÿ', 'image/png': '\u0089PNG' };

function saveFiles_(files, s, clientName) {
  if (!files || !files.length) return [];
  if (files.length > 5) throw fail_('You can upload up to 5 files.', 'UPLOAD');
  var max = num_(s, 'MAX_UPLOAD_MB') * 1024 * 1024;
  var saved = [];
  try {
    files.forEach(function (f) {
      var bytes = Utilities.base64Decode(String(f.base64 || ''));
      if (!bytes.length || bytes.length > max) throw fail_('Each file must be ' + num_(s, 'MAX_UPLOAD_MB') + ' MB or smaller.', 'UPLOAD');
      var head = bytes.slice(0, 4).map(function (b) { return String.fromCharCode((b + 256) % 256); }).join('');
      var mime = Object.keys(MIME_OK).filter(function (m) { return head.indexOf(MIME_OK[m]) === 0; })[0];
      if (!mime) throw fail_("We couldn't upload your file. Only PDF, JPG and PNG files are accepted.", 'UPLOAD');
      var name = String(f.name || 'file').replace(/[^\w.\- ()]/g, '_').slice(-80);
      var file = folder_().createFile(Utilities.newBlob(bytes, mime, clientName.replace(/[^\w ]/g, '') + ' — ' + name));
      saved.push({ id: file.getId(), name: name, type: mime, size: bytes.length });
    });
  } catch (e) { trashFiles_(saved); throw e; }
  return saved;
}

function trashFiles_(list) { (list || []).forEach(function (f) { try { DriveApp.getFileById(f.id).setTrashed(true); } catch (e) { /* ignore */ } }); }
function parseFiles_(s) { try { var a = JSON.parse(s || '[]'); return Array.isArray(a) ? a : []; } catch (e) { return []; } }

// =============================================================================
// Staff authentication — Google sign-in, @ALLOWED_DOMAIN only
// =============================================================================
function authenticate_(auth, s) {
  if (!auth) throw fail_('Please sign in.', 'AUTH');
  var domain = String(s.ALLOWED_DOMAIN || 'justlife.com').toLowerCase().replace(/^@/, '');
  var email;
  var name;
  if (s.AUTH_MODE === 'test') {
    if (auth.mode !== 'test') throw fail_('Test sign-in is enabled: sign in with email + test password.', 'AUTH');
    if (String(s.TEST_PASSWORD).length < 8) throw fail_('Set TEST_PASSWORD (min 8 characters) in the Settings tab.', 'AUTH');
    if (String(auth.password) !== String(s.TEST_PASSWORD)) throw fail_('Wrong email or test password.', 'AUTH');
    email = String(auth.email || '').trim().toLowerCase();
    name = email.split('@')[0];
  } else {
    var info = verifyIdToken_(String(auth.idToken || ''), s);
    email = info.email; name = info.name;
  }
  if (!/^[^@\s]+@[^@\s]+$/.test(email) || email.split('@')[1] !== domain) {
    throw fail_('Access restricted to authorized Justlife accounts (@' + domain + ').', 'DOMAIN');
  }
  var admins = String(s.ADMIN_EMAILS || '').toLowerCase().split(/[,\s]+/).filter(Boolean);
  var doctor = read_('Doctors').filter(function (d) { return d.status === 'ACTIVE' && String(d.email).trim().toLowerCase() === email; })[0];
  var role;
  if (admins.indexOf(email) >= 0) role = 'ADMIN';
  else if (doctor) role = 'DOCTOR';
  else if (!admins.length) role = 'ADMIN';
  else throw fail_('Your account (' + email + ') has no access yet. Ask an admin to add you to ADMIN_EMAILS or as a doctor.', 'FORBIDDEN');
  return { email: email, name: role === 'DOCTOR' ? doctor.name : name, role: role, doctorId: role === 'DOCTOR' ? doctor.id : '' };
}

/** Verifies a Google ID token (from Google Identity Services) and caches the result. */
function verifyIdToken_(idToken, s) {
  if (idToken.split('.').length !== 3) throw fail_('Please sign in again.', 'AUTH');
  var cache = CacheService.getScriptCache();
  var key = 'idt_' + Utilities.base64EncodeWebSafe(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, idToken)).slice(0, 43);
  var hit = cache.get(key);
  if (hit) return JSON.parse(hit);
  var res = UrlFetchApp.fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(idToken), { muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) throw fail_('Your sign-in has expired. Please sign in again.', 'AUTH');
  var p = JSON.parse(res.getContentText());
  if (!s.GOOGLE_CLIENT_ID) throw fail_('GOOGLE_CLIENT_ID is empty in the Settings tab of the sheet.', 'CONFIG');
  if (p.aud !== s.GOOGLE_CLIENT_ID) throw fail_('GOOGLE_CLIENT_ID in config.js and in the Settings tab must be identical.', 'CONFIG');
  if (String(p.email_verified) !== 'true') throw fail_('Your Google email is not verified.', 'AUTH');
  if (Number(p.exp) * 1000 < Date.now()) throw fail_('Your sign-in has expired. Please sign in again.', 'AUTH');
  var out = { email: String(p.email).toLowerCase(), name: p.name || p.email, hd: p.hd || '' };
  var domain = String(s.ALLOWED_DOMAIN || 'justlife.com').toLowerCase().replace(/^@/, '');
  if (out.hd !== domain) throw fail_('Access restricted to authorized Justlife accounts (@' + domain + ').', 'DOMAIN');
  cache.put(key, JSON.stringify(out), Math.max(60, Math.min(3000, Math.floor(Number(p.exp) - Date.now() / 1000))));
  return out;
}

// =============================================================================
// Staff API (admins and doctors)
// =============================================================================
function requireAdmin_(u) { if (u.role !== 'ADMIN') throw fail_('You do not have permission to do this.', 'FORBIDDEN'); }

function apptForUser_(id, u) {
  var a = read_('Appointments').filter(function (x) { return x.id === id; })[0];
  if (!a || (u.role === 'DOCTOR' && a.doctorId !== u.doctorId)) throw fail_('Appointment not found.', 'NOT_FOUND');
  return a;
}

function upsellServices_(s) {
  return String(s.UPSELL_SERVICES || '').split(',').map(function (x) {
    var p = x.split(':');
    return p[0].trim() ? { name: p[0].trim(), amount: Number(p[1]) || 0 } : null;
  }).filter(Boolean);
}

var STAFF = {
  me: function (p, u) {
    var s = settings_();
    return {
      user: u, settings: publicSettings_(s), upsellServices: upsellServices_(s), today: todayKey_(),
      toleranceMinutes: num_(s, 'ON_TIME_TOLERANCE_MINUTES'),
      doctors: sortDoctors_(read_('Doctors')).map(function (d) { return { id: d.id, name: d.name, status: d.status, specialty: d.specialty }; }),
    };
  },

  /** Appointments list with filters. Doctors only ever get their own. */
  appointments: function (p, u) {
    var from = isKey_(p.from) ? p.from : '0000';
    var to = isKey_(p.to) ? p.to : '9999';
    var q = String(p.q || '').trim().toLowerCase();
    var statuses = p.status ? String(p.status).split(',') : null;
    var rows = read_('Appointments').filter(function (a) {
      if (u.role === 'DOCTOR' && a.doctorId !== u.doctorId) return false;
      if (u.role === 'DOCTOR' && a.status === 'RESCHEDULED') return false;
      if (a.date < from || a.date > to) return false;
      if (statuses && statuses.indexOf(a.status) < 0) return false;
      if (p.doctorId && a.doctorId !== p.doctorId) return false;
      if (q && [a.appointmentNo, a.clientName, a.clientEmail, a.clientMobile, a.bookingRef, a.doctorName].join(' ').toLowerCase().indexOf(q) < 0) return false;
      return true;
    });
    rows.sort(function (a, b) { var x = (a.date + a.start).localeCompare(b.date + b.start); return p.desc ? -x : x; });
    return { rows: rows.slice(0, 500).map(function (a) { return listView_(a); }), total: rows.length };
  },

  appointment: function (p, u) {
    var a = apptForUser_(p.id, u);
    var all = read_('Appointments');
    var history = [];
    var cur = a;
    for (var g = 0; cur && cur.rescheduledFrom && g < 20; g++) {
      cur = all.filter(function (x) { return x.id === cur.rescheduledFrom; })[0];
      if (cur) history.unshift(listView_(cur));
    }
    var later = all.filter(function (x) { return x.rescheduledFrom === a.id; }).map(listView_);
    var s = settings_();
    return {
      appointment: fullView_(a, u),
      upsells: read_('Upsells').filter(function (x) { return x.appointmentId === a.id; }).map(stripRow_),
      history: history, later: later,
      rescheduleUrl: u.role === 'ADMIN' && a.rescheduleToken ? siteLink_(s, 'r', a.rescheduleToken) : '',
      log: u.role === 'ADMIN' ? read_('Log').filter(function (l) { return l.appointmentNo && l.appointmentNo.replace(/-R\d+$/, '') === a.appointmentNo.replace(/-R\d+$/, ''); }).map(stripRow_).reverse().slice(0, 50) : [],
    };
  },

  startCall: function (p, u) {
    var lock = lock_();
    try {
      var a = apptForUser_(p.id, u);
      if (a.status === 'CALLING') return STAFF.appointment(p, u);
      if (a.status !== 'SCHEDULED') throw fail_('Only scheduled consultations can be started.', 'STATE');
      if (todayKey_() < a.date) throw fail_('This consultation can be started on ' + a.date + '.', 'STATE');
      var delay = Math.max(0, Math.round((Date.now() - at_(a.date, a.start).getTime()) / 60000));
      update_('Appointments', a, { status: 'CALLING', callStartedAt: nowIso_(), callDelayMin: delay });
      log_(u.email, 'CALL_STARTED', a.appointmentNo, delay ? delay + ' min after window start' : 'on time');
    } finally { lock.releaseLock(); }
    return STAFF.appointment(p, u);
  },

  saveNotes: function (p, u) {
    var lock = lock_();
    try {
      var a = apptForUser_(p.id, u);
      if (['CANCELLED', 'RESCHEDULED'].indexOf(a.status) >= 0) throw fail_('Notes cannot be added to a cancelled or rescheduled appointment.', 'STATE');
      update_('Appointments', a, notesPatch_(p.notes));
      log_(u.email, 'NOTES_UPDATED', a.appointmentNo, '');
    } finally { lock.releaseLock(); }
    return STAFF.appointment(p, u);
  },

  complete: function (p, u) {
    var lock = lock_();
    try {
      var a = apptForUser_(p.id, u);
      var allowed = u.role === 'ADMIN' ? ['SCHEDULED', 'CALLING', 'NO_SHOW'] : ['CALLING'];
      if (allowed.indexOf(a.status) < 0) throw fail_(a.status === 'SCHEDULED' ? 'Start the consultation before completing it.' : 'This consultation cannot be completed.', 'STATE');
      var n = notesPatch_(p.notes);
      if (!n.mainIssue || !n.assessment || !n.recommendation) throw fail_('Please complete Main issue, Assessment and Recommendation before completing the consultation.', 'VALIDATION');
      n.status = 'COMPLETED';
      n.callEndedAt = nowIso_();
      n.outcome = String(p.outcome || 'Consultation completed').slice(0, 200);
      update_('Appointments', a, n);
      log_(u.email, 'COMPLETED', a.appointmentNo, n.outcome);
    } finally { lock.releaseLock(); }
    return STAFF.appointment(p, u);
  },

  noShow: function (p, u) {
    var lock = lock_();
    try {
      var a = apptForUser_(p.id, u);
      if (['SCHEDULED', 'CALLING'].indexOf(a.status) < 0) throw fail_('Only scheduled consultations can be marked as no-show.', 'STATE');
      update_('Appointments', a, { status: 'NO_SHOW', outcome: String(p.outcome || 'Client did not answer').slice(0, 200), callEndedAt: a.callStartedAt ? nowIso_() : '' });
      log_(u.email, 'NO_SHOW', a.appointmentNo, '');
    } finally { lock.releaseLock(); }
    return STAFF.appointment(p, u);
  },

  getFile: function (p, u) {
    var a = apptForUser_(p.appointmentId, u);
    var f = parseFiles_(a.files).filter(function (x) { return x.id === p.fileId; })[0];
    if (!f) throw fail_('File not found.', 'NOT_FOUND');
    var blob = DriveApp.getFileById(f.id).getBlob();
    log_(u.email, 'FILE_VIEWED', a.appointmentNo, f.name);
    return { name: f.name, type: f.type, base64: Utilities.base64Encode(blob.getBytes()) };
  },

  // ---- upsells ----
  addUpsell: function (p, u) {
    var a = apptForUser_(p.id, u);
    var x = upsellInput_(p.upsell);
    var lock = lock_();
    try {
      append_('Upsells', {
        id: newId_(), appointmentId: a.id, appointmentNo: a.appointmentNo, doctorName: a.doctorName, service: x.service, status: x.status,
        recommendedAmount: x.recommendedAmount, bookedAmount: x.bookedAmount, bookingRef: x.bookingRef, createdBy: u.email, createdAt: nowIso_(), updatedAt: nowIso_(),
      });
      log_(u.email, 'UPSELL_ADDED', a.appointmentNo, x.service + ' — ' + x.status);
    } finally { lock.releaseLock(); }
    return STAFF.appointment(p, u);
  },
  updateUpsell: function (p, u) {
    var a = apptForUser_(p.id, u);
    var lock = lock_();
    try {
      var row = read_('Upsells').filter(function (x) { return x.id === p.upsellId && x.appointmentId === a.id; })[0];
      if (!row) throw fail_('Upsell not found.', 'NOT_FOUND');
      var x = upsellInput_(Object.assign({}, stripRow_(row), p.upsell));
      update_('Upsells', row, { service: x.service, status: x.status, recommendedAmount: x.recommendedAmount, bookedAmount: x.bookedAmount, bookingRef: x.bookingRef });
      log_(u.email, 'UPSELL_UPDATED', a.appointmentNo, x.service + ' → ' + x.status);
    } finally { lock.releaseLock(); }
    return STAFF.appointment(p, u);
  },
  deleteUpsell: function (p, u) {
    var a = apptForUser_(p.id, u);
    var lock = lock_();
    try {
      var row = read_('Upsells').filter(function (x) { return x.id === p.upsellId && x.appointmentId === a.id; })[0];
      if (!row) throw fail_('Upsell not found.', 'NOT_FOUND');
      deleteRow_('Upsells', row);
      log_(u.email, 'UPSELL_DELETED', a.appointmentNo, row.service);
    } finally { lock.releaseLock(); }
    return STAFF.appointment(p, u);
  },

  // ---- admin: bookings ----
  adminSlots: function (p, u) {
    requireAdmin_(u);
    var ctx = context_();
    var d = ctx.doctors.filter(function (x) { return x.id === p.doctorId; })[0];
    if (!d || !isKey_(p.date)) return { slots: [] };
    return { slots: freeSlots_(d, p.date, ctx, { admin: true, excludeId: p.excludeId }) };
  },
  adminBook: function (p, u) {
    requireAdmin_(u);
    var c = validateClient_(p.client || {});
    var lock = lock_();
    var appt;
    try {
      var ctx = context_();
      var d = ctx.doctors.filter(function (x) { return x.id === p.doctorId; })[0];
      if (!d || freeSlots_(d, p.date, ctx, { admin: true }).indexOf(p.start) < 0) throw fail_('This doctor is not available during the selected time.', 'SLOT_TAKEN');
      appt = createAppointment_(ctx, d, p.date, p.start, c, { source: 'ADMIN', createdBy: u.email, adminNotes: String(p.adminNotes || '').slice(0, 1000) });
      log_(u.email, 'BOOKING_CREATED', appt.appointmentNo, 'by admin');
    } finally { lock.releaseLock(); }
    notify_('CONFIRMED', appt);
    return { id: appt.id };
  },
  adminReschedule: function (p, u) {
    requireAdmin_(u);
    var lock = lock_();
    var next; var old;
    try {
      var ctx = context_();
      old = ctx.appointments.filter(function (x) { return x.id === p.id; })[0];
      if (!old || old.status !== 'SCHEDULED') throw fail_('Only scheduled appointments can be rescheduled.', 'STATE');
      var d = ctx.doctors.filter(function (x) { return x.id === p.doctorId; })[0];
      if (!d || freeSlots_(d, p.date, ctx, { admin: true, excludeId: old.id }).indexOf(p.start) < 0) throw fail_('This doctor is not available during the selected time.', 'SLOT_TAKEN');
      next = moveAppointment_(ctx, old, d, p.date, p.start, u.email, 'ADMIN_RESCHEDULE', p.reason);
    } finally { lock.releaseLock(); }
    notify_('RESCHEDULED', next, old);
    return { id: next.id };
  },
  adminCancel: function (p, u) {
    requireAdmin_(u);
    var lock = lock_(); var a;
    try {
      a = apptForUser_(p.id, u);
      if (['SCHEDULED', 'CALLING'].indexOf(a.status) < 0) throw fail_('Only scheduled appointments can be cancelled.', 'STATE');
      update_('Appointments', a, { status: 'CANCELLED', cancelReason: String(p.reason || 'Cancelled by Justlife').slice(0, 300) });
      log_(u.email, 'CANCELLED', a.appointmentNo, p.reason || '');
    } finally { lock.releaseLock(); }
    notify_('CANCELLED', a);
    return STAFF.appointment(p, u);
  },
  adminUpdate: function (p, u) {
    requireAdmin_(u);
    var lock = lock_();
    try {
      var a = apptForUser_(p.id, u);
      var patch = {};
      if (p.status) {
        var allowed = { SCHEDULED: ['COMPLETED', 'NO_SHOW'], CALLING: ['SCHEDULED', 'COMPLETED', 'NO_SHOW'], NO_SHOW: ['SCHEDULED', 'COMPLETED'], COMPLETED: ['NO_SHOW'] };
        if ((allowed[a.status] || []).indexOf(p.status) < 0) throw fail_('Cannot change status from ' + a.status + ' to ' + p.status + '.', 'STATE');
        patch.status = p.status;
      }
      if (p.adminNotes !== undefined) patch.adminNotes = String(p.adminNotes).slice(0, 2000);
      if (p.contactMethod === 'PHONE' || p.contactMethod === 'WHATSAPP') patch.contactMethod = p.contactMethod;
      if (p.bookingRef !== undefined) patch.bookingRef = String(p.bookingRef).slice(0, 40);
      update_('Appointments', a, patch);
      log_(u.email, 'UPDATED', a.appointmentNo, patch);
    } finally { lock.releaseLock(); }
    return STAFF.appointment(p, u);
  },

  // ---- admin: doctors ----
  doctors: function (p, u) {
    requireAdmin_(u);
    var leaves = read_('Leaves');
    var today = todayKey_();
    return {
      doctors: sortDoctors_(read_('Doctors')).map(function (d) {
        var x = stripRow_(d);
        x.leaves = leaves.filter(function (l) { return l.doctorId === d.id && (l.to || l.from) >= today; }).map(stripRow_);
        return x;
      }),
    };
  },
  saveDoctor: function (p, u) {
    requireAdmin_(u);
    var d = p.doctor || {};
    var name = String(d.name || '').trim();
    if (name.length < 3) throw fail_('Enter the doctor\'s name.', 'VALIDATION');
    var email = String(d.email || '').trim().toLowerCase();
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw fail_('Enter a valid email.', 'VALIDATION');
    DAYS.forEach(function (k) {
      var v = String(d[k] || '').trim();
      if (v && periods_(v).length !== v.split(/[,;]+/).filter(function (x) { return x.trim(); }).length) {
        throw fail_('Working hours for ' + k.toUpperCase() + ' must look like 09:00-13:00, 16:00-20:00', 'VALIDATION');
      }
    });
    var fields = {
      name: name, email: email, specialty: String(d.specialty || '').slice(0, 80), languages: String(d.languages || '').slice(0, 120),
      experienceYears: Number(d.experienceYears) || 0, bio: String(d.bio || '').slice(0, 800), phone: String(d.phone || '').slice(0, 30),
      whatsapp: String(d.whatsapp || '').slice(0, 30), photoUrl: /^https:\/\//.test(d.photoUrl || '') ? d.photoUrl : '',
      status: d.status === 'INACTIVE' ? 'INACTIVE' : 'ACTIVE', sortOrder: Number(d.sortOrder) || 0,
    };
    DAYS.forEach(function (k) { fields[k] = String(d[k] || '').trim(); });
    var lock = lock_();
    var id;
    try {
      var all = read_('Doctors');
      if (email && all.some(function (x) { return x.id !== d.id && String(x.email).toLowerCase() === email; })) throw fail_('Another doctor already uses this email.', 'DUPLICATE');
      var row = d.id ? all.filter(function (x) { return x.id === d.id; })[0] : null;
      if (row) { update_('Doctors', row, fields); id = row.id; }
      else { fields.id = newId_(); fields.createdAt = nowIso_(); append_('Doctors', fields); id = fields.id; }
      log_(u.email, row ? 'DOCTOR_UPDATED' : 'DOCTOR_CREATED', '', name);
    } finally { lock.releaseLock(); }
    // Bookings that no longer fit the new hours are reported back.
    var ctx = context_();
    var doc = ctx.doctors.filter(function (x) { return x.id === id; })[0];
    var conflicts = ctx.appointments.filter(function (a) {
      if (a.doctorId !== id || a.status !== 'SCHEDULED' || a.date < todayKey_()) return false;
      var s0 = mins_(a.start); var e0 = mins_(a.end);
      return doc.status !== 'ACTIVE' || !periods_(doc[DAYS[dow_(a.date)]]).some(function (pp) { return s0 >= pp.start && e0 <= pp.end; });
    }).map(listView_);
    return { id: id, conflicts: conflicts };
  },
  addLeave: function (p, u) {
    requireAdmin_(u);
    if (!isKey_(p.from)) throw fail_('Choose the first day of leave.', 'VALIDATION');
    var to = isKey_(p.to) && p.to >= p.from ? p.to : p.from;
    var d = read_('Doctors').filter(function (x) { return x.id === p.doctorId; })[0];
    if (!d) throw fail_('Doctor not found.', 'NOT_FOUND');
    var lock = lock_();
    try {
      append_('Leaves', { id: newId_(), doctorId: d.id, doctorName: d.name, from: p.from, to: to, reason: String(p.reason || '').slice(0, 200), createdBy: u.email, createdAt: nowIso_() });
      log_(u.email, 'LEAVE_ADDED', '', d.name + ' ' + p.from + '…' + to);
    } finally { lock.releaseLock(); }
    var conflicts = read_('Appointments').filter(function (a) { return a.doctorId === d.id && a.status === 'SCHEDULED' && a.date >= p.from && a.date <= to; }).map(listView_);
    return { conflicts: conflicts };
  },
  removeLeave: function (p, u) {
    requireAdmin_(u);
    var lock = lock_();
    try {
      var row = read_('Leaves').filter(function (l) { return l.id === p.leaveId; })[0];
      if (!row) throw fail_('Leave not found.', 'NOT_FOUND');
      deleteRow_('Leaves', row);
      log_(u.email, 'LEAVE_REMOVED', '', row.doctorName + ' ' + row.from);
    } finally { lock.releaseLock(); }
    return { ok: true };
  },

  // ---- admin: booking links ----
  links: function (p, u) {
    requireAdmin_(u);
    var s = settings_();
    var appts = read_('Appointments');
    return {
      links: read_('Links').reverse().slice(0, 300).map(function (l) {
        var x = stripRow_(l);
        var st = linkState_(l, s);
        x.liveStatus = l.status === 'CANCELLED' ? 'CANCELLED' : (st.ok ? 'ACTIVE' : (l.expiresOn && l.expiresOn < todayKey_() ? 'EXPIRED' : 'USED'));
        x.bookings = appts.filter(function (a) { return a.linkToken === l.token && !a.rescheduledFrom; }).map(function (a) { return a.appointmentNo; });
        return x;
      }),
    };
  },
  createLink: function (p, u) {
    requireAdmin_(u);
    if (p.expiresOn && !isKey_(p.expiresOn)) throw fail_('Choose a valid expiry date.', 'VALIDATION');
    var lock = lock_();
    var link;
    try {
      link = { token: token_(12), label: String(p.label || '').slice(0, 120), bookingRef: String(p.bookingRef || '').slice(0, 40), singleUse: p.singleUse === false ? 'FALSE' : 'TRUE', expiresOn: p.expiresOn || '', status: 'ACTIVE', uses: 0, createdBy: u.email, createdAt: nowIso_() };
      append_('Links', link);
      log_(u.email, 'LINK_CREATED', '', link.label || link.token);
    } finally { lock.releaseLock(); }
    return { token: link.token };
  },
  setLinkStatus: function (p, u) {
    requireAdmin_(u);
    var lock = lock_();
    try {
      var l = findLink_(p.token);
      if (!l) throw fail_('Link not found.', 'NOT_FOUND');
      update_('Links', l, { status: p.status === 'ACTIVE' ? 'ACTIVE' : 'CANCELLED' });
    } finally { lock.releaseLock(); }
    return { ok: true };
  },

  // ---- admin: dashboard ----
  dashboard: function (p, u) {
    requireAdmin_(u);
    var s = settings_();
    var tol = num_(s, 'ON_TIME_TOLERANCE_MINUTES');
    var from = isKey_(p.from) ? p.from : addDays_(todayKey_(), -29);
    var to = isKey_(p.to) ? p.to : todayKey_();
    var ups = {};
    read_('Upsells').forEach(function (x) { (ups[x.appointmentId] = ups[x.appointmentId] || []).push(x); });
    var per = {};
    var T = blank_('All doctors');
    var today = todayKey_();
    var live = { today: 0, upcoming: 0, inCall: 0 };
    read_('Appointments').forEach(function (a) {
      if (ACTIVE.indexOf(a.status) >= 0 && a.date === today) live.today++;
      if (a.status === 'SCHEDULED' && a.date >= today) live.upcoming++;
      if (a.status === 'CALLING') live.inCall++;
      if (a.date < from || a.date > to || a.status === 'RESCHEDULED') return;
      var d = per[a.doctorId] = per[a.doctorId] || blank_(a.doctorName);
      [d, T].forEach(function (x) {
        x.total++;
        if (a.status === 'COMPLETED') x.completed++;
        else if (a.status === 'CANCELLED') x.cancelled++;
        else if (a.status === 'NO_SHOW') x.noShow++;
        else x.scheduled++;
        if (a.callStartedAt) { x.calls++; x.delaySum += Number(a.callDelayMin) || 0; if ((Number(a.callDelayMin) || 0) <= tol) x.onTime++; }
        var list = ups[a.id] || [];
        x.upsells += list.length;
        var booked = list.filter(function (y) { return y.status === 'BOOKED' || y.status === 'COMPLETED'; });
        x.upsellsBooked += booked.length;
        x.gmv += booked.reduce(function (sum, y) { return sum + (Number(y.bookedAmount || y.recommendedAmount) || 0); }, 0);
        if (a.status === 'COMPLETED' && booked.length) x.convertedClients++;
      });
    });
    var fin = function (x) {
      var pct = function (n, d) { return d ? Math.round(n / d * 1000) / 10 : null; };
      x.completionPct = pct(x.completed, x.total); x.onTimePct = pct(x.onTime, x.calls); x.avgDelay = x.calls ? Math.round(x.delaySum / x.calls * 10) / 10 : null;
      x.upsellConversionPct = pct(x.upsellsBooked, x.upsells); x.clientConversionPct = pct(x.convertedClients, x.completed);
      x.cancelPct = pct(x.cancelled, x.total); x.noShowPct = pct(x.noShow, x.total);
      return x;
    };
    return {
      from: from, to: to, toleranceMinutes: tol, live: live, totals: fin(T),
      doctors: Object.keys(per).map(function (k) { return fin(per[k]); }).sort(function (a, b) { return b.total - a.total; }),
    };
  },
};

function blank_(name) {
  return { name: name, total: 0, completed: 0, cancelled: 0, noShow: 0, scheduled: 0, calls: 0, onTime: 0, delaySum: 0, upsells: 0, upsellsBooked: 0, gmv: 0, convertedClients: 0 };
}

function notesPatch_(n) {
  n = n || {};
  var out = {};
  ['mainIssue', 'assessment', 'recommendation', 'furtherTests', 'followUp'].forEach(function (k) { out[k] = String(n[k] || '').trim().slice(0, 3000); });
  return out;
}

function upsellInput_(x) {
  x = x || {};
  var service = String(x.service || '').trim().slice(0, 80);
  if (!service) throw fail_('Choose a service.', 'VALIDATION');
  var status = UPSELL_STATUSES.indexOf(x.status) >= 0 ? x.status : 'RECOMMENDED';
  var rec = Number(x.recommendedAmount) || 0;
  var booked = x.bookedAmount === '' || x.bookedAmount === null || x.bookedAmount === undefined ? '' : Number(x.bookedAmount) || 0;
  if (rec < 0 || booked < 0) throw fail_('Amounts cannot be negative.', 'VALIDATION');
  return { service: service, status: status, recommendedAmount: rec, bookedAmount: booked, bookingRef: String(x.bookingRef || '').slice(0, 40) };
}

function stripRow_(r) { var o = {}; Object.keys(r).forEach(function (k) { if (k !== '_row') o[k] = r[k]; }); return o; }

function listView_(a) {
  return {
    id: a.id, appointmentNo: a.appointmentNo, status: a.status, date: a.date, start: a.start, end: a.end, doctorId: a.doctorId,
    doctorName: a.doctorName, clientName: a.clientName, contactMethod: a.contactMethod, bookingRef: a.bookingRef, source: a.source,
    callDelayMin: a.callDelayMin, hasFiles: parseFiles_(a.files).length > 0,
  };
}

function fullView_(a, u) {
  var x = stripRow_(a);
  x.files = parseFiles_(a.files).map(function (f) { return { id: f.id, name: f.name, type: f.type, size: f.size }; });
  delete x.rescheduleToken; delete x.linkToken; delete x.remindersSent;
  if (u.role !== 'ADMIN') delete x.adminNotes;
  return x;
}

function siteLink_(s, key, token) {
  var base = String(s.SITE_URL || '').trim();
  if (!base) return '';
  if (!/\.html$/.test(base)) base = base.replace(/\/?$/, '/') + 'index.html';
  return base + '?' + key + '=' + encodeURIComponent(token);
}

// =============================================================================
// Emails (sent from the account that deployed the web app)
// =============================================================================
function esc_(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
function niceDate_(key) { return Utilities.formatDate(at_(key, '12:00'), TZ, 'EEEE, d MMMM yyyy'); }
function niceTime_(hhmm) { var m = mins_(hhmm); var h = Math.floor(m / 60); return ((h + 11) % 12 + 1) + ':' + ('0' + m % 60).slice(-2) + (h < 12 ? ' AM' : ' PM'); }

function notify_(type, a, prev) {
  try {
    var s = settings_();
    if (!bool_(s, 'SEND_EMAILS')) return;
    var link = a.rescheduleToken ? siteLink_(s, 'r', a.rescheduleToken) : '';
    var when = niceDate_(a.date) + ', ' + niceTime_(a.start) + ' – ' + niceTime_(a.end) + ' (Dubai time)';
    var how = a.contactMethod === 'PHONE' ? 'a phone call' : 'WhatsApp';
    var first = esc_(String(a.clientName).split(' ')[0]);
    var subject; var body;
    if (type === 'CONFIRMED') {
      subject = 'Your Justlife Teleconsultation is Confirmed — ' + a.appointmentNo;
      body = '<p>Hello ' + first + ',</p><p>Your teleconsultation has been booked.</p>';
    } else if (type === 'RESCHEDULED') {
      subject = 'Your Justlife Teleconsultation has been Rescheduled — ' + a.appointmentNo;
      body = '<p>Hello ' + first + ',</p><p>Your previous appointment' + (prev ? ' (' + esc_(niceDate_(prev.date) + ', ' + niceTime_(prev.start)) + ' with ' + esc_(prev.doctorName) + ')' : '') + ' has been rescheduled.</p>';
    } else if (type === 'CANCELLED') {
      subject = 'Your Justlife Teleconsultation has been Cancelled — ' + a.appointmentNo;
      body = '<p>Hello ' + first + ',</p><p>Your teleconsultation below has been cancelled. If this was a mistake, please contact us.</p>';
    } else if (type === 'REMINDER') {
      subject = 'Reminder: your Justlife Teleconsultation — ' + niceTime_(a.start);
      body = '<p>Hello ' + first + ',</p><p>This is a reminder of your upcoming teleconsultation.</p>';
    }
    body += '<table style="border-collapse:collapse;font-size:14px">' +
      row_('Doctor', a.doctorName) + row_('When', when) + row_('Contact', 'The doctor will reach you by ' + how + ' within this window') +
      row_('Appointment', a.appointmentNo) + (a.bookingRef ? row_('Justlife ref', a.bookingRef) : '') + '</table>' +
      (link && type !== 'CANCELLED' ? '<p><a href="' + esc_(link) + '">Reschedule or cancel your appointment</a></p>' : '') +
      '<p style="color:#64748b">Justlife Healthcare · ' + esc_(s.SUPPORT_EMAIL) + ' · ' + esc_(s.SUPPORT_PHONE) + '</p>';
    MailApp.sendEmail({ to: a.clientEmail, subject: subject, htmlBody: '<div style="font-family:Arial,sans-serif;color:#0f172a">' + body + '</div>', name: 'Justlife Healthcare', replyTo: s.SUPPORT_EMAIL });
    if ((type === 'CONFIRMED' || type === 'RESCHEDULED') && bool_(s, 'NOTIFY_DOCTOR')) {
      var doc = read_('Doctors').filter(function (d) { return d.id === a.doctorId; })[0];
      if (doc && doc.email) {
        MailApp.sendEmail({ to: doc.email, subject: 'New teleconsultation: ' + a.date + ' ' + a.start + ' — ' + a.appointmentNo,
          htmlBody: '<div style="font-family:Arial,sans-serif">' + '<p>A teleconsultation has been assigned to you.</p><table>' + row_('Client', a.clientName) + row_('When', when) + row_('Contact', a.contactMethod) + row_('Appointment', a.appointmentNo) + '</table>' +
            (s.SITE_URL ? '<p><a href="' + esc_(String(s.SITE_URL).replace(/index\.html$/, '').replace(/\/?$/, '/') + 'partner.html') + '">Open the staff portal</a></p>' : '') + '</div>' });
      }
    }
  } catch (e) {
    log_('system', 'EMAIL_FAILED', a && a.appointmentNo, String(e && e.message || e));
  }
}
function row_(k, v) { return '<tr><td style="padding:4px 12px 4px 0;color:#64748b">' + esc_(k) + '</td><td style="padding:4px 0"><b>' + esc_(v) + '</b></td></tr>'; }

/** Hourly trigger: sends reminder emails (each offset only once per appointment). */
function sendReminders() {
  var s = settings_();
  var hours = String(s.REMINDER_HOURS || '').split(',').map(Number).filter(function (h) { return h > 0; }).sort(function (a, b) { return b - a; });
  if (!hours.length) return 0;
  var lock = lock_();
  var due = [];
  try {
    var now = Date.now();
    read_('Appointments').forEach(function (a) {
      if (a.status !== 'SCHEDULED') return;
      var left = (at_(a.date, a.start).getTime() - now) / 3600000;
      if (left <= 0) return;
      var sent = String(a.remindersSent || '').split(',').filter(Boolean).map(Number);
      // the smallest offset that is due and not yet sent; skip longer ones that are already past
      var h = hours.filter(function (x) { return left <= x; }).sort(function (x, y) { return x - y; })[0];
      if (!h || sent.indexOf(h) >= 0) return;
      var created = new Date(a.createdAt).getTime();
      if ((at_(a.date, a.start).getTime() - created) / 3600000 < h + 0.25) { // booked inside the window: don't remind
        update_('Appointments', a, { remindersSent: sent.concat([h]).join(',') });
        return;
      }
      update_('Appointments', a, { remindersSent: sent.concat([h]).join(',') });
      due.push(a);
    });
  } finally { lock.releaseLock(); }
  due.forEach(function (a) { notify_('REMINDER', a); });
  if (due.length) log_('system', 'REMINDERS_SENT', '', due.length + ' reminder(s)');
  return due.length;
}

// =============================================================================
// Web app entry points
// =============================================================================
function fail_(message, code) { var e = new Error(message); e.code = code || 'ERROR'; e.expected = true; return e; }
function out_(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }

function doGet(e) {
  var p = (e && e.parameter) || {};
  if (p.action === 'ping') return out_({ ok: true, data: { app: 'Justlife Teleconsultation', time: nowIso_() } });
  return out_({ ok: true, data: 'Justlife Teleconsultation API is running. The website calls it with POST.' });
}

function doPost(e) {
  var req;
  try { req = JSON.parse((e && e.postData && e.postData.contents) || '{}'); } catch (err) { return out_({ ok: false, error: 'Bad request', code: 'BAD_REQUEST' }); }
  return out_(handle_(req));
}

/** Shared by doPost and the automated tests. */
function handle_(req) {
  try {
    var action = String(req.action || '');
    var p = req.data || {};
    if (PUBLIC.hasOwnProperty(action)) return { ok: true, data: PUBLIC[action](p) };
    if (STAFF.hasOwnProperty(action)) {
      var user = authenticate_(req.auth, settings_());
      return { ok: true, data: STAFF[action](p, user) };
    }
    return { ok: false, error: 'Unknown action', code: 'BAD_REQUEST' };
  } catch (err) {
    if (!err.expected) {
      try { log_('system', 'ERROR', '', String(err && err.stack || err).slice(0, 1000)); } catch (x) { /* ignore */ }
    }
    return { ok: false, error: err.expected ? err.message : 'Something went wrong. Please try again.', code: err.code || 'SERVER_ERROR' };
  }
}

// =============================================================================
// Menu, setup & triggers
// =============================================================================
function onOpen() {
  SpreadsheetApp.getUi().createMenu('Justlife')
    .addItem('Setup / repair tabs', 'setup')
    .addItem('Install reminder trigger (hourly)', 'installTriggers')
    .addItem('Send reminders now', 'sendReminders')
    .addSeparator()
    .addItem('Create a booking link', 'menuCreateLink')
    .addToUi();
}

/** Creates all tabs, headers and default settings. Safe to run again. */
function setup() {
  Object.keys(TABS).forEach(function (t) { sheet_(t); colIndex_(t); });
  var have = read_('Settings').map(function (r) { return r.key; });
  DEFAULT_SETTINGS.forEach(function (d) { if (have.indexOf(d[0]) < 0) append_('Settings', { key: d[0], value: d[1], description: d[2] }); });
  if (!read_('Doctors').length) {
    append_('Doctors', {
      id: newId_(), name: 'Dr. Sample Doctor', email: '', specialty: 'General Practitioner', languages: 'English, Arabic', experienceYears: 8,
      bio: 'Edit or delete this sample doctor in the staff portal (Doctors) or in this tab.', status: 'ACTIVE', sortOrder: 1,
      sun: '', mon: '09:00-17:00', tue: '09:00-17:00', wed: '09:00-17:00', thu: '09:00-17:00', fri: '09:00-13:00', sat: '', createdAt: nowIso_(),
    });
  }
  var first = ss_().getSheetByName('Sheet1');
  if (first && first.getLastRow() === 0 && ss_().getSheets().length > 1) ss_().deleteSheet(first);
  folder_();
  try { SpreadsheetApp.getUi().alert('Justlife setup done ✓\n\nNext: fill GOOGLE_CLIENT_ID and SITE_URL in the Settings tab, then Deploy → New deployment → Web app.'); } catch (e) { /* not in UI */ }
}

function installTriggers() {
  ScriptApp.getProjectTriggers().forEach(function (t) { if (t.getHandlerFunction() === 'sendReminders') ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('sendReminders').timeBased().everyHours(1).create();
  try { SpreadsheetApp.getUi().alert('Hourly reminder trigger installed ✓'); } catch (e) { /* not in UI */ }
}

function menuCreateLink() {
  var ui = SpreadsheetApp.getUi();
  var r = ui.prompt('Booking link', 'Justlife booking reference (optional):', ui.ButtonSet.OK_CANCEL);
  if (r.getSelectedButton() !== ui.Button.OK) return;
  var token = token_(12);
  append_('Links', { token: token, label: 'Created from sheet', bookingRef: r.getResponseText().trim(), singleUse: 'TRUE', expiresOn: '', status: 'ACTIVE', uses: 0, createdBy: Session.getActiveUser().getEmail(), createdAt: nowIso_() });
  var url = siteLink_(settings_(), 't', token);
  ui.alert(url ? 'Send this link to the client:\n\n' + url : 'Link token: ' + token + '\n\n(Set SITE_URL in Settings to get the full link.)');
}
