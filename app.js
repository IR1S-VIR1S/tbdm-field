/* TBDM Field App v1.0. Offline data entry for the LGH TB-DM cohort.
 * Entries are kept on the phone, encrypted with a key made from the user's PIN, and sent to the
 * study workbook (TBDM_DataSystem.gs web app) whenever the phone is online. The rules, codes and
 * calculations come from logic.js, which build.js copies from the workbook script itself. */
'use strict';
const APP_VERSION = '1.0';
const IDLE_LOCK_MS = 5 * 60 * 1000;
const PBKDF2_ROUNDS = 210000;
const NAMES = { S0_SCREEN: 'Screening', S1_ENROL: 'Enrolment', S2_BASELINE: 'Baseline examination', S3_CXR: 'Chest radiograph',
  LABS: 'Laboratory results', VISITS: 'Visit', SPIRO: 'Spirometry', PHQ_GAD: 'PHQ-9 and GAD-7', EVENTS: 'Event',
  END_STUDY: 'End of study', QC_LOG: 'Verification check', R_SCORES: 'Radiograph score' };
const BY_FIELDS = ['entered_by', 'screened_by', 'examined_by', 'recorded_by', 'interviewer', 'operator', 'checker', 'reader_initials'];
const LAB_GROUPS = [
  ['Sample', ['sample_date', 'time_drawn', 'time_analysed', 'fasting', 'symptomatic', 'lab_status', 'analyser_id', 'source_report_no'], null],
  ['Blood count', ['hb', 'tlc', 'neut_abs', 'neut_pct', 'lymph_abs', 'lymph_pct', 'mono_abs', 'eos_pct', 'plt', 'rdw', 'mpv'], ['V1', 'V3', 'V5']],
  ['HbA1c', ['hba1c_unit', 'hba1c'], ['V1', 'V4', 'V5']],
  ['Glucose and lipids (fasting)', ['glucose_unit', 'fpg', 'lipid_unit', 'tg', 'hdl', 'tc', 'ldl'], ['V1']],
  ['Liver tests', ['alt', 'alt_uln', 'ast', 'alp', 'tbili', 'bili_uln', 'albumin', 'tprotein'], ['V1', 'V2', 'V3', 'V5', 'U']],
  ['Serology', ['hbsag', 'anti_hcv', 'hiv'], ['V1']],
  ['Entered by', ['entered_by'], null]];
const VISIT_FORMS = { V1: [['S2_BASELINE'], ['LABS', 'V1'], ['PHQ_GAD', 'V1'], ['S3_CXR']], V2: [['VISITS', 'V2'], ['LABS', 'V2']],
  V3: [['VISITS', 'V3'], ['LABS', 'V3']], V4: [['VISITS', 'V4'], ['LABS', 'V4']],
  V5: [['VISITS', 'V5'], ['LABS', 'V5'], ['SPIRO'], ['PHQ_GAD', 'V5'], ['END_STUDY']] };

let S = null;          // decrypted state: { cfg, server, outbox, lastSync }
let KEY = null;        // AES key, in memory only while unlocked
const T = { nav: [], syncing: false, syncError: '', idle: null, hiddenAt: 0, salt: null, pin: '', join: null, form: null };

// ------------------------------------------------------------------ small helpers
const $ = (s) => document.querySelector(s);
function el(tag, props, ...kids) {
  const e = document.createElement(tag);
  if (props) Object.keys(props).forEach((k) => {
    const v = props[k];
    if (k === 'class') e.className = v;
    else if (k.slice(0, 2) === 'on') e.addEventListener(k.slice(2), v);
    else if (v === true) e.setAttribute(k, '');
    else if (v !== false && v !== null && v !== undefined) e.setAttribute(k, v);
  });
  kids.flat(Infinity).forEach((k) => { if (k !== null && k !== undefined && k !== false) e.append(k instanceof Node ? k : document.createTextNode(String(k))); });
  return e;
}
const s_ = (v) => (v === null || v === undefined ? '' : String(v).trim());
const pad2 = (n) => (n < 10 ? '0' : '') + n;
function todayIso() { const d = new Date(); return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }
function nowHm() { const d = new Date(); return pad2(d.getHours()) + ':' + pad2(d.getMinutes()); }
function rid() { const a = new Uint8Array(12); crypto.getRandomValues(a); return Array.from(a, (b) => b.toString(16).padStart(2, '0')).join(''); }
function ago(ms) { const m = Math.round((Date.now() - ms) / 60000); if (m < 1) return 'just now'; if (m < 60) return m + ' min ago'; const h = Math.round(m / 60); return h < 48 ? h + ' h ago' : Math.round(h / 24) + ' days ago'; }
function toast(msg) { const t = el('div', { class: 'toast', role: 'status' }, msg); document.body.append(t); setTimeout(() => t.remove(), 2600); }
const defs = () => SCHEMA.concat([READER]);
const defOf = (tab) => defs().filter((t) => t.tab === tab)[0];

// ------------------------------------------------------------------ storage and encryption
function idb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open('tbdm-field', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
}
async function kv(mode, fn) { const db = await idb(); return new Promise((res, rej) => { const tx = db.transaction('kv', mode); const q = fn(tx.objectStore('kv')); tx.oncomplete = () => res(q && q.result); tx.onerror = () => rej(tx.error); }); }
const kvGet = (k) => kv('readonly', (s) => s.get(k));
const kvSet = (k, v) => kv('readwrite', (s) => s.put(v, k));
const kvDel = (k) => kv('readwrite', (s) => s.delete(k));
async function deriveKey(pin, salt) {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(pin), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: PBKDF2_ROUNDS, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
async function saveState() {
  if (!S || !KEY) return;
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, KEY, new TextEncoder().encode(JSON.stringify(S)));
  await kvSet('vault', { v: 1, salt: T.salt, iv, ct });
}
async function openVault(pin) {
  const vault = await kvGet('vault');
  const key = await deriveKey(pin, vault.salt);
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: vault.iv }, key, vault.ct);
  T.salt = vault.salt; KEY = key; S = JSON.parse(new TextDecoder().decode(pt));
}

// ------------------------------------------------------------------ data: server snapshot plus unsent changes
function serverRows(tab) {
  const t = S && S.server && S.server.tabs[tab];
  if (!t) return [];
  return t.rows.map((r) => { const o = {}; t.cols.forEach((k, i) => { o[k] = r[i]; }); return o; });
}
function sameRec(tab, a, b) {
  const serial = APP_SERIAL[tab];
  if (serial && !s_(a[serial]) && !s_(b[serial])) return !!a._rid && a._rid === b._rid;
  return APP_KEYS[tab].every((k) => s_(a[k]).toUpperCase() === s_(b[k]).toUpperCase() && s_(a[k]) !== '');
}
function view(tab) {
  const rows = serverRows(tab);
  rows.forEach((r, i) => { r._row = i + 2; });
  S.outbox.filter((c) => c.tab === tab).forEach((c) => {
    const probe = Object.assign({ _rid: c.rid }, c.values);
    let row = rows.filter((r) => sameRec(tab, r, probe))[0];
    if (!row) { row = { _local: true, _row: rows.length + 2 }; rows.push(row); }
    Object.assign(row, c.values);
    row._pending = c.status; row._cid = c.cid; if (c.rid) row._rid = c.rid;
  });
  return rows;
}
function data() { const d = {}; SCHEMA.forEach((t) => { d[t.tab] = view(t.tab); }); return d; }
function derived() { return computeDerived_(data(), todayIso()); }
function enrolledMap() { const m = {}; view('S1_ENROL').forEach((r) => { if (r.study_id) m[s_(r.study_id).toUpperCase()] = true; }); return m; }
function find(tab, key) { return view(tab).filter((r) => sameRec(tab, r, key))[0] || null; }
function serverValue(tab, key, k) { const r = serverRows(tab).filter((x) => sameRec(tab, x, key))[0]; return r ? s_(r[k]) : null; }

