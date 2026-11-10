/* =============================================================================
 * Justlife Teleconsultation — website logic (no build step, no frameworks)
 *   index.html?t=… / ?r=…   client booking, reschedule & cancel
 *   index.html (no link)    ADMIN sign-in & admin portal (Google, @justlife.com)
 *   doctor.html             DOCTOR sign-in & doctor portal (Google, @justlife.com)
 * All data goes through the Apps Script web app (CONFIG.APPS_SCRIPT_URL).
 * ========================================================================== */
(function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const app = $('#app');
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const keyDate = (k) => new Date(`${k}T12:00:00Z`);
  const fmtDay = (k) => keyDate(k).toLocaleDateString('en-GB', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short' });
  const fmtLong = (k) => keyDate(k).toLocaleDateString('en-GB', { timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  const t12 = (hhmm) => { if (!hhmm) return ''; const [h, m] = hhmm.split(':').map(Number); return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`; };
  const win = (a) => `${t12(a.start)} – ${t12(a.end)}`;
  const addDays = (k, n) => { const d = keyDate(k); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  const dubaiToday = () => new Date(Date.now() + 4 * 3600e3).toISOString().slice(0, 10);
  const initials = (n) => String(n || '?').replace(/^Dr\.?\s+/i, '').split(/\s+/).map((x) => x[0]).slice(0, 2).join('').toUpperCase();
  const avatar = (d) => `<div class="avatar">${d.photoUrl ? `<img src="${esc(d.photoUrl)}" alt="" onerror="this.remove()">` : ''}${d.photoUrl ? '' : esc(initials(d.name))}</div>`;
  const badge = (s) => `<span class="badge b-${esc(s)}">${esc(String(s || '').replace('_', ' '))}</span>`;
  const CONTACT = { WHATSAPP: 'WhatsApp', PHONE: 'Phone call' };
  const spinner = () => '<div class="spinner" role="status" aria-label="Loading"></div>';

  function toast(msg, isErr) {
    const box = $('#toast');
    const el = document.createElement('div');
    el.className = isErr ? 'err' : '';
    el.textContent = msg;
    box.appendChild(el);
    setTimeout(() => el.remove(), isErr ? 7000 : 3500);
  }

  function configProblem() {
    if (typeof CONFIG === 'undefined' || !CONFIG.APPS_SCRIPT_URL || /PASTE_YOUR/.test(CONFIG.APPS_SCRIPT_URL)) {
      return 'The website is not connected yet: put your Apps Script web app URL in config.js ▸ APPS_SCRIPT_URL.';
    }
    return '';
  }

  /** POST to the Apps Script web app. text/plain avoids a CORS preflight. */
  async function api(action, data = {}, auth) {
    const body = { action, data };
    if (auth) body.auth = auth;
    let res;
    try {
      res = await fetch(CONFIG.APPS_SCRIPT_URL, { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'text/plain;charset=utf-8' } });
    } catch (e) {
      throw Object.assign(new Error('Cannot reach the booking server. Check your internet connection and try again.'), { code: 'NETWORK' });
    }
    let json;
    try { json = await res.json(); } catch (e) {
      throw Object.assign(new Error('The server sent an unexpected answer. (Is the Apps Script deployed as a Web app with access "Anyone"?)'), { code: 'BAD_RESPONSE' });
    }
    if (!json.ok) throw Object.assign(new Error(json.error || 'Something went wrong.'), { code: json.code });
    return json.data;
  }

  function modal(title, html, { wide } = {}) {
    closeModal();
    const back = document.createElement('div');
    back.className = 'modal-back';
    back.innerHTML = `<div class="modal" role="dialog" aria-modal="true" ${wide ? '' : 'style="max-width:560px"'}>
      <div class="modal-head"><h2 style="margin:0">${title}</h2><button class="x" aria-label="Close" data-close>×</button></div>
      <div class="modal-body">${html}</div></div>`;
    back.addEventListener('click', (e) => { if (e.target === back || e.target.hasAttribute('data-close')) closeModal(); });
    document.body.appendChild(back);
    document.body.style.overflow = 'hidden';
    return back;
  }
  function closeModal() { $$('.modal-back').forEach((m) => m.remove()); document.body.style.overflow = ''; }
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });

  function readFileB64(file) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result).split(',')[1]);
      r.onerror = () => reject(new Error('Could not read the file.'));
      r.readAsDataURL(file);
    });
  }

  async function copy(text) {
    try { await navigator.clipboard.writeText(text); toast('Link copied ✓'); } catch (e) { window.prompt('Copy this link:', text); }
  }

  const pageUrl = (file, key, token) => {
    const u = new URL(file, location.href);
    u.search = `?${key}=${encodeURIComponent(token)}`;
    u.hash = '';
    return u.toString();
  };

  // ===========================================================================
  // CLIENT — booking, reschedule, cancel (index.html)
  // ===========================================================================
  const C = { t: '', r: '', settings: {}, doctors: [], step: 1, doctor: null, avail: {}, date: '', start: '', files: [], current: null };

  async function clientInit() {
    const problem = configProblem();
    if (problem) { app.innerHTML = `<div class="notice error">${esc(problem)}</div>`; return; }
    const qs = new URLSearchParams(location.search);
    C.t = qs.get('t') || '';
    C.r = qs.get('r') || '';
    if (!C.t && !C.r) { // no client link → this is the admin entrance
      document.body.dataset.portal = 'admin';
      app.classList.add('wide');
      $('#footer').classList.add('hidden');
      $('#tag').textContent = 'Admin portal';
      return staffInit();
    }
    try {
      const d = await api('init', { t: C.t, r: C.r });
      C.settings = d.settings;
      C.doctors = d.doctors;
      $('#support').innerHTML = `Need help? <a href="mailto:${esc(d.settings.supportEmail)}">${esc(d.settings.supportEmail)}</a> · ${esc(d.settings.supportPhone)}`;
      if (C.r) return clientLookup();
      if (!d.link.ok) { app.innerHTML = `<div class="card center"><h1>Booking link</h1><div class="notice warn">${esc(d.link.message)}</div></div>`; return; }
      C.bookingRef = d.link.bookingRef || '';
      C.step = 1;
      renderClient();
    } catch (e) {
      app.innerHTML = `<div class="notice error">${esc(e.message)}</div>`;
    }
  }

  function steps(n) { return `<div class="steps" aria-hidden="true">${[1, 2, 3, 4].map((i) => `<span class="${i <= n ? 'on' : ''}"></span>`).join('')}</div>`; }

  function renderClient() {
    if (C.step === 1) return renderDoctors();
    if (C.step === 2) return renderTimes();
    if (C.step === 3) return renderDetails();
    return null;
  }

  function renderDoctors() {
    const resched = Boolean(C.current);
    app.innerHTML = `${steps(1)}
      <h1>${resched ? 'Choose a new time' : 'Book a teleconsultation'}</h1>
      <p class="muted">Choose your doctor. The doctor will call you by phone or WhatsApp within your chosen ${C.settings.slotMinutes}-minute window.</p>
      <div class="stack" id="docs">${C.doctors.length ? C.doctors.map((d) => `
        <div class="card doctor ${C.doctor && C.doctor.id === d.id ? 'selected' : ''}" tabindex="0" role="button" data-doc="${esc(d.id)}">
          ${avatar(d)}
          <div><h3 style="margin:0">${esc(d.name)}</h3>
            <div class="muted small">${esc(d.specialty)}${d.experienceYears ? ` · ${esc(d.experienceYears)} years experience` : ''}</div>
            ${d.languages ? `<div class="chips">${String(d.languages).split(',').map((l) => `<span class="chip">${esc(l.trim())}</span>`).join('')}</div>` : ''}
            ${d.bio ? `<p class="small" style="margin:8px 0 0">${esc(d.bio)}</p>` : ''}
          </div></div>`).join('') : '<div class="empty card">No doctors are available right now. Please contact Justlife Healthcare.</div>'}
      </div>
      ${resched ? '<p style="margin-top:16px"><button class="btn" data-act="back-lookup">← Back</button></p>' : ''}`;
    $$('[data-doc]').forEach((el) => {
      const go = () => pickDoctor(el.dataset.doc);
      el.addEventListener('click', go);
      el.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } });
    });
    const back = $('[data-act="back-lookup"]');
    if (back) back.onclick = () => clientLookup();
  }

  async function pickDoctor(id) {
    C.doctor = C.doctors.find((d) => d.id === id);
    C.date = ''; C.start = '';
    C.step = 2;
    app.innerHTML = `${steps(2)}<h1>Choose a time</h1>${spinner()}`;
    try {
      const res = await api('availability', { doctorId: id, r: C.r });
      C.avail = res.doctors[id] || {};
      C.date = Object.keys(C.avail).sort()[0] || '';
      renderTimes();
    } catch (e) { toast(e.message, true); C.step = 1; renderDoctors(); }
  }

  function renderTimes() {
    const d = C.doctor;
    const days = [];
    const today = dubaiToday();
    for (let i = 0; i < (C.settings.horizonDays || 14); i++) days.push(addDays(today, i));
    const slots = C.avail[C.date] || [];
    app.innerHTML = `${steps(2)}
      <div class="card doctor selected" style="cursor:default">${avatar(d)}<div><h3 style="margin:0">${esc(d.name)}</h3><div class="muted small">${esc(d.specialty)}</div>
        <button class="link-btn small" data-act="change-doc">Change doctor</button></div></div>
      <h2 style="margin-top:20px">Choose a day</h2>
      ${Object.keys(C.avail).length ? `<div class="dates">${days.map((k) => {
    const n = (C.avail[k] || []).length;
    const dt = keyDate(k);
    return `<button class="date ${k === C.date ? 'selected' : ''}" data-date="${k}" ${n ? '' : 'disabled'}>
          <small>${dt.toLocaleDateString('en-GB', { timeZone: 'UTC', weekday: 'short' })}</small><b>${dt.getUTCDate()}</b>
          <small>${dt.toLocaleDateString('en-GB', { timeZone: 'UTC', month: 'short' })}</small></button>`;
  }).join('')}</div>
      <h2 style="margin-top:12px">Choose your time window <span class="muted small">(Dubai time)</span></h2>
      <div class="slots">${slots.map((s) => `<button class="slot ${s === C.start ? 'selected' : ''}" data-slot="${s}">${t12(s)} – ${t12(addMin(s, C.settings.slotMinutes))}</button>`).join('')}</div>`
    : '<div class="notice warn">This doctor has no free times in the next days. Please choose another doctor.</div>'}
      <div class="row between" style="margin-top:22px"><button class="btn" data-act="change-doc">← Back</button>
        <button class="btn btn-primary" data-act="next" ${C.start ? '' : 'disabled'}>Continue</button></div>`;
    $$('[data-date]').forEach((b) => { b.onclick = () => { C.date = b.dataset.date; C.start = ''; renderTimes(); }; });
    $$('[data-slot]').forEach((b) => { b.onclick = () => { C.start = b.dataset.slot; renderTimes(); }; });
    $$('[data-act="change-doc"]').forEach((b) => { b.onclick = () => { C.step = 1; renderDoctors(); }; });
    $('[data-act="next"]').onclick = () => {
      if (C.current) return confirmReschedule();
      C.step = 3; return renderDetails();
    };
  }

  const addMin = (hhmm, m) => { const [h, mm] = hhmm.split(':').map(Number); const t = h * 60 + mm + Number(m || 60); return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`; };

  function renderDetails() {
    const f = C.form || { mobile: '+971 ', bookingRef: C.bookingRef, contactMethod: 'WHATSAPP' };
    app.innerHTML = `${steps(3)}
      <div class="card"><div class="row between"><div><b>${esc(C.doctor.name)}</b><div class="muted small">${esc(fmtLong(C.date))} · ${t12(C.start)} – ${t12(addMin(C.start, C.settings.slotMinutes))}</div></div>
        <button class="btn btn-sm" data-act="change-time">Change</button></div></div>
      <form id="bookform" class="card stack" novalidate>
        <h2>Your details</h2>
        <label class="field"><span class="label">Full name</span><input class="input" name="name" autocomplete="name" required value="${esc(f.name || '')}"></label>
        <div class="grid grid-2">
          <label class="field"><span class="label">Email</span><input class="input" name="email" type="email" autocomplete="email" required value="${esc(f.email || '')}"></label>
          <label class="field"><span class="label">Mobile number</span><input class="input" name="mobile" type="tel" autocomplete="tel" required value="${esc(f.mobile || '')}"></label>
        </div>
        <label class="field"><span class="label">Justlife booking reference</span><input class="input" name="bookingRef" value="${esc(f.bookingRef || '')}" placeholder="e.g. JL-239812"></label>
        <div><span class="label">How should the doctor contact you?</span>
          <div class="contact-choice" style="margin-top:6px">
            <label><input type="radio" name="contactMethod" value="WHATSAPP" ${f.contactMethod !== 'PHONE' ? 'checked' : ''}><span>WhatsApp</span></label>
            <label><input type="radio" name="contactMethod" value="PHONE" ${f.contactMethod === 'PHONE' ? 'checked' : ''}><span>Phone call</span></label>
          </div></div>
        <label class="field"><span class="label">Anything the doctor should know? <span class="muted">(optional)</span></span><textarea class="input" name="notes" maxlength="1000">${esc(f.notes || '')}</textarea></label>
        <div class="field"><span class="label">Lab results <span class="muted">(optional · PDF, JPG or PNG · max ${C.settings.maxUploadMb} MB each)</span></span>
          <input class="input" type="file" id="files" accept=".pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png" multiple>
          <div id="filelist" class="small muted">${C.files.map((x) => esc(x.name)).join(', ')}</div></div>
        <label class="check"><input type="checkbox" name="consent" required ${f.consent ? 'checked' : ''}><span>I agree that Justlife Healthcare may use my details to arrange this consultation, as described in the <a href="privacy.html" target="_blank">privacy notice</a>.</span></label>
        <div id="formerr"></div>
        <button class="btn btn-primary btn-lg btn-block" type="submit">Confirm booking</button>
      </form>`;
    $('[data-act="change-time"]').onclick = () => { C.form = formValues(); C.step = 2; renderTimes(); };
    $('#files').onchange = (e) => {
      const list = Array.from(e.target.files || []);
      const max = (C.settings.maxUploadMb || 5) * 1024 * 1024;
      const bad = list.find((x) => x.size > max || !/\.(pdf|jpe?g|png)$/i.test(x.name));
      if (bad) { toast(`"${bad.name}" can't be uploaded — only PDF/JPG/PNG up to ${C.settings.maxUploadMb} MB.`, true); e.target.value = ''; C.files = []; }
      else if (list.length > 5) { toast('You can upload up to 5 files.', true); e.target.value = ''; C.files = []; }
      else C.files = list;
      $('#filelist').textContent = C.files.map((x) => x.name).join(', ');
    };
    $('#bookform').onsubmit = submitBooking;
  }

  function formValues() {
    const fd = new FormData($('#bookform'));
    return { name: fd.get('name'), email: fd.get('email'), mobile: fd.get('mobile'), bookingRef: fd.get('bookingRef'), contactMethod: fd.get('contactMethod'), notes: fd.get('notes'), consent: fd.get('consent') === 'on' };
  }

  async function submitBooking(e) {
    e.preventDefault();
    const f = formValues();
    C.form = f;
    const err = (m) => { $('#formerr').innerHTML = `<div class="notice error">${esc(m)}</div>`; };
    if (String(f.name).trim().length < 2) return err('Please enter your full name.');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(f.email).trim())) return err('Please enter a valid email address.');
    if (!/^\+?\d{7,15}$/.test(String(f.mobile).replace(/[^\d+]/g, ''))) return err('Please enter a valid mobile number, e.g. +971 50 123 4567.');
    if (!f.consent) return err('Please accept the privacy notice to continue.');
    const btn = $('#bookform button[type=submit]');
    btn.disabled = true; btn.textContent = C.files.length ? 'Uploading & booking…' : 'Booking…';
    try {
      const files = [];
      for (const x of C.files) files.push({ name: x.name, base64: await readFileB64(x) });
      const res = await api('book', { t: C.t, doctorId: C.doctor.id, date: C.date, start: C.start, client: f, files });
      renderConfirmation(res.appointment, res.rescheduleToken, 'booked');
    } catch (ex) {
      btn.disabled = false; btn.textContent = 'Confirm booking';
      if (ex.code === 'SLOT_TAKEN') { toast(ex.message, true); await pickDoctor(C.doctor.id); return; }
      err(ex.message);
    }
  }

  function renderConfirmation(a, token, kind) {
    const link = token ? pageUrl('index.html', 'r', token) : '';
    app.innerHTML = `${kind === 'booked' ? steps(4) : ''}
      <div class="card center"><div class="success-icon">✓</div>
        <h1>${kind === 'booked' ? 'Your teleconsultation is booked' : 'Your appointment has been rescheduled'}</h1>
        <p class="muted">A confirmation has been sent to <b>${esc(a.email)}</b>.</p></div>
      <div class="card ticket">
        <div class="muted small">Appointment</div><div class="big">${esc(a.appointmentNo)}</div>
        <dl class="kv" style="margin-top:14px">
          <dt>Doctor</dt><dd>${esc(a.doctorName)}</dd>
          <dt>Date</dt><dd>${esc(fmtLong(a.date))}</dd>
          <dt>Time window</dt><dd>${esc(win(a))} (Dubai)</dd>
          <dt>Contact</dt><dd>${esc(CONTACT[a.contactMethod])} — the doctor will reach you within this window</dd>
          ${a.bookingRef ? `<dt>Justlife ref</dt><dd>${esc(a.bookingRef)}</dd>` : ''}
          ${a.files ? `<dt>Lab results</dt><dd>${a.files} file(s) attached</dd>` : ''}
        </dl></div>
      ${link ? `<div class="card"><h3>Need to change it?</h3><p class="small muted">Save this private link to reschedule or cancel (also in your email):</p>
        <div class="row"><input class="input" readonly value="${esc(link)}" style="flex:1"><button class="btn" data-act="copy">Copy</button></div></div>` : ''}`;
    const c = $('[data-act="copy"]');
    if (c) c.onclick = () => copy(link);
  }

  // ---- reschedule / cancel via ?r=token ----
  async function clientLookup() {
    app.innerHTML = spinner();
    try {
      const d = await api('lookup', { r: C.r });
      C.current = d.appointment;
      const a = d.appointment;
      app.innerHTML = `<h1>Your teleconsultation</h1>
        <div class="card ticket"><div class="row between"><div class="big">${esc(a.appointmentNo)}</div>${badge(a.status)}</div>
          <dl class="kv" style="margin-top:12px"><dt>Doctor</dt><dd>${esc(a.doctorName)}</dd><dt>Date</dt><dd>${esc(fmtLong(a.date))}</dd>
          <dt>Time window</dt><dd>${esc(win(a))} (Dubai)</dd><dt>Contact</dt><dd>${esc(CONTACT[a.contactMethod])}</dd></dl></div>
        ${d.reason ? `<div class="notice warn" style="margin-top:14px">${esc(d.reason)}</div>` : ''}
        <div class="row" style="margin-top:16px">
          ${d.canReschedule ? '<button class="btn btn-primary" data-act="resched">Reschedule</button>' : ''}
          ${d.canCancel ? '<button class="btn btn-danger" data-act="cancel">Cancel appointment</button>' : ''}
        </div>`;
      const r = $('[data-act="resched"]');
      if (r) r.onclick = () => { C.step = 1; C.doctor = C.doctors.find((x) => x.id === a.doctorId) || null; renderDoctors(); };
      const c = $('[data-act="cancel"]');
      if (c) c.onclick = cancelDialog;
    } catch (e) {
      app.innerHTML = `<div class="card center"><h1>Appointment</h1><div class="notice warn">${esc(e.message)}</div></div>`;
    }
  }

  function confirmReschedule() {
    const a = C.current;
    const m = modal('Confirm new time', `<dl class="kv"><dt>From</dt><dd>${esc(a.doctorName)} · ${esc(fmtDay(a.date))} ${esc(win(a))}</dd>
      <dt>To</dt><dd>${esc(C.doctor.name)} · ${esc(fmtDay(C.date))} ${t12(C.start)} – ${t12(addMin(C.start, C.settings.slotMinutes))}</dd></dl>
      <label class="field" style="margin-top:14px"><span class="label">Reason <span class="muted">(optional)</span></span><input class="input" id="rreason" maxlength="300"></label>
      <div class="row" style="margin-top:16px;justify-content:flex-end"><button class="btn" data-close>Back</button><button class="btn btn-primary" id="rgo">Confirm reschedule</button></div>`);
    $('#rgo', m).onclick = async (e) => {
      e.target.disabled = true;
      try {
        const res = await api('reschedule', { r: C.r, doctorId: C.doctor.id, date: C.date, start: C.start, reason: $('#rreason', m).value });
        closeModal();
        C.current = null;
        renderConfirmation(res.appointment, res.rescheduleToken, 'rescheduled');
      } catch (ex) {
        e.target.disabled = false;
        toast(ex.message, true);
        if (ex.code === 'SLOT_TAKEN') { closeModal(); pickDoctor(C.doctor.id); }
      }
    };
  }

  function cancelDialog() {
    const m = modal('Cancel appointment', `<p>Are you sure you want to cancel this teleconsultation?</p>
      <label class="field"><span class="label">Reason <span class="muted">(optional)</span></span><input class="input" id="creason" maxlength="300"></label>
      <div class="row" style="margin-top:16px;justify-content:flex-end"><button class="btn" data-close>Keep appointment</button><button class="btn btn-danger" id="cgo">Cancel appointment</button></div>`);
    $('#cgo', m).onclick = async (e) => {
      e.target.disabled = true;
      try { await api('cancel', { r: C.r, reason: $('#creason', m).value }); closeModal(); toast('Your appointment has been cancelled.'); clientLookup(); } catch (ex) { e.target.disabled = false; toast(ex.message, true); }
    };
  }

  // ===========================================================================
  // STAFF PORTALS — admin (index.html without a link) and doctor (doctor.html)
  // ===========================================================================
  const S = { auth: null, me: null, view: '', cache: {} };
  const AUTH_KEY = 'jl_staff_auth';
  const portal = () => (document.body.dataset.portal === 'doctor' ? 'doctor' : 'admin');

  const sapi = async (action, data) => {
    try { return await api(action, data, S.auth); } catch (e) {
      if (e.code === 'AUTH' || e.code === 'DOMAIN' || e.code === 'FORBIDDEN' && action === 'me') { signOut(e.message); }
      throw e;
    }
  };

  function decodeJwt(t) {
    try { return JSON.parse(decodeURIComponent(escape(atob(t.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))))); } catch (e) { return {}; }
  }

  async function staffInit() {
    const problem = configProblem();
    if (problem) { app.innerHTML = `<div class="notice error">${esc(problem)}</div>`; return; }
    try { S.auth = JSON.parse(sessionStorage.getItem(AUTH_KEY) || 'null'); } catch (e) { S.auth = null; }
    if (S.auth && S.auth.mode === 'google' && S.auth.exp * 1000 < Date.now() + 60e3) S.auth = null;
    if (S.auth) {
      try { S.me = await sapi('me'); return startPortal(); } catch (e) { /* show login */ }
    }
    showLogin();
  }

  async function showLogin(message) {
    $('#nav').classList.add('hidden');
    $('#userbox').innerHTML = '';
    app.innerHTML = spinner();
    let settings;
    try { settings = (await api('init', {})).settings; } catch (e) { app.innerHTML = `<div class="notice error">${esc(e.message)}</div>`; return; }
    const domain = settings.allowedDomain || CONFIG.ALLOWED_DOMAIN;
    app.innerHTML = `<div class="card login">
      <h1>${portal() === 'doctor' ? 'Doctor sign in' : 'Admin sign in'}</h1><p class="muted">Use your <b>@${esc(domain)}</b> ${settings.authMode === 'test' ? 'email' : 'Google account'}.</p>
      ${message ? `<div class="notice error" style="margin:12px 0">${esc(message)}</div>` : ''}
      ${settings.authMode === 'test' ? `
        <form id="testlogin" class="stack" style="text-align:left;margin-top:16px">
          <div class="notice warn small">Test mode — Google sign-in is switched off (Settings ▸ AUTH_MODE = test).</div>
          <label class="field"><span class="label">Work email</span><input class="input" name="email" type="email" required placeholder="name@${esc(domain)}"></label>
          <label class="field"><span class="label">Test password</span><input class="input" name="password" type="password" required></label>
          <button class="btn btn-primary btn-block">Sign in</button></form>`
    : `<div id="gbtn"></div><p class="small muted" id="gsi-msg"></p>`}
      <p class="small muted" style="margin-top:18px">${portal() === 'doctor' ? 'Admin or CX? <a href="./">Admin sign in</a>' : 'Doctor? <a href="doctor.html">Doctor sign in</a>'}</p>
    </div>`;
    if (settings.authMode === 'test') {
      $('#testlogin').onsubmit = async (e) => {
        e.preventDefault();
        const fd = new FormData(e.target);
        const email = String(fd.get('email')).trim().toLowerCase();
        if (!email.endsWith(`@${domain}`)) return toast(`Only @${domain} accounts can sign in.`, true);
        S.auth = { mode: 'test', email, password: fd.get('password') };
        try { S.me = await api('me', {}, S.auth); sessionStorage.setItem(AUTH_KEY, JSON.stringify(S.auth)); startPortal(); } catch (ex) { S.auth = null; toast(ex.message, true); }
        return null;
      };
      return;
    }
    if (!CONFIG.GOOGLE_CLIENT_ID || /PASTE/.test(CONFIG.GOOGLE_CLIENT_ID)) { $('#gsi-msg').textContent = 'GOOGLE_CLIENT_ID is missing in config.js.'; return; }
    let tries = 0;
    const ready = () => {
      if (!(window.google && google.accounts && google.accounts.id)) {
        if (++tries > 100) { $('#gsi-msg').textContent = 'Google sign-in could not load. Check your connection or ad-blocker.'; return; }
        setTimeout(ready, 100); return;
      }
      google.accounts.id.initialize({ client_id: CONFIG.GOOGLE_CLIENT_ID, callback: onGoogleCredential, hd: domain, auto_select: false, cancel_on_tap_outside: true });
      google.accounts.id.renderButton($('#gbtn'), { theme: 'outline', size: 'large', text: 'continue_with', shape: 'pill', width: 280 });
    };
    ready();
  }

  async function onGoogleCredential(resp) {
    const p = decodeJwt(resp.credential);
    const domain = (CONFIG.ALLOWED_DOMAIN || 'justlife.com').toLowerCase();
    if (!p.email || p.email.toLowerCase().split('@')[1] !== domain) {
      showLogin(`Access restricted to authorized Justlife accounts (@${domain}).`);
      return;
    }
    S.auth = { mode: 'google', idToken: resp.credential, exp: p.exp, email: p.email };
    app.innerHTML = spinner();
    try {
      S.me = await api('me', {}, S.auth);
      sessionStorage.setItem(AUTH_KEY, JSON.stringify(S.auth));
      startPortal();
    } catch (e) { S.auth = null; showLogin(e.message); }
  }

  function signOut(message) {
    sessionStorage.removeItem(AUTH_KEY);
    S.auth = null; S.me = null;
    try { if (window.google && google.accounts) google.accounts.id.disableAutoSelect(); } catch (e) { /* ignore */ }
    closeModal();
    showLogin(message);
  }

  const isAdmin = () => S.me && S.me.user.role === 'ADMIN';
  const ADMIN_VIEWS = [['dashboard', 'Dashboard'], ['schedule', 'Schedule'], ['bookings', 'Bookings'], ['doctors', 'Doctors'], ['links', 'Booking links']];
  const DOCTOR_VIEWS = [['today', 'Today'], ['upcoming', 'Upcoming'], ['completed', 'Completed']];

  function startPortal() {
    const u = S.me.user;
    // Right person, right door: doctors use doctor.html, admins use the home page.
    const want = portal() === 'doctor' ? 'DOCTOR' : 'ADMIN';
    if (u.role !== want) {
      const other = u.role === 'DOCTOR' ? 'doctor.html' : './';
      $('#userbox').innerHTML = '<button class="btn btn-sm" id="signout">Sign out</button>';
      $('#signout').onclick = () => signOut();
      app.innerHTML = `<div class="card login"><h1>${u.role === 'DOCTOR' ? 'You are a doctor' : 'You are an admin'}</h1>
        <p class="muted">${esc(u.email)} signs in on the ${u.role === 'DOCTOR' ? 'doctor' : 'admin'} page.</p>
        <a class="btn btn-primary btn-block" href="${other}">Open the ${u.role === 'DOCTOR' ? 'doctor' : 'admin'} portal</a></div>`;
      return;
    }
    $('#userbox').innerHTML = `<div class="user-chip"><b>${esc(u.name)}</b>${esc(u.email)} · ${u.role === 'ADMIN' ? 'Admin' : 'Doctor'}</div>
      ${isAdmin() && CONFIG.GOOGLE_SHEET_URL && !/PASTE/.test(CONFIG.GOOGLE_SHEET_URL) ? `<a class="btn btn-sm" href="${esc(CONFIG.GOOGLE_SHEET_URL)}" target="_blank" rel="noopener">Open Google Sheet</a>` : ''}
      <button class="btn btn-sm" id="signout">Sign out</button>`;
    $('#signout').onclick = () => signOut();
    const views = isAdmin() ? ADMIN_VIEWS : DOCTOR_VIEWS;
    const nav = $('#nav');
    nav.innerHTML = views.map(([k, l]) => `<a href="#${k}" data-v="${k}">${l}</a>`).join('');
    nav.classList.remove('hidden');
    window.onhashchange = route;
    route();
  }

  function route() {
    const views = (isAdmin() ? ADMIN_VIEWS : DOCTOR_VIEWS).map((v) => v[0]);
    const v = views.includes(location.hash.slice(1)) ? location.hash.slice(1) : views[0];
    S.view = v;
    $$('#nav a').forEach((a) => a.classList.toggle('on', a.dataset.v === v));
    app.innerHTML = spinner();
    const fn = { dashboard: viewDashboard, schedule: viewSchedule, bookings: viewBookings, doctors: viewDoctors, links: viewLinks, today: viewDoctorList, upcoming: viewDoctorList, completed: viewDoctorList }[v];
    Promise.resolve(fn(v)).catch((e) => { app.innerHTML = `<div class="notice error">${esc(e.message)}</div>`; });
  }
  const refresh = () => route();

  function apptRow(a, { showDoctor = true, showDate = false } = {}) {
    return `<div class="appt-row" data-appt="${esc(a.id)}">
      <div><div class="time">${t12(a.start)}</div><div class="small muted">${showDate ? esc(fmtDay(a.date)) : `to ${t12(a.end)}`}</div></div>
      <div><b>${esc(a.clientName)}</b> <span class="muted small">· ${esc(CONTACT[a.contactMethod] || a.contactMethod)}${a.hasFiles ? ' · 📎 lab results' : ''}</span>
        <div class="small muted">${esc(a.appointmentNo)}${showDoctor ? ` · ${esc(a.doctorName)}` : ''}${a.bookingRef ? ` · ${esc(a.bookingRef)}` : ''}</div></div>
      <div>${badge(a.status)}</div></div>`;
  }
  function bindRows(root = app) { $$('[data-appt]', root).forEach((el) => { el.onclick = () => openAppt(el.dataset.appt); }); }

  function groupByDay(rows, opts) {
    if (!rows.length) return '<div class="empty card">No appointments.</div>';
    let out = ''; let day = '';
    rows.forEach((a) => {
      if (a.date !== day) { day = a.date; out += `<div class="day-head">${esc(fmtLong(day))}${day === S.me.today ? ' · Today' : ''}</div>`; }
      out += apptRow(a, opts);
    });
    return out;
  }

  // ---- doctor views ----
  async function viewDoctorList(v) {
    const today = S.me.today;
    const q = v === 'today' ? { from: today, to: today } : v === 'upcoming' ? { from: today, to: addDays(today, 60), status: 'SCHEDULED,CALLING' } : { from: addDays(today, -120), to: today, status: 'COMPLETED', desc: true };
    const d = await sapi('appointments', q);
    const title = { today: `Today · ${fmtLong(today)}`, upcoming: 'Upcoming appointments', completed: 'Completed consultations' }[v];
    const pending = d.rows.filter((a) => a.status === 'SCHEDULED' || a.status === 'CALLING').length;
    app.innerHTML = `<div class="row between"><h1>${esc(title)}</h1><button class="btn btn-sm" data-act="reload">Refresh</button></div>
      ${v === 'today' ? `<p class="muted">${d.rows.length} appointment(s) · ${pending} still to call. Call each client inside their time window.</p>` : ''}
      ${v === 'today' ? (d.rows.length ? d.rows.map((a) => apptRow(a, { showDoctor: false })).join('') : '<div class="empty card">No appointments today.</div>') : groupByDay(d.rows, { showDoctor: false })}`;
    $('[data-act="reload"]').onclick = refresh;
    bindRows();
  }

  // ---- admin: dashboard ----
  async function viewDashboard() {
    const f = S.cache.dash || { from: addDays(S.me.today, -29), to: S.me.today };
    const d = await sapi('dashboard', f);
    const T = d.totals;
    const pct = (x) => (x == null ? '—' : `${x}%`);
    const kpi = (v, l) => `<div class="card kpi"><div class="v">${v}</div><div class="l">${l}</div></div>`;
    const presets = [['Today', 0, 0], ['Last 7 days', -6, 0], ['Last 30 days', -29, 0], ['Next 7 days', 0, 6]];
    app.innerHTML = `<div class="row between"><h1>Dashboard</h1><div class="row">${presets.map(([l, a, b]) => `<button class="btn btn-sm" data-p="${a},${b}">${l}</button>`).join('')}
        <input type="date" class="input input-sm" id="dfrom" value="${d.from}" style="width:auto"><input type="date" class="input input-sm" id="dto" value="${d.to}" style="width:auto"><button class="btn btn-sm btn-primary" id="dgo">Apply</button></div></div>
      <div class="grid grid-3" style="margin:12px 0">${kpi(d.live.today, 'Appointments today')}${kpi(d.live.upcoming, 'Upcoming (scheduled)')}${kpi(d.live.inCall, 'Calls in progress')}</div>
      <h2 style="margin-top:18px">${esc(fmtDay(d.from))} – ${esc(fmtDay(d.to))}</h2>
      <div class="grid grid-4">${kpi(T.total, 'Bookings')}${kpi(pct(T.completionPct), `Completed (${T.completed})`)}${kpi(pct(T.onTimePct), `On-time calls (≤${d.toleranceMinutes} min)`)}${kpi(T.avgDelay == null ? '—' : `${T.avgDelay} min`, 'Average call delay')}
        ${kpi(pct(T.cancelPct), `Cancelled (${T.cancelled})`)}${kpi(pct(T.noShowPct), `No-show (${T.noShow})`)}${kpi(pct(T.upsellConversionPct), `Upsell conversion (${T.upsellsBooked}/${T.upsells})`)}${kpi(`AED ${Math.round(T.gmv).toLocaleString()}`, 'Upsell GMV')}</div>
      <div class="card" style="margin-top:16px"><h2>Doctor performance</h2><div class="table-wrap"><table class="list"><thead><tr><th>Doctor</th><th>Bookings</th><th>Completed</th><th>No-show</th><th>On-time</th><th>Avg delay</th><th>Upsell conv.</th><th>GMV (AED)</th></tr></thead>
        <tbody>${d.doctors.map((x) => `<tr><td><b>${esc(x.name)}</b></td><td>${x.total}</td><td>${x.completed} · ${pct(x.completionPct)}</td><td>${x.noShow}</td><td>${pct(x.onTimePct)}</td><td>${x.avgDelay == null ? '—' : `${x.avgDelay} min`}</td><td>${pct(x.upsellConversionPct)}</td><td>${Math.round(x.gmv).toLocaleString()}</td></tr>`).join('') || '<tr><td colspan="8" class="empty">No bookings in this period.</td></tr>'}</tbody></table></div></div>`;
    $$('[data-p]').forEach((b) => { b.onclick = () => { const [a, z] = b.dataset.p.split(',').map(Number); S.cache.dash = { from: addDays(S.me.today, a), to: addDays(S.me.today, z) }; refresh(); }; });
    $('#dgo').onclick = () => { S.cache.dash = { from: $('#dfrom').value, to: $('#dto').value }; refresh(); };
  }

  // ---- admin: schedule (day-by-day calendar list) ----
  async function viewSchedule() {
    const f = S.cache.sched || { from: S.me.today, days: 7, doctorId: '' };
    const to = addDays(f.from, f.days - 1);
    const d = await sapi('appointments', { from: f.from, to, doctorId: f.doctorId, status: 'SCHEDULED,CALLING,COMPLETED,NO_SHOW' });
    app.innerHTML = `<div class="row between"><h1>Schedule</h1><button class="btn btn-primary" data-act="new">+ New booking</button></div>
      <div class="toolbar"><button class="btn btn-sm" data-shift="-7">← Previous</button><input type="date" class="input input-sm" id="sfrom" value="${f.from}">
        <button class="btn btn-sm" data-shift="7">Next →</button><button class="btn btn-sm" data-today>Today</button>
        <select class="input input-sm" id="sdoc"><option value="">All doctors</option>${S.me.doctors.map((x) => `<option value="${esc(x.id)}" ${x.id === f.doctorId ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select></div>
      <p class="muted small">${esc(fmtDay(f.from))} – ${esc(fmtDay(to))} · ${d.rows.length} appointment(s) (cancelled & rescheduled versions hidden)</p>
      ${groupByDay(d.rows, { showDoctor: true })}`;
    const set = (patch) => { S.cache.sched = Object.assign({}, f, patch); refresh(); };
    $$('[data-shift]').forEach((b) => { b.onclick = () => set({ from: addDays(f.from, Number(b.dataset.shift)) }); });
    $('[data-today]').onclick = () => set({ from: S.me.today });
    $('#sfrom').onchange = (e) => set({ from: e.target.value });
    $('#sdoc').onchange = (e) => set({ doctorId: e.target.value });
    $('[data-act="new"]').onclick = newBookingDialog;
    bindRows();
  }

  // ---- admin: bookings search ----
  async function viewBookings() {
    const f = S.cache.book || { from: addDays(S.me.today, -30), to: addDays(S.me.today, 30), status: '', doctorId: '', q: '' };
    const d = await sapi('appointments', Object.assign({ desc: true }, f));
    const statuses = ['SCHEDULED', 'CALLING', 'COMPLETED', 'NO_SHOW', 'CANCELLED', 'RESCHEDULED'];
    app.innerHTML = `<div class="row between"><h1>Bookings</h1><div class="row"><button class="btn" data-act="csv">Export CSV</button><button class="btn btn-primary" data-act="new">+ New booking</button></div></div>
      <form class="toolbar" id="bf">
        <label class="field"><span class="label small">Search</span><input class="input input-sm" name="q" value="${esc(f.q)}" placeholder="Name, mobile, ref, JLTC-…"></label>
        <label class="field"><span class="label small">From</span><input type="date" class="input input-sm" name="from" value="${f.from}"></label>
        <label class="field"><span class="label small">To</span><input type="date" class="input input-sm" name="to" value="${f.to}"></label>
        <label class="field"><span class="label small">Status</span><select class="input input-sm" name="status"><option value="">Any</option>${statuses.map((s) => `<option ${s === f.status ? 'selected' : ''}>${s}</option>`).join('')}</select></label>
        <label class="field"><span class="label small">Doctor</span><select class="input input-sm" name="doctorId"><option value="">All</option>${S.me.doctors.map((x) => `<option value="${esc(x.id)}" ${x.id === f.doctorId ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select></label>
        <button class="btn btn-sm btn-primary">Search</button></form>
      <div class="card" style="padding:0"><div class="table-wrap"><table class="list"><thead><tr><th>Date</th><th>Window</th><th>Client</th><th>Doctor</th><th>Contact</th><th>Ref</th><th>Status</th></tr></thead><tbody>
      ${d.rows.map((a) => `<tr class="click" data-appt="${esc(a.id)}"><td>${esc(fmtDay(a.date))}</td><td>${esc(win(a))}</td><td><b>${esc(a.clientName)}</b><div class="small muted">${esc(a.appointmentNo)}</div></td>
        <td>${esc(a.doctorName)}</td><td>${esc(CONTACT[a.contactMethod] || '')}</td><td>${esc(a.bookingRef)}</td><td>${badge(a.status)}</td></tr>`).join('') || '<tr><td colspan="7" class="empty">No bookings match.</td></tr>'}
      </tbody></table></div></div><p class="small muted">${d.total} booking(s)${d.total > d.rows.length ? `, showing first ${d.rows.length}` : ''}.</p>`;
    $('#bf').onsubmit = (e) => { e.preventDefault(); S.cache.book = Object.fromEntries(new FormData(e.target)); refresh(); };
    $('[data-act="new"]').onclick = newBookingDialog;
    $('[data-act="csv"]').onclick = () => {
      const head = ['Appointment', 'Date', 'Start', 'End', 'Client', 'Doctor', 'Contact', 'Justlife ref', 'Status', 'Source', 'Call delay (min)'];
      const cell = (v) => { let s = String(v == null ? '' : v); if (/^[=+\-@]/.test(s) && !/^[+-]?\d/.test(s)) s = `'${s}`; return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
      const lines = [head.join(',')].concat(d.rows.map((a) => [a.appointmentNo, a.date, a.start, a.end, a.clientName, a.doctorName, a.contactMethod, a.bookingRef, a.status, a.source, a.callDelayMin].map(cell).join(',')));
      const blob = new Blob([`﻿${lines.join('\r\n')}`], { type: 'text/csv' });
      const link = document.createElement('a'); link.href = URL.createObjectURL(blob); link.download = `teleconsultations-${f.from}-${f.to}.csv`; link.click();
    };
    bindRows();
  }

  // ---- slot picker used by new booking & reschedule ----
  function slotPicker(root, { excludeId, doctorId, onPick }) {
    root.innerHTML = `<div class="grid grid-2"><label class="field"><span class="label">Doctor</span><select class="input" data-f="doc">${S.me.doctors.filter((x) => x.status === 'ACTIVE').map((x) => `<option value="${esc(x.id)}" ${x.id === doctorId ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select></label>
      <label class="field"><span class="label">Date</span><input type="date" class="input" data-f="date" value="${S.me.today}" min="${S.me.today}"></label></div>
      <div data-f="slots" style="margin-top:10px"></div>`;
    const load = async () => {
      const box = $('[data-f="slots"]', root);
      box.innerHTML = spinner();
      onPick(null);
      try {
        const { slots } = await sapi('adminSlots', { doctorId: $('[data-f="doc"]', root).value, date: $('[data-f="date"]', root).value, excludeId });
        box.innerHTML = slots.length ? `<div class="slots">${slots.map((s) => `<button type="button" class="slot" data-s="${s}">${t12(s)}</button>`).join('')}</div>` : '<div class="notice warn">No free time for this doctor on this day.</div>';
        $$('[data-s]', box).forEach((b) => { b.onclick = () => { $$('[data-s]', box).forEach((x) => x.classList.remove('selected')); b.classList.add('selected'); onPick({ doctorId: $('[data-f="doc"]', root).value, date: $('[data-f="date"]', root).value, start: b.dataset.s }); }; });
      } catch (e) { box.innerHTML = `<div class="notice error">${esc(e.message)}</div>`; }
    };
    $('[data-f="doc"]', root).onchange = load;
    $('[data-f="date"]', root).onchange = load;
    load();
  }

  function newBookingDialog() {
    let pick = null;
    const m = modal('New booking', `<form id="nb" class="stack">
      <div class="grid grid-2"><label class="field"><span class="label">Client name</span><input class="input" name="name" required></label>
        <label class="field"><span class="label">Mobile</span><input class="input" name="mobile" required value="+971 "></label></div>
      <div class="grid grid-2"><label class="field"><span class="label">Email</span><input class="input" name="email" type="email" required></label>
        <label class="field"><span class="label">Justlife ref</span><input class="input" name="bookingRef"></label></div>
      <label class="field"><span class="label">Contact method</span><select class="input" name="contactMethod"><option value="WHATSAPP">WhatsApp</option><option value="PHONE">Phone call</option></select></label>
      <div id="nbslots"></div>
      <label class="field"><span class="label">Internal note <span class="muted">(not shown to client)</span></span><textarea class="input" name="adminNotes"></textarea></label>
      <button class="btn btn-primary btn-block" id="nbgo" disabled>Create booking</button></form>`, { wide: true });
    slotPicker($('#nbslots', m), { onPick: (p) => { pick = p; $('#nbgo', m).disabled = !p; } });
    $('#nb', m).onsubmit = async (e) => {
      e.preventDefault();
      const fd = Object.fromEntries(new FormData(e.target));
      $('#nbgo', m).disabled = true;
      try {
        const r = await sapi('adminBook', Object.assign({}, pick, { client: fd, adminNotes: fd.adminNotes }));
        closeModal(); toast('Booking created ✓ — confirmation email sent.'); refresh(); openAppt(r.id);
      } catch (ex) { $('#nbgo', m).disabled = false; toast(ex.message, true); }
    };
  }

  // ---- appointment detail ----
  async function openAppt(id) {
    const m = modal('Appointment', spinner(), { wide: true });
    try { renderAppt(m, await sapi('appointment', { id })); } catch (e) { $('.modal-body', m).innerHTML = `<div class="notice error">${esc(e.message)}</div>`; }
  }

  function renderAppt(m, d) {
    const a = d.appointment;
    const admin = isAdmin();
    const digits = String(a.clientMobile).replace(/\D/g, '');
    const waText = encodeURIComponent(`Hello ${String(a.clientName).split(' ')[0]}, this is ${a.doctorName} from Justlife Healthcare regarding your teleconsultation (${a.appointmentNo}).`);
    const editable = ['SCHEDULED', 'CALLING', 'COMPLETED', 'NO_SHOW'].includes(a.status);
    const services = S.me.upsellServices || [];
    const ustat = ['RECOMMENDED', 'INTERESTED', 'BOOKED', 'COMPLETED', 'NOT_INTERESTED'];
    $('.modal-head h2', m).innerHTML = `${esc(a.appointmentNo)} ${badge(a.status)}`;
    $('.modal-body', m).innerHTML = `
      <dl class="kv"><dt>When</dt><dd>${esc(fmtLong(a.date))} · ${esc(win(a))}</dd><dt>Doctor</dt><dd>${esc(a.doctorName)}</dd>
        <dt>Client</dt><dd>${esc(a.clientName)}</dd><dt>Mobile</dt><dd>${esc(a.clientMobile)}</dd><dt>Email</dt><dd>${esc(a.clientEmail)}</dd>
        <dt>Contact by</dt><dd>${esc(CONTACT[a.contactMethod])}</dd>${a.bookingRef ? `<dt>Justlife ref</dt><dd>${esc(a.bookingRef)}</dd>` : ''}
        ${a.clientNotes ? `<dt>Client note</dt><dd style="font-weight:400">${esc(a.clientNotes)}</dd>` : ''}
        ${a.callStartedAt ? `<dt>Call started</dt><dd>${esc(new Date(a.callStartedAt).toLocaleTimeString('en-GB', { timeZone: 'Asia/Dubai', hour: '2-digit', minute: '2-digit' }))} · ${Number(a.callDelayMin) <= S.me.toleranceMinutes ? 'on time' : `${esc(a.callDelayMin)} min late`}</dd>` : ''}
        ${a.outcome ? `<dt>Outcome</dt><dd>${esc(a.outcome)}</dd>` : ''}${a.cancelReason ? `<dt>Reason</dt><dd>${esc(a.cancelReason)}</dd>` : ''}</dl>
      ${a.files.length ? `<div class="section-title">Lab results</div><div class="row">${a.files.map((f) => `<button class="btn btn-sm" data-file="${esc(f.id)}">📎 ${esc(f.name)}</button>`).join('')}</div>` : ''}
      ${['SCHEDULED', 'CALLING'].includes(a.status) ? `<div class="section-title">Contact the client</div><div class="row">
        <a class="btn" href="tel:+${digits}">📞 Call ${esc(a.clientMobile)}</a><a class="btn" href="https://wa.me/${digits}?text=${waText}" target="_blank" rel="noopener">💬 WhatsApp</a>
        ${a.status === 'SCHEDULED' ? '<button class="btn btn-primary" data-act="start">Start consultation</button>' : ''}
        <button class="btn btn-danger" data-act="noshow">No show</button></div>` : ''}
      ${editable ? `<div class="section-title">Consultation notes</div><form id="notes" class="stack">
        <label class="field"><span class="label">Main issue *</span><textarea class="input" name="mainIssue">${esc(a.mainIssue)}</textarea></label>
        <label class="field"><span class="label">Assessment *</span><textarea class="input" name="assessment">${esc(a.assessment)}</textarea></label>
        <label class="field"><span class="label">Recommendation *</span><textarea class="input" name="recommendation">${esc(a.recommendation)}</textarea></label>
        <div class="grid grid-2"><label class="field"><span class="label">Further tests</span><input class="input" name="furtherTests" value="${esc(a.furtherTests)}"></label>
          <label class="field"><span class="label">Follow-up</span><input class="input" name="followUp" value="${esc(a.followUp)}"></label></div>
        <div class="row"><button class="btn" type="button" data-act="savenotes">Save notes</button>
          ${a.status === 'CALLING' || (admin && ['SCHEDULED', 'NO_SHOW'].includes(a.status)) ? '<button class="btn btn-green" type="button" data-act="complete">Complete consultation</button>' : ''}</div></form>` : ''}
      ${editable ? `<div class="section-title">Recommended services (upsells)</div>
        ${d.upsells.map((u) => `<div class="row" style="margin-bottom:8px" data-up="${esc(u.id)}"><b style="min-width:150px">${esc(u.service)}</b>
          <select class="input input-sm" data-u="status" style="width:auto">${ustat.map((s) => `<option ${s === u.status ? 'selected' : ''}>${s}</option>`).join('')}</select>
          <input class="input input-sm" data-u="bookedAmount" type="number" min="0" placeholder="Booked AED (rec. ${esc(u.recommendedAmount)})" value="${esc(u.bookedAmount)}" style="width:190px">
          <input class="input input-sm" data-u="bookingRef" placeholder="Booking ref" value="${esc(u.bookingRef)}" style="width:130px">
          <button class="btn btn-sm" data-act="upsave">Save</button><button class="btn btn-sm btn-danger" data-act="updel">Delete</button></div>`).join('') || '<p class="small muted">None yet.</p>'}
        <div class="row"><select class="input input-sm" id="usvc" style="width:auto">${services.map((s) => `<option value="${esc(s.name)}" data-amt="${s.amount}">${esc(s.name)}${s.amount ? ` (AED ${s.amount})` : ''}</option>`).join('')}</select>
          <select class="input input-sm" id="ustat" style="width:auto">${ustat.map((s) => `<option>${s}</option>`).join('')}</select>
          <button class="btn btn-sm" data-act="upadd">+ Add</button></div>` : ''}
      ${admin ? `<div class="section-title">Admin</div>
        <div class="row">${a.status === 'SCHEDULED' ? '<button class="btn" data-act="resched">Reschedule / change doctor</button>' : ''}
          ${['SCHEDULED', 'CALLING'].includes(a.status) ? '<button class="btn btn-danger" data-act="cancel">Cancel booking</button>' : ''}
          ${a.status === 'NO_SHOW' ? '<button class="btn" data-act="setsched">Back to scheduled</button>' : ''}
          ${d.rescheduleUrl ? '<button class="btn" data-act="copylink">Copy client reschedule link</button>' : ''}</div>
        <div id="reschedbox"></div>
        <label class="field" style="margin-top:12px"><span class="label">Internal note</span><textarea class="input" id="anotes">${esc(a.adminNotes)}</textarea></label>
        <button class="btn btn-sm" data-act="saveadmin" style="margin-top:8px">Save note</button>
        ${d.history.length || d.later.length ? `<div class="section-title">History</div>${d.history.concat(d.later).map((h) => `<div class="small">${badge(h.status)} ${esc(h.appointmentNo)} · ${esc(h.doctorName)} · ${esc(fmtDay(h.date))} ${esc(win(h))}</div>`).join('')}` : ''}
        ${d.log.length ? `<div class="section-title">Activity</div><div class="small">${d.log.map((l) => `<div>${esc(new Date(l.time).toLocaleString('en-GB', { timeZone: 'Asia/Dubai', dateStyle: 'short', timeStyle: 'short' }))} · <b>${esc(l.action)}</b> · ${esc(l.user)} ${l.details && l.details !== '""' ? `· ${esc(l.details)}` : ''}</div>`).join('')}</div>` : ''}` : ''}`;

    const act = (name, fn) => { const b = $(`[data-act="${name}"]`, m); if (b) b.onclick = async (e) => { e.preventDefault(); b.disabled = true; try { await fn(b); } catch (ex) { toast(ex.message, true); } b.disabled = false; }; };
    const reload = (d2, msg) => { if (msg) toast(msg); renderAppt(m, d2); if (S.view) route(); };
    const notes = () => Object.fromEntries(new FormData($('#notes', m)));
    act('start', async () => reload(await sapi('startCall', { id: a.id }), 'Consultation started — the on-time clock is recorded.'));
    act('noshow', async () => { if (!confirm('Mark this consultation as no-show?')) return; reload(await sapi('noShow', { id: a.id }), 'Marked as no-show.'); });
    act('savenotes', async () => reload(await sapi('saveNotes', { id: a.id, notes: notes() }), 'Notes saved ✓'));
    act('complete', async () => reload(await sapi('complete', { id: a.id, notes: notes() }), 'Consultation completed ✓'));
    act('upadd', async () => {
      const opt = $('#usvc', m).selectedOptions[0];
      if (!opt) return;
      reload(await sapi('addUpsell', { id: a.id, upsell: { service: opt.value, recommendedAmount: Number(opt.dataset.amt), status: $('#ustat', m).value } }), 'Service added ✓');
    });
    $$('[data-up]', m).forEach((rowEl) => {
      const val = (k) => $(`[data-u="${k}"]`, rowEl).value;
      $('[data-act="upsave"]', rowEl).onclick = async () => { try { reload(await sapi('updateUpsell', { id: a.id, upsellId: rowEl.dataset.up, upsell: { status: val('status'), bookedAmount: val('bookedAmount'), bookingRef: val('bookingRef') } }), 'Saved ✓'); } catch (ex) { toast(ex.message, true); } };
      $('[data-act="updel"]', rowEl).onclick = async () => { if (!confirm('Delete this service?')) return; try { reload(await sapi('deleteUpsell', { id: a.id, upsellId: rowEl.dataset.up }), 'Deleted.'); } catch (ex) { toast(ex.message, true); } };
    });
    $$('[data-file]', m).forEach((b) => {
      b.onclick = async () => {
        b.disabled = true;
        try {
          const f = await sapi('getFile', { appointmentId: a.id, fileId: b.dataset.file });
          const bytes = Uint8Array.from(atob(f.base64), (c) => c.charCodeAt(0));
          window.open(URL.createObjectURL(new Blob([bytes], { type: f.type })), '_blank');
        } catch (ex) { toast(ex.message, true); }
        b.disabled = false;
      };
    });
    act('cancel', async () => {
      const reason = prompt('Reason for cancelling (sent to the client):', '');
      if (reason === null) return;
      reload(await sapi('adminCancel', { id: a.id, reason }), 'Booking cancelled — client notified.');
    });
    act('setsched', async () => reload(await sapi('adminUpdate', { id: a.id, status: 'SCHEDULED' }), 'Back to scheduled.'));
    act('saveadmin', async () => reload(await sapi('adminUpdate', { id: a.id, adminNotes: $('#anotes', m).value }), 'Note saved ✓'));
    act('copylink', async () => copy(d.rescheduleUrl));
    act('resched', async () => {
      const box = $('#reschedbox', m);
      let pick = null;
      box.innerHTML = '<div class="card" style="margin-top:10px"><div id="rsp"></div><label class="field" style="margin-top:10px"><span class="label">Reason</span><input class="input" id="rsr"></label><button class="btn btn-primary" id="rsgo" style="margin-top:10px" disabled>Move booking</button></div>';
      slotPicker($('#rsp', box), { excludeId: a.id, doctorId: a.doctorId, onPick: (p) => { pick = p; $('#rsgo', box).disabled = !p; } });
      $('#rsgo', box).onclick = async (e) => {
        e.target.disabled = true;
        try { const r = await sapi('adminReschedule', Object.assign({ id: a.id, reason: $('#rsr', box).value }, pick)); toast('Rescheduled ✓ — client notified.'); route(); openAppt(r.id); } catch (ex) { e.target.disabled = false; toast(ex.message, true); }
      };
    });
  }

  // ---- admin: doctors ----
  const DAYS = [['sun', 'Sun'], ['mon', 'Mon'], ['tue', 'Tue'], ['wed', 'Wed'], ['thu', 'Thu'], ['fri', 'Fri'], ['sat', 'Sat']];
  async function viewDoctors() {
    const d = await sapi('doctors');
    S.cache.doctors = d.doctors;
    app.innerHTML = `<div class="row between"><h1>Doctors</h1><button class="btn btn-primary" data-act="add">+ Add doctor</button></div>
      <p class="muted small">Doctors sign in to this portal with the Google account in their <b>email</b> field (must be @${esc(CONFIG.ALLOWED_DOMAIN)}).</p>
      <div class="grid grid-2">${d.doctors.map((x) => `<div class="card doctor" data-doc="${esc(x.id)}">${avatar(x)}<div style="flex:1"><div class="row between"><h3 style="margin:0">${esc(x.name)}</h3>${badge(x.status)}</div>
        <div class="small muted">${esc(x.specialty)}${x.email ? ` · ${esc(x.email)}` : ''}</div>
        <div class="small" style="margin-top:6px">${DAYS.filter(([k]) => x[k]).map(([k, l]) => `<b>${l}</b> ${esc(x[k])}`).join(' · ') || '<span class="muted">No working hours set</span>'}</div>
        ${x.leaves.length ? `<div class="small" style="margin-top:4px;color:var(--amber)">Leave: ${x.leaves.map((l) => esc(l.from === l.to || !l.to ? l.from : `${l.from} → ${l.to}`)).join(', ')}</div>` : ''}</div></div>`).join('') || '<div class="empty card">No doctors yet.</div>'}</div>`;
    $('[data-act="add"]').onclick = () => doctorDialog({ status: 'ACTIVE', mon: '09:00-17:00', tue: '09:00-17:00', wed: '09:00-17:00', thu: '09:00-17:00', fri: '09:00-13:00', leaves: [] });
    $$('[data-doc]').forEach((el) => { el.onclick = () => doctorDialog(S.cache.doctors.find((x) => x.id === el.dataset.doc)); });
  }

  function doctorDialog(x) {
    const m = modal(x.id ? `Edit ${esc(x.name)}` : 'Add doctor', `<form id="df" class="stack">
      <div class="grid grid-2"><label class="field"><span class="label">Name *</span><input class="input" name="name" required value="${esc(x.name)}" placeholder="Dr. Sarah Ahmed"></label>
        <label class="field"><span class="label">Google sign-in email</span><input class="input" name="email" type="email" value="${esc(x.email)}" placeholder="name@${esc(CONFIG.ALLOWED_DOMAIN)}"></label></div>
      <div class="grid grid-3"><label class="field"><span class="label">Specialty</span><input class="input" name="specialty" value="${esc(x.specialty)}"></label>
        <label class="field"><span class="label">Languages</span><input class="input" name="languages" value="${esc(x.languages)}" placeholder="English, Arabic"></label>
        <label class="field"><span class="label">Years of experience</span><input class="input" name="experienceYears" type="number" min="0" value="${esc(x.experienceYears)}"></label></div>
      <label class="field"><span class="label">Short bio (shown to clients)</span><textarea class="input" name="bio">${esc(x.bio)}</textarea></label>
      <div class="grid grid-3"><label class="field"><span class="label">Phone</span><input class="input" name="phone" value="${esc(x.phone)}"></label>
        <label class="field"><span class="label">Photo URL (https)</span><input class="input" name="photoUrl" value="${esc(x.photoUrl)}"></label>
        <label class="field"><span class="label">Status</span><select class="input" name="status"><option value="ACTIVE">Active</option><option value="INACTIVE" ${x.status === 'INACTIVE' ? 'selected' : ''}>Inactive (hidden)</option></select></label></div>
      <div><span class="label">Working hours</span> <span class="hint">e.g. 09:00-13:00, 16:00-20:00 · empty = day off</span>
        <div class="stack" style="margin-top:8px">${DAYS.map(([k, l]) => `<div class="hours"><b>${l}</b><input class="input input-sm" name="${k}" value="${esc(x[k])}"></div>`).join('')}</div></div>
      <label class="field"><span class="label">Display order</span><input class="input input-sm" name="sortOrder" type="number" value="${esc(x.sortOrder || 0)}" style="width:100px"></label>
      <button class="btn btn-primary">Save doctor</button></form>
      ${x.id ? `<div class="section-title">Leave / holidays</div>
        ${x.leaves.map((l) => `<div class="row" style="margin-bottom:6px"><span>${esc(l.from)}${l.to && l.to !== l.from ? ` → ${esc(l.to)}` : ''} ${l.reason ? `· ${esc(l.reason)}` : ''}</span><button class="btn btn-sm btn-danger" data-leave="${esc(l.id)}">Remove</button></div>`).join('') || '<p class="small muted">No upcoming leave.</p>'}
        <div class="row"><input type="date" class="input input-sm" id="lf" style="width:auto"><input type="date" class="input input-sm" id="lt" style="width:auto"><input class="input input-sm" id="lr" placeholder="Reason" style="width:160px"><button class="btn btn-sm" id="ladd">Add leave</button></div>` : ''}`, { wide: true });
    $('#df', m).onsubmit = async (e) => {
      e.preventDefault();
      const doc = Object.assign({ id: x.id || '' }, Object.fromEntries(new FormData(e.target)));
      try {
        const r = await sapi('saveDoctor', { doctor: doc });
        closeModal();
        S.me = await sapi('me');
        toast('Doctor saved ✓');
        if (r.conflicts.length) toast(`${r.conflicts.length} upcoming booking(s) are now outside this doctor's hours: ${r.conflicts.map((c) => c.appointmentNo).join(', ')} — please reschedule them.`, true);
        refresh();
      } catch (ex) { toast(ex.message, true); }
    };
    const add = $('#ladd', m);
    if (add) {
      add.onclick = async () => {
        try {
          const r = await sapi('addLeave', { doctorId: x.id, from: $('#lf', m).value, to: $('#lt', m).value, reason: $('#lr', m).value });
          toast('Leave added ✓ — those days are no longer bookable.');
          if (r.conflicts.length) toast(`${r.conflicts.length} booking(s) fall on this leave: ${r.conflicts.map((c) => c.appointmentNo).join(', ')} — please reschedule them.`, true);
          closeModal(); refresh();
        } catch (ex) { toast(ex.message, true); }
      };
    }
    $$('[data-leave]', m).forEach((b) => { b.onclick = async () => { try { await sapi('removeLeave', { leaveId: b.dataset.leave }); toast('Leave removed.'); closeModal(); refresh(); } catch (ex) { toast(ex.message, true); } }; });
  }

  // ---- admin: booking links ----
  async function viewLinks() {
    const d = await sapi('links');
    const url = (t) => pageUrl('index.html', 't', t);
    app.innerHTML = `<h1>Booking links</h1><p class="muted">Create a secure link and send it to the client (WhatsApp, SMS or email). The client opens it to book.</p>
      <form id="lf" class="card toolbar">
        <label class="field"><span class="label small">Client / label (internal)</span><input class="input input-sm" name="label" placeholder="e.g. Ahmed — fatigue"></label>
        <label class="field"><span class="label small">Justlife booking ref</span><input class="input input-sm" name="bookingRef"></label>
        <label class="field"><span class="label small">Expires on <span class="muted">(optional)</span></span><input type="date" class="input input-sm" name="expiresOn"></label>
        <label class="check" style="align-self:center"><input type="checkbox" name="singleUse" checked><span>Single use</span></label>
        <button class="btn btn-primary">Create link</button></form>
      <div class="card" style="padding:0;margin-top:14px"><div class="table-wrap"><table class="list"><thead><tr><th>Created</th><th>Label</th><th>Ref</th><th>Type</th><th>Status</th><th>Bookings</th><th></th></tr></thead><tbody>
      ${d.links.map((l) => `<tr><td class="small">${esc(new Date(l.createdAt).toLocaleDateString('en-GB'))}<div class="muted">${esc(l.createdBy)}</div></td><td>${esc(l.label)}</td><td>${esc(l.bookingRef)}</td>
        <td class="small">${/true/i.test(l.singleUse) ? 'Single use' : 'Reusable'}${l.expiresOn ? `<div class="muted">until ${esc(l.expiresOn)}</div>` : ''}</td><td>${badge(l.liveStatus)}</td><td class="small">${esc(l.bookings.join(', '))}</td>
        <td><div class="row"><button class="btn btn-sm" data-copy="${esc(l.token)}">Copy link</button>
          ${l.status === 'CANCELLED' ? `<button class="btn btn-sm" data-on="${esc(l.token)}">Reactivate</button>` : `<button class="btn btn-sm btn-danger" data-off="${esc(l.token)}">Cancel</button>`}</div></td></tr>`).join('') || '<tr><td colspan="7" class="empty">No links yet.</td></tr>'}
      </tbody></table></div></div>`;
    $('#lf').onsubmit = async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      try {
        const r = await sapi('createLink', { label: fd.get('label'), bookingRef: fd.get('bookingRef'), expiresOn: fd.get('expiresOn'), singleUse: fd.get('singleUse') === 'on' });
        await copy(url(r.token));
        modal('Booking link created', `<p>Send this link to the client:</p><div class="row"><input class="input" readonly value="${esc(url(r.token))}" style="flex:1"><button class="btn" data-close>Done</button></div>`);
        refresh();
      } catch (ex) { toast(ex.message, true); }
    };
    $$('[data-copy]').forEach((b) => { b.onclick = () => copy(url(b.dataset.copy)); });
    $$('[data-off]').forEach((b) => { b.onclick = async () => { await sapi('setLinkStatus', { token: b.dataset.off, status: 'CANCELLED' }); refresh(); }; });
    $$('[data-on]').forEach((b) => { b.onclick = async () => { await sapi('setLinkStatus', { token: b.dataset.on, status: 'ACTIVE' }); refresh(); }; });
  }

  // ---------------------------------------------------------------------------
  const page = document.body.dataset.page;
  if (page === 'client') clientInit();
  else if (page === 'staff') staffInit();
}());