function queueSave(tab, existing, values) {
  const serial = APP_SERIAL[tab], keys = APP_KEYS[tab];
  const changed = {};
  Object.keys(values).forEach((k) => { if (s_(values[k]) !== s_(existing ? existing[k] : '')) changed[k] = s_(values[k]); });
  const probe = Object.assign({ _rid: existing && existing._rid }, existing || {}, values);
  let entry = S.outbox.filter((c) => c.tab === tab && sameRec(tab, Object.assign({ _rid: c.rid }, c.values), probe))[0];
  if (!Object.keys(changed).length && !(entry && entry.status !== 'pending')) return null;
  const onServer = existing && !existing._local && serverRows(tab).some((r) => sameRec(tab, r, probe));
  if (!entry) {
    entry = { cid: rid(), tab, create: !onServer, values: {}, base: {}, by: S.cfg.initials, at: Date.now(), rev: 0, status: 'pending' };
    if (serial && !s_(probe[serial])) entry.rid = (existing && existing._rid) || rid();
    keys.forEach((k) => { if (s_(probe[k])) entry.values[k] = s_(probe[k]); });
    S.outbox.push(entry);
  }
  Object.keys(changed).forEach((k) => {
    entry.values[k] = changed[k];
    if (onServer && !(k in entry.base)) entry.base[k] = serverValue(tab, probe, k);
  });
  if (entry.status !== 'pending') {          // the user has looked at the problem and saved again
    Object.keys(entry.values).forEach((k) => { if (onServer) entry.base[k] = serverValue(tab, probe, k); });
    entry.status = 'pending'; delete entry.errors; entry.create = !onServer;
  }
  entry.rev++; entry.at = Date.now();
  return entry;
}

// ------------------------------------------------------------------ server
async function api(body) {
  const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 45000);
  try {
    const r = await fetch(S ? S.cfg.api : T.join.api, { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      signal: ctl.signal, redirect: 'follow', credentials: 'omit', cache: 'no-store' });
    return await r.json();
  } finally { clearTimeout(timer); }
}
async function sync() {
  if (!S || T.syncing) return;
  if (!navigator.onLine) { T.syncError = 'offline'; paintSync(); return; }
  T.syncing = true; paintSync();
  try {
    const pending = S.outbox.filter((c) => c.status === 'pending');
    for (let i = 0; i < pending.length; i += 50) {
      const batch = pending.slice(i, i + 50).map((c) => ({ cid: c.cid, tab: c.tab, rid: c.rid, create: c.create, values: c.values, base: c.base, by: c.by }));
      const revs = {}; pending.slice(i, i + 50).forEach((c) => { revs[c.cid] = c.rev; });
      const res = await api({ op: 'push', token: S.cfg.token, changes: batch });
      if (!res.ok) throw Object.assign(new Error(res.error || 'the server refused'), { code: res.code });
      res.results.forEach((r) => {
        const c = S.outbox.filter((x) => x.cid === r.cid)[0];
        if (!c || c.rev !== revs[r.cid]) return;                       // changed again while sending: send again next time
        if (r.status === 'ok') S.outbox.splice(S.outbox.indexOf(c), 1);
        else { c.status = r.status; c.errors = r.errors; }
      });
      await saveState();
    }
    const pull = await api({ op: 'pull', token: S.cfg.token });
    if (!pull.ok) throw Object.assign(new Error(pull.error || 'the server refused'), { code: pull.code });
    S.server = { tabs: pull.tabs, films: pull.films || [], at: Date.now() };
    S.cfg.role = pull.role; S.cfg.email = pull.email;
    S.lastSync = Date.now(); T.syncError = ''; T.revoked = false;
    await saveState();
  } catch (e) {
    T.syncError = e.name === 'AbortError' ? 'timed out' : (e.message || 'failed');
    if (e.code === 401) T.revoked = true;
  } finally {
    T.syncing = false;
    if (T.form && T.form.dirty) paintSync(); else render();
  }
}

// ------------------------------------------------------------------ locking
function bumpIdle() { clearTimeout(T.idle); if (KEY) T.idle = setTimeout(lock, IDLE_LOCK_MS); }
function lock() { KEY = null; S = null; T.form = null; T.reg = null; T.nav = []; T.pin = ''; clearTimeout(T.idle); render(); }
['pointerdown', 'keydown'].forEach((ev) => document.addEventListener(ev, bumpIdle, { passive: true }));
document.addEventListener('visibilitychange', () => {
  if (document.hidden) T.hiddenAt = Date.now();
  else if (KEY && T.hiddenAt && Date.now() - T.hiddenAt > IDLE_LOCK_MS) lock();
});
window.addEventListener('online', () => { paintSync(); sync(); });
window.addEventListener('offline', paintSync);
setInterval(() => { if (KEY && navigator.onLine && !T.syncing && S.outbox.some((c) => c.status === 'pending')) sync(); }, 120000);

// ------------------------------------------------------------------ navigation
function go(name, p) { T.nav.push({ name, p: p || {} }); T.form = null; render(); window.scrollTo(0, 0); }
function back() { T.nav.pop(); T.form = null; render(); window.scrollTo(0, 0); }
function cur() { return T.nav[T.nav.length - 1] || { name: 'home', p: {} }; }
function confirmLeave(fn) {
  if (T.form && T.form.dirty) return modal('Leave without saving?', [el('p', null, 'Your changes on this screen have not been saved.')],
    [['Stay', null], ['Discard changes', fn, 'danger']]);
  fn();
}

// ------------------------------------------------------------------ rendering
function render() {
  const app = $('#app');
  app.replaceChildren();
  if (!KEY) { app.append(T.hasVault ? lockScreen() : setupScreen()); return; }
  const c = cur(), screens = { home: home, participants: participants, participant: participant, form: formScreen, due: due,
    queries: queries, attention: attention, films: films, settings: settings, screening: screening, qclog: qclog, register: registerScreen };
  const body = (screens[c.name] || home)(c.p);
  app.append(...body);
}
function topBar(title, opts) {
  opts = opts || {};
  const bar = el('header', { class: 'top' },
    T.nav.length ? el('button', { class: 'back', 'aria-label': 'Back', onclick: () => confirmLeave(back) }, '‹ Back') : null,
    el('h1', null, title),
    opts.noMenu ? null : el('button', { class: 'icon', 'aria-label': 'Lock', onclick: () => confirmLeave(lock) }, 'Lock'));
  return [bar, el('div', { id: 'syncbar' }, syncBar())];
}
function syncBar() {
  const n = S.outbox.filter((c) => c.status === 'pending').length, bad = S.outbox.filter((c) => c.status !== 'pending').length;
  const online = navigator.onLine;
  const text = T.syncing ? 'Sending and updating…' : T.revoked ? 'This phone no longer has access. Tell the PI.'
    : (online ? 'Online' : 'Offline') + ' · ' + (n ? n + ' waiting to send' : 'all sent') + (bad ? ' · ' + bad + ' need fixing' : '')
      + (S.lastSync ? ' · updated ' + ago(S.lastSync) : ' · never updated') + (T.syncError && T.syncError !== 'offline' ? ' · last try: ' + T.syncError : '');
  return el('div', { class: 'sync ' + (online ? 'on' : 'off') }, el('span', { class: 'dot' }), el('span', { class: 'grow' }, text),
    el('button', { onclick: () => sync(), disabled: T.syncing || !online }, 'Sync'));
}
function paintSync() { const b = $('#syncbar'); if (b && S) b.replaceChildren(syncBar()); }
function modal(title, body, actions, stop) {
  const m = $('#modal');
  const close = () => { m.hidden = true; m.replaceChildren(); };
  m.replaceChildren(el('div', { class: 'sheet' + (stop ? ' stop' : ''), role: 'alertdialog', 'aria-modal': 'true' }, el('h3', null, title), body,
    el('div', { class: 'acts' }, actions.map((a) => el('button', { class: 'btn ' + (a[2] || ''), onclick: () => { close(); if (a[1]) a[1](); } }, a[0])))));
  m.hidden = false;
}

// ------------------------------------------------------------------ setup and lock screens
function setupScreen() {
  if (!T.join) {
    return el('div', { class: 'lock' }, el('h1', null, 'TBDM Field App'),
      el('p', null, 'Open the invitation link the principal investigator sent you, on this phone, to set it up.'),
      el('p', { class: 'small' }, 'No study data are stored until you join.'));
  }
  const ini = el('input', { type: 'text', maxlength: '10', autocomplete: 'off', autocapitalize: 'characters', placeholder: 'e.g. AG' });
  const p1 = el('input', { type: 'password', inputmode: 'numeric', maxlength: '12', autocomplete: 'new-password', placeholder: '6 digits or more' });
  const p2 = el('input', { type: 'password', inputmode: 'numeric', maxlength: '12', autocomplete: 'new-password' });
  const msg = el('div', { class: 'msg' });
  const btn = el('button', { class: 'btn primary block', onclick: async () => {
    msg.textContent = '';
    const i = s_(ini.value).toUpperCase(), a = p1.value, b = p2.value;
    if (!/^[A-Z.]{2,10}$/.test(i)) { msg.textContent = 'Enter your initials (letters only).'; return; }
    if (!/^\d{6,12}$/.test(a)) { msg.textContent = 'Choose a PIN of 6 to 12 digits.'; return; }
    if (a !== b) { msg.textContent = 'The two PINs do not match.'; return; }
    if (/^(\d)\1+$/.test(a) || '0123456789012'.includes(a) || '9876543210987'.includes(a)) { msg.textContent = 'Choose a PIN that is not a repeated or running sequence.'; return; }
    if (!navigator.onLine) { msg.textContent = 'Joining needs the internet once. Connect and try again.'; return; }
    btn.disabled = true; btn.textContent = 'Joining…';
    try {
      const res = await api({ op: 'join', code: T.join.code, device: navigator.userAgent.slice(0, 60) });
      if (!res.ok) throw new Error(res.error || 'joining failed');
      T.salt = crypto.getRandomValues(new Uint8Array(16)); KEY = await deriveKey(a, T.salt);
      S = { cfg: { api: T.join.api, token: res.token, email: res.email, role: res.role, initials: i, joined: Date.now() }, server: null, outbox: [], lastSync: 0 };
      await saveState(); T.hasVault = true; T.join = null;
      if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
      bumpIdle(); render(); sync();
    } catch (e) { msg.textContent = e.message; btn.disabled = false; btn.textContent = 'Join'; }
  } }, 'Join');
  return el('div', { class: 'setup' }, el('h2', null, 'Join the TB-DM study'),
    el('div', { class: 'card' }, el('p', { class: 'small muted' }, 'This phone will keep study entries, encrypted, until they are sent. Never type a name, CNIC, telephone number, address or MRN anywhere in this app.')),
    el('div', { class: 'field' }, el('label', { class: 'lab' }, 'Your initials'), el('div', { class: 'hint' }, 'Recorded with every entry you make.'), ini),
    el('div', { class: 'field' }, el('label', { class: 'lab' }, 'Choose a PIN'), el('div', { class: 'hint' }, 'Unlocks the app and encrypts its data. If you forget it, the phone must be reset and anything not yet sent is lost.'), p1),
    el('div', { class: 'field' }, el('label', { class: 'lab' }, 'Type the PIN again'), p2, msg), btn);
}
function lockScreen() {
  const fails = +(localStorage.getItem('tbdm-fails') || 0), until = +(localStorage.getItem('tbdm-wait') || 0);
  const dots = el('div', { class: 'dots' }, [0, 1, 2, 3, 4, 5].map((i) => el('i', { class: i < T.pin.length ? 'f' : '' })));
  const err = el('div', { class: 'err', role: 'alert' }, T.lockMsg || '');
  const press = async (d) => {
    if (Date.now() < until) { T.lockMsg = 'Too many wrong PINs. Wait ' + Math.ceil((until - Date.now()) / 1000) + ' s.'; render(); return; }
    if (d === 'del') T.pin = T.pin.slice(0, -1); else if (d === 'ok') { await tryPin(); return; } else if (T.pin.length < 12) T.pin += d;
    T.lockMsg = ''; render();
  };
  const tryPin = async () => {
    if (T.pin.length < 6) { T.lockMsg = 'At least 6 digits.'; render(); return; }
    const pin = T.pin; T.pin = ''; T.lockMsg = 'Opening…'; render();
    try {
      await openVault(pin); localStorage.setItem('tbdm-fails', '0'); T.lockMsg = ''; T.nav = []; bumpIdle(); render(); sync();
    } catch (e) {
      const f = fails + 1; localStorage.setItem('tbdm-fails', String(f));
      if (f >= 5) localStorage.setItem('tbdm-wait', String(Date.now() + Math.min(3600, Math.pow(2, f - 4) * 15) * 1000));
      T.lockMsg = 'Wrong PIN.'; render();
    }
  };
  const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'del', '0', 'ok'];
  return el('div', { class: 'lock' }, el('h1', null, 'TBDM Field App'),
    el('p', null, T.join ? 'An invitation link was opened, but this phone is already set up. Unlock, then reset the phone in Settings to use it.' : 'Enter your PIN'),
    dots, el('div', { class: 'pad' }, keys.map((k) => el('button', { class: k.length > 1 ? 'txt' : '', 'aria-label': k === 'del' ? 'Delete' : k === 'ok' ? 'Unlock' : k, onclick: () => press(k) },
      k === 'del' ? 'Delete' : k === 'ok' ? 'Unlock' : k))), err);
}

// ------------------------------------------------------------------ home and lists
function role() { return S.cfg.role || 'data'; }
const canData = () => role() === 'data' || role() === 'pi';
function home() {
  if (role() === 'dots') return registerScreen();
  if (!S.server) return topBar('TBDM Field').concat([el('main', null, el('div', { class: 'card' }, navigator.onLine ? 'Fetching the study data…' : 'Connect to the internet once to fetch the study data.'))]);
  if (role() === 'reader1' || role() === 'reader2') return films();
  const out = derived(), bad = S.outbox.filter((c) => c.status !== 'pending'), waiting = S.outbox.filter((c) => c.status === 'pending');
  const oldest = waiting.reduce((m, c) => Math.min(m, c.at), Infinity);
  const dueN = out.schedule.filter((r) => r[5] !== 'upcoming').length;
  const main = el('main', null,
    bad.length ? el('button', { class: 'card alert row', onclick: () => go('attention') }, el('div', { class: 'main' }, el('div', null, bad.length + ' entr' + (bad.length > 1 ? 'ies need' : 'y needs') + ' fixing'), el('div', { class: 'sub' }, 'The workbook did not accept them. Tap to see why.')), el('span', { class: 'chev' })) : null,
    waiting.length && Date.now() - oldest > 864e5 ? el('div', { class: 'card warn' }, el('b', null, 'Entries have waited more than a day.'), el('div', { class: 'small' }, 'Connect to the internet and press Sync. Until then they exist only on this phone.')) : null,
    el('div', { class: 'tiles' },
      canData() ? el('button', { class: 'tile primary', onclick: () => go('form', { tab: 'S0_SCREEN', key: {} }) }, el('b', null, 'Screen a patient'), el('span', null, 'Add a screening line')) : null,
      canData() ? el('button', { class: 'tile primary', onclick: () => go('form', { tab: 'S1_ENROL', key: {} }) }, el('b', null, 'Enrol'), el('span', null, 'New study number')) : null,
      el('button', { class: 'tile', onclick: () => go('participants') }, el('b', null, 'Participants'), el('span', null, Object.keys(enrolledMap()).length + ' enrolled')),
      el('button', { class: 'tile', onclick: () => go('due') }, el('b', null, 'Due and overdue'), el('span', null, dueN + ' visit' + (dueN === 1 ? '' : 's'))),
      el('button', { class: 'tile', onclick: () => go('queries') }, el('b', null, 'Queries'), el('span', null, out.queries.length + ' to check')),
      el('button', { class: 'tile', onclick: () => go('screening') }, el('b', null, 'Screening log'), el('span', null, view('S0_SCREEN').length + ' screened')),
      role() === 'qc' || role() === 'pi' ? el('button', { class: 'tile', onclick: () => go('qclog') }, el('b', null, 'Verification log'), el('span', null, view('QC_LOG').length + ' checks')) : null,
      role() === 'pi' ? el('button', { class: 'tile', onclick: () => go('register') }, el('b', null, 'Study numbers'), el('span', null, 'Assign or look up')) : null,
      el('button', { class: 'tile', onclick: () => go('settings') }, el('b', null, 'Settings'), el('span', null, S.cfg.email || ''))),
    el('h2', null, 'Safety'),
    el('div', { class: 'card small' }, 'PHQ-9 item 9 above 0, or a liver result meeting the definition: act the same day (manual Part 4). The app and the e-mail alerts are only a backup.'));
  return topBar('TBDM Field').concat([main]);
}
// ---- study numbers register (PI and DOTS incharge). Online only. Nothing about it is kept on the phone.
const REG_STATUS_OPTS = [['E', 'Enrolled'], ['D', 'Declined'], ['S', 'Spoiled']];
function regState() { return T.reg || (T.reg = { list: null, loading: false, err: '', done: '', busy: false, status: 'E', age: '', sex: '', reason: '', pendingRid: null, q: '' }); }
async function regLoad() {
  const st = regState();
  st.err = '';
  if (!navigator.onLine) { st.err = 'No internet connection. The numbers register works only online.'; render(); return; }
  st.loading = true; render();
  try {
    const res = await api({ op: 'register_list', token: S.cfg.token });
    if (!res.ok) throw new Error(res.error || 'could not load');
    st.list = res;
  } catch (e) { st.err = 'Could not load the register. ' + e.message; }
  st.loading = false; render();
}
async function regAssign() {
  const st = regState();
  if (st.busy) return;
  if (!navigator.onLine) { st.err = 'No internet connection. Nothing was assigned.'; render(); return; }
  st.pendingRid = st.pendingRid || rid();              // the same id on a retry, so a number is never assigned twice
  const body = { op: 'register_add', token: S.cfg.token, rid: st.pendingRid, status: st.status, age: st.age, sex: st.sex, reason: st.reason };
  st.busy = true; st.err = ''; st.done = ''; render();
  try {
    const res = await api(body);
    if (!res.ok) throw new Error(res.error || 'not assigned');
    st.done = (res.again ? 'Already assigned: ' : 'Assigned: ') + res.study_id;
    st.pendingRid = null; st.age = ''; st.sex = ''; st.reason = ''; st.status = 'E';
  } catch (e) { st.err = 'Not assigned. ' + e.message + ' Check the connection and press Assign again.'; }
  st.busy = false;
  await regLoad();
}
function registerScreen() {
  const st = regState();
  if (st.list === null && !st.loading && !st.err && navigator.onLine) regLoad();
  const L = st.list, rows = L ? L.rows : [], q = st.q.trim().toUpperCase();
  const shown = q ? rows.filter((r) => r.study_id.indexOf(q) >= 0) : rows;
  const seg = (opts, cur, set) => el('div', { class: 'seg' }, opts.map((o) => el('button', { type: 'button', class: cur === o[0] ? 'on' : '', onclick: () => { set(o[0]); render(); } }, o[1])));
  const spoiled = st.status === 'S';
  const off = !navigator.onLine;
  return topBar('Study numbers').concat([el('main', null,
    el('div', { class: 'card small muted' }, 'Study numbers only. No names, addresses, telephone numbers or record numbers are entered or shown here. Those stay on paper in the locked cabinet.'),
    off ? el('div', { class: 'card warn' }, el('b', null, 'No internet connection.'), el('div', { class: 'small' }, 'This works only online. Nothing is stored on this phone.')) : null,
    st.err ? el('div', { class: 'card alert' }, st.err) : null,
    st.done ? el('div', { class: 'card' }, el('b', null, st.done)) : null,
    el('div', { class: 'card' },
      el('div', { class: 'muted small' }, 'Next free number'),
      el('div', { style: 'font-size:28px;font-weight:700' }, L ? L.next : (st.loading ? 'loading…' : '–')),
      el('button', { class: 'btn block', type: 'button', disabled: off || st.loading, onclick: () => regLoad() }, 'Refresh')),
    el('h2', null, 'Assign a number'),
    el('div', { class: 'field' }, el('label', { class: 'lab' }, 'Outcome'), seg(REG_STATUS_OPTS, st.status, (v) => { st.status = v; })),
    spoiled ? null : el('div', { class: 'field' }, el('label', { class: 'lab' }, 'Age in years'),
      el('input', { type: 'text', inputmode: 'numeric', maxlength: '3', value: st.age, oninput: (ev) => { st.age = ev.target.value.replace(/\D/g, ''); } })),
    spoiled ? null : el('div', { class: 'field' }, el('label', { class: 'lab' }, 'Sex'), seg([['M', 'Male'], ['F', 'Female']], st.sex, (v) => { st.sex = v; })),
    spoiled ? el('div', { class: 'field' }, el('label', { class: 'lab' }, 'Reason the number is spoiled'),
      el('input', { type: 'text', maxlength: '80', value: st.reason, oninput: (ev) => { st.reason = ev.target.value; } })) : null,
    el('button', { class: 'btn primary block', type: 'button', disabled: off || st.busy || !L, onclick: () => regAssign() }, st.busy ? 'Assigning…' : 'Assign number'),
    el('h2', null, 'Look up a number'),
    el('input', { class: 'search', type: 'search', placeholder: 'Type a number, e.g. TBDM-012', autocomplete: 'off', value: st.q,
      oninput: (ev) => { st.q = ev.target.value; render(); } }),
    el('div', { class: 'list' }, shown.length ? shown.map((r) => el('div', { class: 'row' }, el('div', { class: 'main' },
      el('div', null, r.study_id),
      el('div', { class: 'sub' }, [r.status && ({ E: 'enrolled', D: 'declined', S: 'spoiled' })[r.status] || r.status, r.age && r.sex ? r.age + ' y, ' + r.sex : '', r.assigned_date].filter(Boolean).join(' · ')) )))
      : el('div', { class: 'empty' }, L ? 'No numbers match.' : (st.loading ? 'Loading…' : ''))))
  ]);
}

function participants() {
  const out = derived(), next = {};
  out.schedule.forEach((r) => { if (!next[r[0]]) next[r[0]] = r; });
  const ends = {}; view('END_STUDY').forEach((r) => { ends[r.study_id] = r.status; });
  const q = el('input', { class: 'search', type: 'search', placeholder: 'Search study number', autocomplete: 'off' });
  const list = el('div', { class: 'list' });
  const fill = () => {
    const f = s_(q.value).toUpperCase();
    const rows = view('S1_ENROL').filter((r) => r.study_id && s_(r.study_id).toUpperCase().includes(f)).sort((a, b) => (a.study_id < b.study_id ? -1 : 1));
    list.replaceChildren(...(rows.length ? rows.map((r) => {
      const n = next[r.study_id], end = ends[r.study_id];
      return el('button', { class: 'row', onclick: () => go('participant', { sid: r.study_id }) },
        el('div', { class: 'main' }, el('div', null, r.study_id), el('div', { class: 'sub' }, 'ATT from ' + (r.att_start_date || '?') + ' · diabetes ' + ({ K: 'known', N: 'new', 0: 'no' }[r.dm_status] || 'not recorded'))),
        end ? el('span', { class: 'chip' }, { C: 'completed', W: 'withdrawn', L: 'lost', X: 'transferred', D: 'died' }[end]) : n ? el('span', { class: 'chip ' + (n[5] === 'overdue' ? 'bad' : n[5] === 'due now' ? 'warn' : '') }, n[1] + ' ' + n[5]) : null,
        r._pending ? el('span', { class: 'chip ' + (r._pending === 'pending' ? 'pend' : 'bad') }, r._pending === 'pending' ? 'unsent' : 'fix') : null, el('span', { class: 'chev' }));
    }) : [el('div', { class: 'empty' }, 'No participants')]));
  };
  q.addEventListener('input', fill); fill();
  return topBar('Participants').concat([el('main', null, q, list)]);
}
function statusChip(row) {
  if (!row) return el('span', { class: 'chip' }, 'not entered');
  if (row._pending === 'pending') return el('span', { class: 'chip pend' }, 'waiting to send');
  if (row._pending) return el('span', { class: 'chip bad' }, 'needs fixing');
  return el('span', { class: 'chip ok' }, 'in workbook');
}
function participant(p) {
  const sid = p.sid, out = derived(), e = find('S1_ENROL', { study_id: sid });
  if (!e) return topBar(sid).concat([el('main', null, el('div', { class: 'card' }, 'This study number is not in the workbook (it may have been withdrawn).'))]);
  const dp = out.participant.filter((r) => r[0] === sid)[0] || [];
  const dpk = DERIVED.DERIVED_PARTICIPANT.map((x) => x[0]), D = {}; dpk.forEach((k, i) => { D[k] = dp[i]; });
  const d0 = dayNo_(e.att_start_date), today = dayNo_(todayIso()), sched = {};
  out.schedule.filter((r) => r[0] === sid).forEach((r) => { sched[r[1]] = r[5]; });
  const optQ = e.optout_questionnaires === 'Y', optS = e.optout_spirometry === 'Y';
  const formRow = (tab, visit) => {
    if ((tab === 'PHQ_GAD' && optQ) || (tab === 'SPIRO' && optS)) return el('div', { class: 'row' }, el('div', { class: 'main' }, el('div', null, NAMES[tab]), el('div', { class: 'sub' }, 'declined on the consent form')));
    const key = visit ? { study_id: sid, visit } : { study_id: sid };
    return el('button', { class: 'row', onclick: () => go('form', { tab, key }) }, el('div', { class: 'main' }, el('div', null, NAMES[tab])), statusChip(find(tab, key)), el('span', { class: 'chev' }));
  };
  const visits = ['V1', 'V2', 'V3', 'V4', 'V5'].map((v) => {
    const w = CFG.WINDOWS[v], range = d0 !== null ? isoOf_(d0 + w[1]) + ' to ' + isoOf_(d0 + w[2]) : 'set the date ATT started';
    const st = sched[v];
    return [el('h2', null, v + ' · day ' + w[0] + ' ', st ? el('span', { class: 'chip ' + (st === 'overdue' ? 'bad' : st === 'due now' ? 'warn' : '') }, st) : null),
      el('div', { class: 'list' }, el('div', { class: 'row' }, el('div', { class: 'main sub' }, 'Window ' + range)), VISIT_FORMS[v].map((f) => formRow(f[0], f[1])))];
  });
  const usedU = view('LABS').filter((r) => r.study_id === sid && /^U/.test(r.visit)).map((r) => r.visit);
  const nextU = ['U1', 'U2', 'U3', 'U4', 'U5'].filter((u) => usedU.indexOf(u) < 0)[0];
  const evs = view('EVENTS').filter((r) => r.study_id === sid);
  const facts = [['Day today', d0 !== null ? today - d0 : '?'], ['Diabetes', ({ K: 'known', N: 'new', 0: 'no' }[e.dm_status] || 'not recorded')],
    ['BMI V1', D.bmi_v1], ['TBscore V1', D.tbscore_v1_p90], ['NLR V1', (out.labs.filter((r) => r[0] === sid && r[1] === 'V1')[0] || [])[5]],
    ['Timika', D.timika_final], ['PHQ-9 V1', D.phq9_v1], ['Item 9 positive', D.item9_positive || 'no']];
  const main = el('main', null,
    el('div', { class: 'list' }, el('button', { class: 'row', onclick: () => go('form', { tab: 'S1_ENROL', key: { study_id: sid } }) },
      el('div', { class: 'main' }, el('div', null, 'Enrolment details'), el('div', { class: 'sub' }, 'ATT started ' + (e.att_start_date || '?'))), statusChip(e), el('span', { class: 'chev' }))),
    el('div', { class: 'calc' }, facts.map((f) => el('div', { class: f[0] === 'Item 9 positive' && f[1] === 'Y' ? 'bad' : '' }, el('span', { class: 'small' }, f[0]), el('b', null, f[1] === '' || f[1] === undefined ? '–' : f[1])))),
    visits,
    el('h2', null, 'Unscheduled and events'),
    el('div', { class: 'list' },
      view('LABS').filter((r) => r.study_id === sid && /^U/.test(r.visit)).map((r) => el('button', { class: 'row', onclick: () => go('form', { tab: 'LABS', key: { study_id: sid, visit: r.visit } }) }, el('div', { class: 'main' }, el('div', null, 'Unscheduled liver test ' + r.visit), el('div', { class: 'sub' }, r.sample_date || '')), statusChip(r), el('span', { class: 'chev' }))),
      nextU && canData() ? el('button', { class: 'row', onclick: () => go('form', { tab: 'LABS', key: { study_id: sid, visit: nextU } }) }, el('div', { class: 'main' }, el('div', null, '+ Unscheduled liver test (' + nextU + ')')), el('span', { class: 'chev' })) : null,
      evs.map((r) => el('button', { class: 'row', onclick: () => go('form', { tab: 'EVENTS', key: r.event_no ? { event_no: r.event_no } : { _rid: r._rid } }) }, el('div', { class: 'main' }, el('div', null, 'Event ' + (r.event_type || '') + (r.event_no ? ' #' + r.event_no : '')), el('div', { class: 'sub' }, r.detected_date || '')), statusChip(r), el('span', { class: 'chev' }))),
      canData() ? el('button', { class: 'row', onclick: () => go('form', { tab: 'EVENTS', key: {}, preset: { study_id: sid } }) }, el('div', { class: 'main' }, el('div', null, '+ Record an event (E1 to E4)')), el('span', { class: 'chev' })) : null));
  return topBar(sid).concat([main]);
}
function due() {
  const out = derived();
  const rows = out.schedule.filter((r) => r[5] !== 'upcoming').concat(out.schedule.filter((r) => r[5] === 'upcoming'));
  return topBar('Due and overdue').concat([el('main', null, el('div', { class: 'list' }, rows.length ? rows.map((r) => el('button', { class: 'row', onclick: () => go('participant', { sid: r[0] }) },
    el('div', { class: 'main' }, el('div', null, r[0] + ' · ' + r[1]), el('div', { class: 'sub' }, 'window ' + r[3] + ' to ' + r[4])),
    el('span', { class: 'chip ' + (r[5] === 'overdue' ? 'bad' : r[5] === 'due now' ? 'warn' : '') }, r[5]), el('span', { class: 'chev' }))) : el('div', { class: 'empty' }, 'Nothing due')))]);
}
function queries() {
  const out = derived();
  return topBar('Queries').concat([el('main', null, el('p', { class: 'small muted' }, 'Worked out on this phone from the latest data, including entries not yet sent.'),
    el('div', { class: 'list' }, out.queries.length ? out.queries.map((q) => el('button', { class: 'row', onclick: () => q[0] ? go('participant', { sid: q[0] }) : go('screening') },
      el('div', { class: 'main' }, el('div', null, (q[0] || 'Screening log') + (q[3] ? ' · ' + q[3] : '') + ' · ' + q[1]), el('div', { class: 'sub' }, q[4] + (q[5] ? ': ' + q[5] : ''))), el('span', { class: 'chev' }))) : el('div', { class: 'empty' }, 'No queries')))]);
}
function screening() {
  const rows = view('S0_SCREEN').slice().reverse();
  return topBar('Screening log').concat([el('main', null, canData() ? el('button', { class: 'btn primary block', onclick: () => go('form', { tab: 'S0_SCREEN', key: {} }) }, 'Screen a patient') : null, el('h2', null, 'Most recent first'),
    el('div', { class: 'list' }, rows.length ? rows.map((r) => el('button', { class: 'row', onclick: () => go('form', { tab: 'S0_SCREEN', key: r.screen_no ? { screen_no: r.screen_no } : { _rid: r._rid } }) },
      el('div', { class: 'main' }, el('div', null, (r.screen_no ? 'No. ' + r.screen_no : 'New') + ' · ' + (r.screen_date || '')), el('div', { class: 'sub' }, 'eligible ' + (r.eligible || '?') + (r.study_id ? ' · ' + r.study_id : ''))), statusChip(r), el('span', { class: 'chev' }))) : el('div', { class: 'empty' }, 'No screening lines yet')))]);
}
function qclog() {
  const rows = view('QC_LOG').slice().reverse();
  return topBar('Verification log').concat([el('main', null, el('button', { class: 'btn primary block', onclick: () => go('form', { tab: 'QC_LOG', key: {} }) }, 'Record a check'), el('h2', null, 'Checks'),
    el('div', { class: 'list' }, rows.length ? rows.map((r) => el('button', { class: 'row', onclick: () => go('form', { tab: 'QC_LOG', key: r.qc_no ? { qc_no: r.qc_no } : { _rid: r._rid } }) },
      el('div', { class: 'main' }, el('div', null, (r.study_id || '') + ' · ' + (r.tab_checked || '') + ' ' + (r.visit_checked || '')), el('div', { class: 'sub' }, (r.qc_date || 'not yet checked') + ' · ' + (r.discrepancies || '0') + ' discrepancies')), statusChip(r), el('span', { class: 'chev' }))) : el('div', { class: 'empty' }, 'No checks yet')))]);
}
function attention() {
  const bad = S.outbox.filter((c) => c.status !== 'pending');
  return topBar('Needs fixing').concat([el('main', null, el('p', { class: 'small muted' }, 'The workbook did not accept these. Open each one, correct it and save again, or discard it.'),
    bad.map((c) => el('div', { class: 'card alert' }, el('b', null, NAMES[c.tab] + ' · ' + (c.values.study_id || c.values.screen_no || '') + (c.values.visit ? ' ' + c.values.visit : '')),
      el('ul', { class: 'small' }, Object.keys(c.errors || {}).map((k) => el('li', null, (k === '_' ? '' : k + ': ') + c.errors[k]))),
      el('div', { class: 'inline' }, el('button', { class: 'btn', onclick: () => go('form', { tab: c.tab, key: Object.assign({ _rid: c.rid }, c.values) }) }, 'Open'),
        el('button', { class: 'btn danger', onclick: () => modal('Discard this entry?', [el('p', null, 'It will be removed from this phone and never sent.')], [['Keep', null], ['Discard', async () => { S.outbox.splice(S.outbox.indexOf(c), 1); await saveState(); render(); }, 'danger']]) }, 'Discard')))),
    bad.length ? null : el('div', { class: 'empty' }, 'Nothing needs fixing'))]);
}
function films() {
  const fl = (S.server && S.server.films) || [], mine = view('R_SCORES');
  const has = (sid, n) => mine.some((r) => r.study_id === sid && r.read_no === n);
  const todo = fl.filter((f) => !has(f.study_id, '1') || (f.repeat && !has(f.study_id, '2')));
  const done = fl.filter((f) => todo.indexOf(f) < 0);
  const item = (f) => {
    const n = !has(f.study_id, '1') ? '1' : '2';
    return el('button', { class: 'row', onclick: () => go('form', { tab: 'R_SCORES', key: { study_id: f.study_id, read_no: todo.indexOf(f) >= 0 ? n : '1' } }) },
      el('div', { class: 'main' }, el('div', null, f.study_id), el('div', { class: 'sub' }, 'film of ' + (f.cxr_date || '?') + (todo.indexOf(f) >= 0 && n === '2' ? ' · repeat read requested' : ''))),
      statusChip(mine.filter((r) => r.study_id === f.study_id && r.read_no === (todo.indexOf(f) >= 0 ? n : '1'))[0] || null), el('span', { class: 'chev' }));
  };
  return topBar('Radiograph scoring').concat([el('main', null, el('div', { class: 'card small' }, 'Score each film from the image alone. You see no clinical or group information, and nobody but you and the PI sees your scores.'),
    el('h2', null, 'To score (' + todo.length + ')'), el('div', { class: 'list' }, todo.length ? todo.map(item) : el('div', { class: 'empty' }, 'Nothing to score')),
    el('h2', null, 'Scored'), el('div', { class: 'list' }, done.length ? done.map(item) : el('div', { class: 'empty' }, 'None yet')),
    el('button', { class: 'btn block', onclick: () => go('settings') }, 'Settings'))]);
}
function settings() {
  const pending = S.outbox.length;
  return topBar('Settings').concat([el('main', null,
    el('div', { class: 'list' }, [['Account', S.cfg.email], ['Role', S.cfg.role], ['Initials', S.cfg.initials], ['Server', (S.cfg.api || '').replace(/^https:\/\/([^/]+).*$/, '$1')],
      ['App version', APP_VERSION + ' (rules v' + CFG.VERSION + ')'], ['Last update', S.lastSync ? new Date(S.lastSync).toLocaleString('en-GB') : 'never'], ['Entries on this phone not yet in the workbook', String(pending)]]
      .map((r) => el('div', { class: 'row' }, el('div', { class: 'main' }, el('div', { class: 'sub' }, r[0]), el('div', null, r[1] || '–'))))),
    el('button', { class: 'btn primary block', onclick: () => sync() }, 'Sync now'), el('p'),
    el('button', { class: 'btn block', onclick: () => lock() }, 'Lock now'), el('p'),
    el('button', { class: 'btn danger block', onclick: resetPhone }, 'Reset this phone'),
    el('p', { class: 'small muted' }, 'Reset removes the study data and your access from this phone. Use it before passing the phone to someone else.'))]);
}
function resetPhone() {
  const n = S.outbox.length;
  const doIt = async () => { await kvDel('vault'); localStorage.removeItem('tbdm-fails'); localStorage.removeItem('tbdm-wait'); T.hasVault = false; lock(); };
  modal('Reset this phone?', [el('p', null, n ? n + ' entries on this phone have NOT reached the workbook and will be lost. Sync first if you can.' : 'All entries have reached the workbook. The phone will forget the study and your access.')],
    [['Cancel', null], [n ? 'Reset and lose ' + n : 'Reset', doIt, 'danger']]);
}

// ------------------------------------------------------------------ the generic form
function visible(tab, c, v, vals) {
  if (c.pi && role() !== 'pi') return false;
  const visit = s_(vals.visit);
  if (tab === 'VISITS') {
    if (/\(V3, V5\)$/.test(c.label) || c.key === 'smear_date' || c.key === 'smear_result') return visit === 'V3' || visit === 'V5';
    if (c.key === 'conversion') return visit === 'V3';
    if (c.key === 'dm_referred') return visit === 'V4';
    if (c.key === 'outcome') return visit === 'V5';
  }
  if (tab === 'LABS') { if (c.key === 'symptomatic') return /^U/.test(visit); if (c.key === 'fasting') return visit === 'V1'; }
  if (tab === 'PHQ_GAD' && /^(phq|gad)\d$/.test(c.key)) return vals.declined !== 'Y';
  if (tab === 'PHQ_GAD' && c.key === 'e1_form_no') return num_(vals.phq9) > 0;
  if (tab === 'EVENTS') {
    const t = s_(vals.event_type), m = /^(e\d)_/.exec(c.key);
    if (m) return t === m[1].toUpperCase();
  }
  if (APP_SERIAL[tab] === c.key) return false;
  return true;
}
function readOnly(tab) {
  if (role() === 'pi') return tab === 'R_SCORES';
  if (role() === 'data') return tab === 'QC_LOG' || tab === 'R_SCORES';
  if (role() === 'qc') return tab !== 'QC_LOG';
  return tab !== 'R_SCORES';
}
function formScreen(p) {
  const tab = p.tab, def = defOf(tab), keys = APP_KEYS[tab], serial = APP_SERIAL[tab];
  if (!T.form || T.form.tab !== tab) {
    const existing = Object.keys(p.key).length ? find(tab, p.key) : null;
    const vals = {};
    def.cols.forEach((c) => { vals[c.key] = existing ? s_(existing[c.key]) : ''; });
    if (!existing) {
      Object.keys(p.key).forEach((k) => { if (k[0] !== '_') vals[k] = s_(p.key[k]); });
      Object.keys(p.preset || {}).forEach((k) => { vals[k] = p.preset[k]; });
      def.cols.forEach((c) => { if (BY_FIELDS.indexOf(c.key) >= 0) vals[c.key] = S.cfg.initials; });
    }
    T.form = { tab, def, existing, vals, dirty: false, errs: {}, ro: readOnly(tab), fixedKeys: existing ? keys : keys.filter((k) => s_(p.key[k])) };
  }
  const F = T.form, ctxVisit = s_(F.vals.visit);
  const title = NAMES[tab] + (F.vals.study_id && tab !== 'S0_SCREEN' ? ' · ' + F.vals.study_id : '') + (ctxVisit ? ' ' + ctxVisit : '');
  const main = el('main', { id: 'formmain' });
  const pend = F.existing && F.existing._pending ? S.outbox.filter((c) => c.cid === F.existing._cid)[0] : null;
  if (pend && pend.status !== 'pending') main.append(el('div', { class: 'card alert' }, el('b', null, 'The workbook did not accept this entry:'), el('ul', { class: 'small' }, Object.keys(pend.errors || {}).map((k) => el('li', null, (k === '_' ? '' : k + ': ') + pend.errors[k])))));
  if (F.ro) main.append(el('div', { class: 'card small muted' }, 'View only: your role does not enter data here.'));
  if (serial && F.existing) main.append(el('div', { class: 'card small' }, serial.replace('_', ' ') + ': ', el('b', null, F.existing[serial] || 'assigned by the workbook when sent')));
  const fieldsBox = el('div');
  main.append(fieldsBox, el('div', { id: 'calc' }));
  const fill = () => {
    fieldsBox.replaceChildren();
    if (tab === 'LABS') {
      const v = /^U/.test(ctxVisit) ? 'U' : ctxVisit;
      const extra = [];
      LAB_GROUPS.forEach((g) => {
        const cols = g[1].map((k) => def.cols.filter((c) => c.key === k)[0]).filter((c) => c && visible(tab, c, null, F.vals));
        const expected = !g[2] || g[2].indexOf(v) >= 0 || cols.some((c) => s_(F.vals[c.key]) !== '');
        if (expected || F.showAll) fieldsBox.append(el('div', { class: 'group-title' }, g[0] + (expected ? '' : ' (not usually done at this visit)')), ...cols.map(fieldEl));
        else extra.push(g[0]);
      });
      if (extra.length) fieldsBox.append(el('button', { class: 'toggle', onclick: () => { F.showAll = true; fill(); } }, '+ Show other results (' + extra.join(', ') + ')'));
    } else {
      def.cols.filter((c) => visible(tab, c, null, F.vals)).forEach((c) => fieldsBox.append(fieldEl(c)));
    }
  };
  T.refill = fill;
  fill();
  setTimeout(paintCalc, 0);
  const bar = F.ro ? null : el('div', { class: 'savebar' }, el('button', { class: 'btn', onclick: () => confirmLeave(back) }, 'Cancel'), el('button', { class: 'btn primary', id: 'savebtn', onclick: saveForm }, 'Save'));
  return topBar(title).concat([main, bar]);
}
function ctx() { return { enrolled: enrolledMap(), today: dayNo_(todayIso()) }; }
function fieldMsg(c) {
  const F = T.form, v = F.vals[c.key];
  let m = validateValue_(c, v, F.vals, ctx());
  if (!m && c.type === 'sidnew' && F.tab === 'S1_ENROL' && !F.existing && s_(v) && enrolledMap()[s_(v).toUpperCase()]) m = 'is already enrolled';
  return m;
}
function fieldEl(c) {
  const F = T.form, fixed = F.fixedKeys.indexOf(c.key) >= 0 || F.ro;
  const box = el('div', { class: 'field', id: 'f-' + c.key });
  const msg = el('div', { class: 'msg', role: 'alert' });
  const set = (v, rerender) => {
    F.vals[c.key] = v; F.dirty = true;
    const m = fieldMsg(c); msg.textContent = m ? c.label.split(',')[0] + ' ' + m : ''; box.classList.toggle('err', !!m);
    if (rerender) { const y = window.scrollY; T.refill(); window.scrollTo(0, y); }
    paintCalc();
  };
  box.append(el('label', { class: 'lab', for: 'i-' + c.key }, c.label), el('div', { class: 'hint' }, helpText_(c)));
  const val = s_(F.vals[c.key]);
  if (fixed && (APP_KEYS[F.tab].indexOf(c.key) >= 0 || F.ro)) {
    box.append(el('div', null, el('b', null, val || '–')));
    return box;
  }
  const relayout = ['visit', 'declined', 'event_type', 'phq9', 'hba1c_unit', 'glucose_unit', 'lipid_unit', 'smear_result', 'eligible', 'enrolled'].indexOf(c.key) >= 0;
  if (c.codes || c.type === 'pairlist') {
    const opts = c.codes || c.values.map((x) => [x, '']);
    if (opts.length <= 7) {
      const seg = el('div', { class: 'seg' + (opts.length === 2 ? ' yn' : ''), role: 'radiogroup', 'aria-label': c.label });
      opts.forEach((o) => seg.append(el('button', { type: 'button', role: 'radio', 'aria-checked': String(val === o[0]), class: val === o[0] ? 'on' : '',
        onclick: (ev) => { const now = F.vals[c.key] === o[0] ? '' : o[0]; seg.querySelectorAll('button').forEach((b) => { b.classList.remove('on'); b.setAttribute('aria-checked', 'false'); });
          if (now) { ev.currentTarget.classList.add('on'); ev.currentTarget.setAttribute('aria-checked', 'true'); } set(now, relayout); } },
        o[0], o[1] ? el('small', null, o[1]) : null)));
      box.append(seg);
    } else {
      const sel = el('select', { id: 'i-' + c.key, onchange: (ev) => set(ev.target.value, relayout) }, el('option', { value: '' }, 'choose'),
        opts.map((o) => el('option', { value: o[0], selected: val === o[0] }, o[0] + ' = ' + o[1])));
      box.append(sel);
    }
  } else if (c.type === 'regex') {                                  // diabetes drugs: tick boxes composed in M S I O order
    const letters = [['M', 'metformin'], ['S', 'sulfonylurea'], ['I', 'insulin'], ['O', 'other']];
    const seg = el('div', { class: 'seg' });
    const cur = () => s_(F.vals[c.key]);
    const paint = () => seg.querySelectorAll('button').forEach((b) => { const k = b.dataset.k, v = cur(); b.classList.toggle('on', k === '0' ? v === '0' : v.indexOf(k) >= 0); });
    letters.concat([['0', 'none']]).forEach((l) => seg.append(el('button', { type: 'button', 'data-k': l[0], onclick: () => {
      let v = cur(); if (l[0] === '0') v = v === '0' ? '' : '0';
      else { v = v.replace('0', ''); v = v.indexOf(l[0]) >= 0 ? v.replace(l[0], '') : v + l[0]; v = letters.map((x) => x[0]).filter((x) => v.indexOf(x) >= 0).join(''); }
      set(v); paint(); } }, l[0], el('small', null, l[1]))));
    box.append(seg); paint();
  } else {
    const isNum = ['num', 'int', 'uniqueint', 'unitnum'].indexOf(c.type) >= 0;
    const type = c.type === 'date' ? 'date' : c.type === 'time' ? 'time' : 'text';
    const unitMissing = c.type === 'unitnum' && !s_(F.vals[c.unit]);
    const inp = el('input', { id: 'i-' + c.key, type, value: val, autocomplete: 'off', inputmode: isNum ? (c.type === 'int' || c.type === 'uniqueint' ? 'numeric' : 'decimal') : null,
      autocapitalize: ['sidnew', 'sid', 'sidl', 'rid'].indexOf(c.type) >= 0 || BY_FIELDS.indexOf(c.key) >= 0 ? 'characters' : 'off',
      maxlength: c.type === 'text' ? String(c.max) : null, disabled: unitMissing, placeholder: unitMissing ? 'choose the unit first' : c.type === 'sidnew' || c.type === 'sid' ? 'TBDM-' : null,
      oninput: (ev) => set(['sidnew', 'sid', 'sidl', 'rid'].indexOf(c.type) >= 0 ? ev.target.value.toUpperCase() : ev.target.value), onchange: (ev) => set(ev.target.value) });
    if (type === 'date' || type === 'time') {
      box.append(el('div', { class: 'inline' }, inp, el('button', { type: 'button', class: 'now', onclick: () => { inp.value = type === 'date' ? todayIso() : nowHm(); set(inp.value); } }, type === 'date' ? 'Today' : 'Now')));
    } else box.append(inp);
  }
  box.append(msg);
  if (val) { const m = fieldMsg(c); if (m) { msg.textContent = c.label.split(',')[0] + ' ' + m; box.classList.add('err'); } }
  return box;
}
function liveCalc() {
  const F = T.form, v = F.vals, out = [];
  const sid = s_(v.study_id).toUpperCase(), e = sid ? find('S1_ENROL', { study_id: sid }) : null;
  const dateKey = { LABS: 'sample_date', VISITS: 'visit_date', PHQ_GAD: 'interview_date', SPIRO: 'test_date', S2_BASELINE: 'exam_date' }[F.tab];
  const vis = F.tab === 'SPIRO' ? 'V5' : F.tab === 'S2_BASELINE' ? 'V1' : s_(v.visit);
  if (dateKey && e && v[dateKey]) {
    const d = diff_(e.att_start_date, v[dateKey]), w = inWindow_(vis, d);
    if (d !== null) out.push(['Day', d + (w ? (w === 'Y' ? ' (in window)' : ' (OUT of window)') : ''), w === 'N']);
  }
  if (F.tab === 'S2_BASELINE' || F.tab === 'VISITS') {
    const h = F.tab === 'S2_BASELINE' ? v.height_cm : (find('S2_BASELINE', { study_id: sid }) || {}).height_cm;
    const b = bmi_(v.weight_kg, h);
    if (b !== '') out.push(['BMI', b]);
    if (F.tab === 'S2_BASELINE' || vis === 'V3' || vis === 'V5') {
      const t9 = tbscore_(v, b, CFG.PULSE_PRIMARY), t1 = tbscore_(v, b, CFG.PULSE_SENSITIVITY);
      out.push(['TBscore', t9 === '' ? 'needs every item' : t9 + ' (pulse >100: ' + t1 + ')']);
    }
    if (F.tab === 'VISITS' && hepAny_(v) === true) out.push(['Liver symptoms', 'YES: liver tests today', true]);
  }
  if (F.tab === 'LABS') {
    const r = ratios_(v);
    ['nlr', 'plr', 'mlr', 'sii', 'siri'].forEach((k) => { if (r[k] !== '') out.push([k.toUpperCase(), r[k]]); });
    const x = ratio_(v.alt, v.alt_uln); if (x !== '') out.push(['ALT × ULN', x, x >= 3]);
    const dl = labDili(v); if (dl) out.push(['Liver injury', dl, true]);
    const a = hba1cPct_(v.hba1c, v.hba1c_unit); if (a !== '' && v.hba1c_unit === 'M') out.push(['HbA1c %', a]);
  }
  if (F.tab === 'PHQ_GAD' && v.declined !== 'Y') {
    const p = sumItems_(v, 'phq', 9), g = sumItems_(v, 'gad', 7);
    out.push(['PHQ-9 total', p === '' ? 'incomplete' : p], ['GAD-7 total', g === '' ? 'incomplete' : g]);
    if (num_(v.phq9) > 0) out.push(['Item 9', 'ABOVE 0: STOP', true]);
  }
  if (F.tab === 'SPIRO' && num_(v.fev1_l) !== null && num_(v.fvc_l) > 0) out.push(['FEV1/FVC calculated', round_(100 * num_(v.fev1_l) / num_(v.fvc_l), 1) + '%']);
  if (F.tab === 'R_SCORES') { const t = timika_(v.pct_lung, v.cavity); if (t !== '') out.push(['Timika', t]); }
  return out;
}
function labDili(v) {
  const vis = s_(v.visit);
  if (!vis || vis === 'V1') return '';
  let symp = null;
  if (/^U/.test(vis)) symp = v.symptomatic === 'Y' ? true : v.symptomatic === 'N' ? false : null;
  else { const vr = find('VISITS', { study_id: v.study_id, visit: vis }); if (vr) symp = hepAny_(vr); }
  return diliStatus_(v.alt, v.alt_uln, v.tbili, v.bili_uln, symp);
}
function paintCalc() {
  const box = $('#calc'); if (!box || !T.form) return;
  const items = liveCalc();
  box.replaceChildren(items.length ? el('div', null, el('div', { class: 'group-title' }, 'Calculated by the app'), el('div', { class: 'calc' },
    items.map((i) => el('div', { class: i[2] ? 'bad' : '' }, el('span', { class: 'small' }, i[0]), el('b', null, i[1]))))) : '');
}
async function saveForm() {
  const F = T.form, def = F.def, errs = [];
  def.cols.forEach((c) => {
    if (!visible(F.tab, c, null, F.vals)) { if (!(APP_KEYS[F.tab].indexOf(c.key) >= 0) && !F.existing) F.vals[c.key] = ''; return; }
    const m = fieldMsg(c); if (m) errs.push(c);
  });
  APP_KEYS[F.tab].forEach((k) => { if (APP_SERIAL[F.tab] !== k && !s_(F.vals[k])) errs.push(def.cols.filter((c) => c.key === k)[0]); });
  if (errs.length) {
    const first = $('#f-' + errs[0].key);
    if (first) { first.classList.add('err'); first.scrollIntoView({ block: 'center' }); }
    toast('Check ' + errs.length + ' field' + (errs.length > 1 ? 's' : '') + ' first: ' + errs.map((c) => c.key).join(', '));
    return;
  }
  if (!F.existing && APP_KEYS[F.tab].every((k) => APP_SERIAL[F.tab] === k || s_(F.vals[k]))) {
    const dup = APP_SERIAL[F.tab] ? null : find(F.tab, F.vals);
    if (dup) { toast('This record already exists. Opening it.'); T.form = null; T.nav[T.nav.length - 1].p.key = F.vals; render(); return; }
  }
  const vals = {}; def.cols.forEach((c) => { if (APP_SERIAL[F.tab] !== c.key || s_(F.vals[c.key])) vals[c.key] = F.vals[c.key]; });
  const entry = queueSave(F.tab, F.existing, vals);
  await saveState();
  F.dirty = false;
  const after = () => { back(); if (navigator.onLine) sync(); };
  if (!entry) { toast('No changes'); back(); return; }
  const savedMsg = navigator.onLine ? 'Saved. Sending…' : 'Saved on this phone. It will be sent when online.';
  const willWarn = (F.tab === 'PHQ_GAD' && F.vals.declined !== 'Y' && num_(F.vals.phq9) > 0) || (F.tab === 'LABS' && /^(MET|CHECK)/.test(labDili(F.vals))) ||
    (F.tab === 'VISITS' && hepAny_(F.vals) === true) || (F.tab === 'S0_SCREEN' && F.vals.enrolled === 'Y' && F.vals.study_id && !enrolledMap()[s_(F.vals.study_id).toUpperCase()]);
  if (!willWarn) toast(savedMsg);
  if (F.tab === 'PHQ_GAD' && F.vals.declined !== 'Y' && num_(F.vals.phq9) > 0) {
    return modal('STOP: PHQ-9 item 9 is above 0', [el('p', null, 'Before the participant leaves, today:'), el('ol', null,
      el('li', null, 'Stop the questionnaire and stay with the participant.'), el('li', null, 'Call the supervising clinician now.'),
      el('li', null, 'Same-day risk assessment and referral to psychiatry, LGH.'), el('li', null, 'Record in the clinical notes; complete form E1 and enter it as an event.'))],
    [['I am doing this now', after, 'danger']], true);
  }
  if (F.tab === 'LABS') {
    const dl = labDili(F.vals);
    if (/^MET/.test(dl)) return modal('Liver injury definition met', [el('p', null, dl + '.'), el('ol', null, el('li', null, 'Tell the treating team today. Treatment decisions are theirs.'), el('li', null, 'Complete form E2 and enter it as an event.'))], [['Understood', after, 'danger']], true);
    if (/^CHECK/.test(dl)) return modal('Symptom enquiry missing', [el('p', null, 'ALT is 3 times the upper limit or more, and the liver symptom enquiry for this visit is not recorded. Ask about the symptoms today: if any is present, the definition is met.')], [['Understood', after, 'danger']], true);
  }
  if (F.tab === 'VISITS' && hepAny_(F.vals) === true) return modal('Liver symptoms reported', [el('p', null, 'Make sure liver tests are drawn today, whether or not they were due.')], [['Understood', after]], false);
  if (F.tab === 'S0_SCREEN' && F.vals.enrolled === 'Y' && F.vals.study_id && !enrolledMap()[s_(F.vals.study_id).toUpperCase()]) {
    return modal('Enrol now?', [el('p', null, F.vals.study_id + ' is not enrolled yet. Enter the enrolment record next.')], [['Later', after], ['Enrol', () => { T.nav.pop(); go('form', { tab: 'S1_ENROL', key: {}, preset: { study_id: F.vals.study_id } }); if (navigator.onLine) sync(); }, 'primary']]);
  }
  after();
}

// ------------------------------------------------------------------ start
function readJoin() {
  const h = location.hash;
  if (h.indexOf('#join=') !== 0) return false;
  const raw = h.slice(6), i = raw.lastIndexOf('~');
  const apiUrl = decodeURIComponent(raw.slice(0, i)), code = raw.slice(i + 1);
  if (/^https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec$/.test(apiUrl) && /^[0-9a-f]{32}$/.test(code)) T.join = { api: apiUrl, code };
  history.replaceState(null, '', location.pathname + location.search);
  return true;
}
window.addEventListener('hashchange', () => { if (readJoin() && !KEY) render(); });
(async function start() {
  readJoin();
  try { T.hasVault = !!(await kvGet('vault')); } catch (e) { T.hasVault = false; }
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  render();
})();
