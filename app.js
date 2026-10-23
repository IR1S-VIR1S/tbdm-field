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
  ['Sample', ['sample_date', 'time_analysed', 'fasting', 'symptomatic', 'lab_status'], null],
  ['Blood count', ['hb', 'tlc', 'neut_abs', 'neut_pct', 'lymph_abs', 'lymph_pct', 'mono_abs', 'eos_pct', 'plt', 'rdw', 'mpv'], ['V1', 'V3', 'V5']],
  ['HbA1c', ['hba1c_unit', 'hba1c'], ['V1', 'V4', 'V5']],
  ['Glucose and lipids (fasting)', ['glucose_unit', 'fpg', 'lipid_unit', 'tg', 'hdl', 'tc', 'ldl'], ['V1']],
  ['Liver tests', ['alt', 'alt_uln', 'ast', 'ast_uln', 'alp', 'alp_uln', 'tbili', 'bili_uln', 'albumin', 'tprotein'], ['V1', 'V2', 'V3', 'V5', 'U']],
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
  if (T.practice) { practiceCommit(); return; }
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
function derived() {
  const out = computeDerived_(data(), todayIso());
  if (T.practice) out.queries = out.queries.filter((q) => !/^Study number skipped/.test(q[4]));      // practice numbers sit at the top of the range on purpose
  return out;
}
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
  if (T.practice) throw new Error('practice mode: the app never contacts the study');
  const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 45000);
  try {
    const r = await fetch(S ? S.cfg.api : T.join.api, { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      signal: ctl.signal, redirect: 'follow', credentials: 'omit', cache: 'no-store' });
    return await r.json();
  } finally { clearTimeout(timer); }
}
async function sync() {
  if (!S || T.syncing || T.practice) return;
  if (!navigator.onLine) { T.syncError = 'offline'; paintSync(); return; }
  T.syncing = true; paintSync();
  const mine = S, still = () => { if (S !== mine) throw Object.assign(new Error('stopped'), { quiet: true }); };   // the phone was locked or switched to practice meanwhile
  try {
    const hi = await api({ op: 'hello', token: S.cfg.token }); still();          // do the app and the workbook speak the same column layout?
    if (hi.code === 401) throw Object.assign(new Error(hi.error || 'not authorised'), { code: 401 });
    const srv = hi.ok && hi.schema ? Number(hi.schema) : 1;
    if (srv > CFG.SCHEMA_VER) {
      if (navigator.serviceWorker) navigator.serviceWorker.getRegistration().then((r) => r && r.update()).catch(() => {});
      throw Object.assign(new Error('A newer version of the app is ready. Close the app and open it again while online. Your entries are kept.'), { code: 409 });
    }
    if (srv < CFG.SCHEMA_VER) throw Object.assign(new Error('The study workbook has not been upgraded yet. Your entries stay on this phone and are sent after the upgrade.'), { code: 409 });
    const pending = S.outbox.filter((c) => c.status === 'pending');
    for (let i = 0; i < pending.length; i += 50) {
      const batch = pending.slice(i, i + 50).map((c) => ({ cid: c.cid, tab: c.tab, rid: c.rid, create: c.create, values: c.values, base: c.base, by: c.by }));
      const revs = {}; pending.slice(i, i + 50).forEach((c) => { revs[c.cid] = c.rev; });
      const res = await api({ op: 'push', token: S.cfg.token, schema: CFG.SCHEMA_VER, changes: batch }); still();
      if (!res.ok) throw Object.assign(new Error(res.error || 'the server refused'), { code: res.code });
      res.results.forEach((r) => {
        const c = S.outbox.filter((x) => x.cid === r.cid)[0];
        if (!c || c.rev !== revs[r.cid]) return;                       // changed again while sending: send again next time
        if (r.status === 'ok') S.outbox.splice(S.outbox.indexOf(c), 1);
        else { c.status = r.status; c.errors = r.errors; }
      });
      await saveState();
    }
    const pull = await api({ op: 'pull', token: S.cfg.token }); still();
    if (!pull.ok) throw Object.assign(new Error(pull.error || 'the server refused'), { code: pull.code });
    S.server = { tabs: pull.tabs, films: pull.films || [], regnums: pull.regnums || [], at: Date.now() };
    S.cfg.role = pull.role; S.cfg.email = pull.email;
    S.lastSync = Date.now(); T.syncError = ''; T.revoked = false;
    await saveState();
  } catch (e) {
    if (e.quiet) return;
    T.syncError = e.name === 'AbortError' ? 'timed out' : (e.message || 'failed');
    if (e.code === 401) T.revoked = true;
  } finally {
    T.syncing = false;
    if (T.form && T.form.dirty) paintSync(); else render();
  }
}

// ------------------------------------------------------------------ locking
function bumpIdle() { clearTimeout(T.idle); if (KEY) T.idle = setTimeout(lock, IDLE_LOCK_MS); }
function lock() { T.practice = false; T.real = null; KEY = null; S = null; T.form = null; T.reg = null; T.link = null; T.nav = []; T.pin = ''; clearTimeout(T.idle); render(); applyUpdateIfSafe(); }
['pointerdown', 'keydown'].forEach((ev) => document.addEventListener(ev, bumpIdle, { passive: true }));
document.addEventListener('visibilitychange', () => {
  if (document.hidden) T.hiddenAt = Date.now();
  else if (KEY && T.hiddenAt && Date.now() - T.hiddenAt > IDLE_LOCK_MS) lock();
});
window.addEventListener('online', () => { paintSync(); sync(); });
window.addEventListener('offline', paintSync);
['online', 'offline'].forEach((ev) => window.addEventListener(ev, () => { if (KEY && cur().name === 'home') render(); }));   // online-only tiles appear and disappear
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
    queries: queries, measure: measureList, measurefor: measureFor, attention: attention, films: films, settings: settings, screening: screening, qclog: qclog, register: registerScreen, link: linkScreen, linkpick: linkPick, visits: visitsScreen, visitguide: visitGuideScreen };
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
  if (T.practice) return el('div', { class: 'sync practice' }, el('span', { class: 'grow' }, 'PRACTICE: nothing is saved or sent'), el('button', { onclick: practiceStop }, 'Leave'));
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
    const box = el('input', { type: 'text', autocomplete: 'off', autocapitalize: 'off', placeholder: 'Paste the invitation link here' });
    const m0 = el('div', { class: 'msg' });
    return el('div', { class: 'lock' }, el('h1', null, 'TBDM Field App'),
      el('p', null, 'Set up this phone with the invitation link the principal investigator sent you. Tap it on this phone, or paste it below.'),
      box, m0,
      el('button', { class: 'btn primary block', onclick: () => {
        const v = s_(box.value), k = v.indexOf('#join=');
        if (k < 0 || !readJoin(v.slice(k))) { m0.textContent = 'That is not an invitation link. Copy the whole link and paste it again.'; return; }
        render();
      } }, 'Continue'),
      el('p', { class: 'small' }, 'If you added this app to the Home Screen after joining in the browser, the Home Screen copy starts empty. Ask for a new invitation and paste it here. No study data are stored until you join.'));
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
const canData = () => role() === 'data' || role() === 'pi' || role() === 'nurse';
const isNurse = () => role() === 'nurse';
// The next study number, from this phone's enrolments and screening lines (including ones not yet sent).
// Enrolment first offers a number already given on a screening line (enrolled = Y) that has no enrolment record yet.
function nextId(tab) {
  const re = new RegExp('^' + CFG.ID_PREFIX + '(\\d+)$', 'i'), num = (v) => { const m = re.exec(s_(v)); return m && +m[1] >= 1 && +m[1] <= CFG.ID_MAX ? +m[1] : 0; };
  const enrolled = {}, used = {}, waiting = []; let top = 0;
  view('S1_ENROL').forEach((r) => { const n = num(r.study_id); if (n) { enrolled[n] = used[n] = true; top = Math.max(top, n); } });
  view('S0_SCREEN').forEach((r) => { const n = num(r.study_id); if (n) { used[n] = true; top = Math.max(top, n); if (!enrolled[n] && r.enrolled === 'Y') waiting.push(n); } });
  ((S.server && S.server.regnums) || []).forEach((p) => { const n = num(p[0]); if (n) { used[n] = true; top = Math.max(top, n); if (p[1] === 'E' && !enrolled[n] && waiting.indexOf(n) < 0) waiting.push(n); } });   // numbers the register has given out
  if (tab === 'S1_ENROL' && waiting.length) return idOf_(Math.min.apply(null, waiting));
  if (T.practice) { for (let n = CFG.ID_MAX - 2; n >= 1; n--) if (!used[n]) return idOf_(n); return ''; }   // practice numbers count down from the top of the range
  return top >= CFG.ID_MAX ? '' : idOf_(top + 1);
}
function nextNo() { const n = nextId('S1_ENROL'); return n ? 'Next: ' + n : 'No numbers left'; }
function home() {
  if (role() === 'dots') return registerScreen();
  if (!S.server) return topBar('TBDM Field').concat([el('main', null, el('div', { class: 'card' }, navigator.onLine ? 'Fetching the study data…' : 'Connect to the internet once to fetch the study data.'))]);
  if (role() === 'reader1' || role() === 'reader2') return films();
  const out = isNurse() ? { schedule: [], queries: [] } : derived(), bad = S.outbox.filter((c) => c.status !== 'pending'), waiting = S.outbox.filter((c) => c.status === 'pending');
  const oldest = waiting.reduce((m, c) => Math.min(m, c.at), Infinity);
  const dueN = out.schedule.filter((r) => r[5] !== 'upcoming').length;
  const main = el('main', null,
    bad.length ? el('button', { class: 'card alert row', onclick: () => go('attention') }, el('div', { class: 'main' }, el('div', null, bad.length + ' entr' + (bad.length > 1 ? 'ies need' : 'y needs') + ' fixing'), el('div', { class: 'sub' }, 'The workbook did not accept them. Tap to see why.')), el('span', { class: 'chev' })) : null,
    waiting.length && Date.now() - oldest > 864e5 ? el('div', { class: 'card warn' }, el('b', null, 'Entries have waited more than a day.'), el('div', { class: 'small' }, 'Connect to the internet and press Sync. Until then they exist only on this phone.')) : null,
    el('div', { class: 'tiles' },
      canData() ? el('button', { class: 'tile primary', onclick: () => go('form', { tab: 'S0_SCREEN', key: {} }) }, el('b', null, 'Screen a patient'), el('span', null, 'Add a screening line')) : null,
      canData() ? el('button', { class: 'tile primary', onclick: () => go('form', { tab: 'S1_ENROL', key: {} }) }, el('b', null, 'Enrol'), el('span', null, nextNo())) : null,
      isNurse() ? el('button', { class: 'tile primary', onclick: () => go('measure') }, el('b', null, 'Measurements'), el('span', null, 'Height, weight, waist, arm')) : null,
      isNurse() ? null : el('button', { class: 'tile guide', onclick: () => go('visits') }, el('b', null, 'Visit checklist'), el('span', null, 'What to order and do')),
      isNurse() ? null : el('button', { class: 'tile people', onclick: () => go('participants') }, el('b', null, 'Participants'), el('span', null, Object.keys(enrolledMap()).length + ' enrolled')),
      role() === 'pi' && !T.practice ? el('button', { class: 'tile conf', onclick: () => go('linkpick') }, el('b', null, 'Link'), el('span', null, 'Confidential · call, WhatsApp')) : null,
      role() === 'pi' && !T.practice && navigator.onLine ? el('button', { class: 'tile conf', onclick: () => go('register') }, el('b', null, 'Link register'), el('span', null, 'Confidential · online only')) : null,
      isNurse() ? null : el('button', { class: 'tile due ' + (dueN ? 'hot' : 'calm'), onclick: () => go('due') }, el('b', null, 'Due and overdue'), el('span', null, dueN + ' visit' + (dueN === 1 ? '' : 's'))),
      isNurse() ? null : el('button', { class: 'tile queries ' + (out.queries.length ? 'hot' : 'calm'), onclick: () => go('queries') }, el('b', null, 'Queries'), el('span', null, out.queries.length + ' to check')),
      el('button', { class: 'tile', onclick: () => go('screening') }, el('b', null, 'Screening log'), el('span', null, view('S0_SCREEN').length + ' screened')),
      role() === 'qc' || role() === 'pi' ? el('button', { class: 'tile', onclick: () => go('qclog') }, el('b', null, 'Verification log'), el('span', null, view('QC_LOG').length + ' checks')) : null,
      T.practice ? null : el('button', { class: 'tile guide', onclick: () => modal('Start practice mode?', [el('p', null, 'You will work on made-up participants. Nothing is saved or sent to the study. Your real entries are kept safe and come back when you leave practice.')], [['Cancel', null], ['Start practice', practiceStart, 'primary']]) }, el('b', null, 'Practice'), el('span', null, 'Learn with made-up patients')),
      el('button', { class: 'tile', onclick: () => go('settings') }, el('b', null, 'Settings'), el('span', null, S.cfg.email || ''))),
    isNurse() ? null : el('h2', null, 'Safety'),
    isNurse() ? null : el('div', { class: 'card small' }, 'PHQ-9 item 9 above 0, or a liver result meeting the definition: act the same day (manual Part 4). The app and the e-mail alerts are only a backup.'));
  return topBar('TBDM Field').concat([main]);
}
// ---- study numbers register (PI and DOTS incharge). Online only. Nothing about it is kept on the phone.
const REG_STATUS_OPTS = [['E', 'Enrolled'], ['D', 'Declined'], ['S', 'Spoiled']];
function regState() { return T.reg || (T.reg = { list: null, loading: false, err: '', done: '', busy: false, status: 'E', name: '', mrn: '', phone: '', reason: '', pendingRid: null, q: '' }); }
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
  if (st.list && st.list.link && st.status !== 'S' && (!s_(st.name).trim() || !s_(st.mrn).trim() || !s_(st.phone).trim())) { st.err = 'Not assigned. The participant name, the record number and the telephone number are all required.'; render(); return; }
  st.pendingRid = st.pendingRid || rid();              // the same id on a retry, so a number is never assigned twice
  const body = { op: 'register_add', token: S.cfg.token, rid: st.pendingRid, status: st.status, reason: st.reason, name: st.name, mrn: st.mrn, phone: st.phone };
  st.busy = true; st.err = ''; st.done = ''; render();
  try {
    const res = await api(body);
    if (!res.ok) throw new Error(res.error || 'not assigned');
    st.done = (res.again ? 'Already assigned: ' : 'Assigned: ') + res.study_id;
    st.pendingRid = null; st.name = ''; st.mrn = ''; st.phone = ''; st.reason = ''; st.status = 'E';
  } catch (e) { st.err = 'Not assigned. ' + e.message + ' Check the connection and press Assign again.'; }
  st.busy = false;
  await regLoad();
}
function regList(L) {
  const st = regState(), q = st.q.trim().toUpperCase(), rows = L ? L.rows : [];
  const dig = (v) => s_(v).replace(/\D/g, '').replace(/^(92|0)/, ''), qd = dig(q);      // 0300 123, +92 300 123 and 300123 all find the same telephone
  const shown = q ? rows.filter((r) => [r.study_id, r.name, r.mrn].some((v) => s_(v).toUpperCase().indexOf(q) >= 0) || (qd.length >= 3 && dig(r.phone).indexOf(qd) >= 0) || s_(r.phone).replace(/\s/g, '').indexOf(q.replace(/\s/g, '')) >= 0) : rows;
  return el('div', { class: 'list', id: 'reglist' }, shown.length ? shown.map((r) => el('div', { class: 'row' }, el('button', { class: 'main', type: 'button', onclick: () => go('link', { sid: r.study_id }) },
    el('div', null, r.study_id),
    el('div', { class: 'sub' }, [r.status && ({ E: 'enrolled', D: 'declined', S: 'spoiled' })[r.status] || r.status, r.assigned_date].filter(Boolean).join(' · ')),
    r.name || r.mrn ? el('div', { class: 'sub' }, [r.name, r.mrn ? 'MRN ' + r.mrn : ''].filter(Boolean).join(' · ')) : null),
    r.phone ? el('a', { class: 'tel', href: 'tel:' + r.phone.replace(/[^\d+]/g, '') }, r.phone) : null, el('span', { class: 'chev' })))
    : el('div', { class: 'empty' }, L ? 'No numbers match.' : (st.loading ? 'Loading…' : '')));
}
function registerScreen() {
  const st = regState();
  if (st.list === null && !st.loading && !st.err && navigator.onLine) { st.loading = true; setTimeout(() => regLoad(), 0); }   // never load inside a render
  const L = st.list;
  const seg = (opts, cur, set) => el('div', { class: 'seg' }, opts.map((o) => el('button', { type: 'button', class: cur === o[0] ? 'on' : '', onclick: () => { set(o[0]); render(); } }, o[1])));
  const spoiled = st.status === 'S';
  const off = !navigator.onLine;
  return topBar('Link register').concat([el('main', null,
    el('div', { class: 'list' }, el('button', { class: 'row', onclick: () => go('visits') }, el('div', { class: 'main' }, el('div', null, 'Visit checklist'), el('div', { class: 'sub' }, 'What to order and do at each visit')), el('span', { class: 'chev' }))),
    L && L.link ? null : el('div', { class: 'card small muted' }, 'Study numbers only. No names, addresses, telephone numbers or record numbers are entered or shown here. Those stay on paper in the locked cabinet.'),
    off ? el('div', { class: 'card warn' }, el('b', null, 'No internet connection.'), el('div', { class: 'small' }, 'This works only online. Nothing is stored on this phone.')) : null,
    st.err ? el('div', { class: 'card alert' }, st.err) : null,
    st.done ? el('div', { class: 'card' }, el('b', null, st.done)) : null,
    el('div', { class: 'card' },
      el('div', { class: 'muted small' }, 'Next free number'),
      el('div', { style: 'font-size:28px;font-weight:700' }, L ? L.next : (st.loading ? 'loading…' : '–')),
      el('button', { class: 'btn block', type: 'button', disabled: off || st.loading, onclick: () => regLoad() }, 'Refresh')),
    el('h2', null, 'Assign a number'),
    el('div', { class: 'field' }, el('label', { class: 'lab' }, 'Outcome'), seg(REG_STATUS_OPTS, st.status, (v) => { st.status = v; })),
    spoiled || !(L && L.link) ? null : el('div', { class: 'field' }, el('label', { class: 'lab' }, 'Participant name, required'),
      el('input', { id: 'reg-name', type: 'text', maxlength: '60', value: st.name, oninput: (ev) => { st.name = ev.target.value; } })),
    spoiled || !(L && L.link) ? null : el('div', { class: 'field' }, el('label', { class: 'lab' }, 'Record number (MRN), required'),
      el('input', { id: 'reg-mrn', type: 'text', maxlength: '30', value: st.mrn, oninput: (ev) => { st.mrn = ev.target.value; } })),
    spoiled || !(L && L.link) ? null : el('div', { class: 'field' }, el('label', { class: 'lab' }, 'Telephone, required, e.g. 03001234567'),
      el('input', { id: 'reg-phone', type: 'text', inputmode: 'tel', maxlength: '16', value: st.phone, oninput: (ev) => { st.phone = ev.target.value; } })),
    spoiled ? el('div', { class: 'field' }, el('label', { class: 'lab' }, 'Reason the number is spoiled'),
      el('input', { type: 'text', maxlength: '80', value: st.reason, oninput: (ev) => { st.reason = ev.target.value; } })) : null,
    el('button', { class: 'btn primary block', type: 'button', disabled: off || st.busy || !L, onclick: () => regAssign() }, st.busy ? 'Assigning…' : 'Assign number'),
    el('h2', null, 'Look up a number'),
    el('input', { class: 'search', type: 'search', placeholder: 'Number, name, MRN or telephone', autocomplete: 'off', value: st.q,
      oninput: (ev) => { st.q = ev.target.value; const old = $('#reglist'); if (old) old.replaceWith(regList(st.list)); } }),   // redraw only the list, so the keyboard stays open
    regList(L)
  )]);
}

// ---- confidential link: record number, telephone, address for ONE study number. Online only, never stored on the phone.
async function linkLoad(sid) {
  const st = T.link = { sid: sid, data: null, err: '', msg: '', busy: true, edit: false };
  render();
  if (!navigator.onLine) { st.err = 'No internet connection. The confidential link works only online.'; st.busy = false; render(); return; }
  try {
    const res = await api({ op: 'link_get', token: S.cfg.token, study_id: sid });
    if (!res.ok) throw new Error(res.error || 'could not load');
    st.data = res; st.form = { name: res.name || '', mrn: res.mrn, phone: res.phone, guardian: res.guardian || '', address: res.address, note: res.note };
    st.edit = !(res.name || res.mrn || res.phone || res.guardian || res.address || res.note);
  } catch (e) { st.err = e.message; }
  st.busy = false; render();
}
async function linkSave() {
  const st = T.link;
  if (!navigator.onLine) { st.err = 'No internet connection. Nothing was saved.'; render(); return; }
  if (!s_((st.form || {}).mrn).trim() || !s_((st.form || {}).phone).trim()) { st.err = 'Not saved. The record number and the telephone number are both required.'; render(); return; }
  st.busy = true; st.err = ''; st.msg = ''; render();
  try {
    const res = await api(Object.assign({ op: 'link_set', token: S.cfg.token, study_id: st.sid }, st.form));
    if (!res.ok) throw new Error(res.error || 'not saved');
    st.msg = 'Saved.'; st.busy = false; st.edit = false;
    st.data = Object.assign({}, st.data, st.form); render(); return;
  } catch (e) { st.err = 'Not saved. ' + e.message; }
  st.busy = false; render();
}
function waDigits(ph) {                                   // 0300... becomes 92300..., for WhatsApp
  let d = s_(ph).replace(/\D/g, '');
  if (d.indexOf('00') === 0) d = d.slice(2); else if (d.charAt(0) === '0') d = '92' + d.slice(1);
  return d;
}
function linkScreen(p) {
  const sid = p.sid;
  if (!T.link || T.link.sid !== sid) { T.link = { sid: sid, data: null, err: '', msg: '', busy: true, edit: false }; setTimeout(() => linkLoad(sid), 0); }   // never load inside a render: the nested render would draw the page twice
  const st = T.link || { busy: true }, off = !navigator.onLine, d = st.data, f = st.form || {};
  const field = (k, lab, ml) => el('div', { class: 'field' }, el('label', { class: 'lab' }, lab),
    el('input', { type: 'text', maxlength: String(ml), value: f[k] || '', inputmode: k === 'phone' ? 'tel' : 'text', oninput: (ev) => { f[k] = ev.target.value; } }));
  const show = (lab, v) => el('div', { class: 'card' }, el('div', { class: 'muted small' }, lab), el('div', null, v || '–'));
  const ph = d && d.phone;
  return topBar(sid + ' · Link').concat([el('main', null,
    el('div', { class: 'card small muted' }, 'Confidential. Only the PI and the DOTS incharge, online only. Nothing here is saved on this phone, and every opening is logged.'),
    off ? el('div', { class: 'card warn' }, el('b', null, 'No internet connection.')) : null,
    st.err ? el('div', { class: 'card alert' }, st.err) : null,
    st.msg ? el('div', { class: 'card' }, el('b', null, st.msg)) : null,
    st.busy && !d ? el('div', { class: 'empty' }, 'Loading…') : null,
    d && !st.edit ? [
      ph ? el('div', { class: 'card' }, el('div', { class: 'muted small' }, 'Telephone'), el('a', { class: 'tel big', href: 'tel:' + ph.replace(/[^\d+]/g, '') }, ph),
        el('div', { class: 'row2' },
          el('a', { class: 'btn block', href: 'tel:' + ph.replace(/[^\d+]/g, '') }, 'Call'),
          el('a', { class: 'btn block', href: 'https://wa.me/' + waDigits(ph), target: '_blank', rel: 'noopener noreferrer' }, 'WhatsApp'))) : show('Telephone', ''),
      show('Name', d.name), show('Record number (MRN)', d.mrn), show('Father or husband name', d.guardian), show('Address', d.address), show('Note', d.note),
      d.updated ? el('div', { class: 'small muted' }, 'Last changed ' + d.updated) : null,
      el('button', { class: 'btn block', type: 'button', disabled: off, onclick: () => { st.edit = true; st.msg = ''; render(); } }, 'Edit')] : null,
    d && st.edit ? [field('name', 'Participant name', 60), field('mrn', 'Record number (MRN), required', 30), field('phone', 'Telephone, required, e.g. 03001234567', 16), field('guardian', 'Father or husband name', 60), field('address', 'Address', 200), field('note', 'Note', 200),
      el('button', { class: 'btn primary block', type: 'button', disabled: off || st.busy, onclick: () => linkSave() }, st.busy ? 'Saving…' : 'Save')] : null
  )]);
}

// ---- PHQ-9 and GAD-7 item wording, shown beside each scored item. Urdu text: Pfizer PHQ-9 and GAD-7 Urdu version (form TS35615/06-Urdu) supplied by the PI; English: standard PHQ-9 and GAD-7 wording
const ITEM_STEM = ['Over the last 2 weeks, how often have you been bothered by:', 'گزشتہ 2 ہفتوں کے دوران، آپ کو درجِ ذیل مسائل کی وجہ سے کتنی مرتبہ مشکل پیش آئی ہے؟'];
const ITEM_SCALE_UR = ['بالکل نہیں', 'کئی دن', 'آدھے دن سے زیادہ', 'تقریباً روزانہ'];
const ITEM_TEXT = {
  phq1: ['Little interest or pleasure in doing things', 'کچھ بھی کرنے میں بہت کم دلچسپی یا خوشی ہوتی ہے۔'],
  phq2: ['Feeling down, depressed or hopeless', 'پژمردہ، افسردہ یا ناامید ہونا۔'],
  phq3: ['Trouble falling or staying asleep, or sleeping too much', 'سونے یا سوئے رہنے میں مشکل ہونا، یا بہت زیادہ سونا۔'],
  phq4: ['Feeling tired or having little energy', 'تھکان محسوس کرنا یا بہت کم توانائی محسوس کرنا۔'],
  phq5: ['Poor appetite or overeating', 'بھوک میں کمی یا بہت زیادہ کھانا۔'],
  phq6: ['Feeling bad about yourself, or that you are a failure or have let yourself or your family down', 'اپنے متعلق برا محسوس کرنا۔ یا یہ کہ آپ نا کارہ ہیں یا آپ نے خود کو یا اپنے خاندان کو مایوس کیا ہے۔'],
  phq7: ['Trouble concentrating on things, such as reading the newspaper or watching television', 'کسی کام میں توجہ مرکوز کرنے میں مشکل ہونا، جیسے کہ اخبار پڑھنا یا ٹی وی دیکھنا۔'],
  phq8: ['Moving or speaking so slowly that other people could have noticed, or the opposite: being so fidgety or restless that you have been moving around a lot more than usual', 'اتنا آہستہ حرکت یا بات کرنا جسے دوسرے لوگ محسوس کر سکتے تھے؟ یا اس کا الٹ۔ اتنی بے چینی محسوس کرنا کہ آپ معمول سے زیادہ حرکت کریں۔'],
  phq9: ['Thoughts that you would be better off dead, or of hurting yourself in some way', 'اس قسم کے خیالات آنا کہ آپ کا مر جانا ہی بہتر ہے یا خود کو کسی طریقے سے تکلیف پہنچانے کے بارے میں سوچنا۔'],
  gad1: ['Feeling nervous, anxious or on edge', 'حواس باختہ، مضطرب یا بے بس محسوس کرنا'],
  gad2: ['Not being able to stop or control worrying', 'فکر کرنا بند نہ کرنا یا اس پر قابو نہ پانا۔'],
  gad3: ['Worrying too much about different things', 'مختلف چیزوں کے بارے میں بہت زیادہ فکر کرنا۔'],
  gad4: ['Trouble relaxing', 'سستانے میں مشکل محسوس کرنا۔'],
  gad5: ['Being so restless that it is hard to sit still', 'اتنا بے چین محسوس کرنا کہ ایک جگہ بیٹھنا مشکل ہو۔'],
  gad6: ['Becoming easily annoyed or irritable', 'بہت آسانی سے ناراض یا غصہ ہو جانا۔'],
  gad7: ['Feeling afraid, as if something awful might happen', 'یہ ڈر محسوس کرنا کہ کچھ برا ہونے والا ہے']
};
// Interviewer notes: a plain gloss to give ONLY when the participant does not understand a word. The validated item wording above is read first, unchanged.
const ITEM_NOTE = {
  phq2: ['If the participant does not understand \u201cپژمردہ\u201d (pazhmurda, literally \u201cwithered\u201d), read the item as written first, then explain it with these words only:', 'اداس، بجھا بجھا سا']
};
function itemWording(key) {
  const t = ITEM_TEXT[key]; if (!t) return null;
  const n = ITEM_NOTE[key];
  return el('div', { class: 'itemq' },
    /1$/.test(key) ? el('div', { class: 'small muted' }, ITEM_STEM[0]) : null,
    /1$/.test(key) ? el('div', { class: 'ur small muted', dir: 'rtl', lang: 'ur' }, ITEM_STEM[1]) : null,
    el('div', null, t[0]), el('div', { class: 'ur', dir: 'rtl', lang: 'ur' }, t[1]),
    n ? el('div', { class: 'itemnote' }, el('div', null, el('b', null, 'Interviewer note. '), n[0]), el('div', { class: 'ur gloss', dir: 'rtl', lang: 'ur' }, n[1]), el('div', { class: 'small' }, 'udaas, bujha bujha sa: sad, low')) : null,
    el('div', { class: 'scaleur', dir: 'ltr' }, ITEM_SCALE_UR.map((t, i) => el('span', { dir: 'rtl', lang: 'ur' }, i + ' = ' + t))));
}

// ---- E2 drug-induced liver injury: RUCAM total, CTCAE 5.0 suggestion from the laboratory rows, Hy's law check, details panels
function e2Labs(sid) { return view('LABS').filter((r) => s_(r.study_id).toUpperCase() === sid && num_(r.alt) !== null && num_(r.alt_uln) > 0); }
const ULN_KEY = { alt: 'alt_uln', ast: 'ast_uln', alp: 'alp_uln', tbili: 'bili_uln' };
const xUln = (r, k) => (num_(r[k]) !== null && num_(r[ULN_KEY[k]]) > 0 ? num_(r[k]) / num_(r[ULN_KEY[k]]) : null);
function ctcaeFromLabs(sid) {
  const rows = e2Labs(sid); if (!rows.length) return null;
  const base = rows.filter((r) => r.visit === 'V1')[0];
  // CTCAE 5.0: multiples of ULN; when the V1 value was already above ULN, multiples of that baseline value.
  // g1 is the lower edge of grade 1 against an abnormal baseline (1.5 for ALT and AST, 2.0 for ALP, above 1.0 for bilirubin).
  const grade = (r, k, cuts, g1) => {
    const val = num_(r[k]), uln = num_(r[ULN_KEY[k]]); if (val === null || !(uln > 0)) return 0;
    const bVal = base ? num_(base[k]) : null, abn = bVal !== null && bVal > uln, m = abn ? val / bVal : val / uln;
    if (m > cuts[2]) return 4; if (m > cuts[1]) return 3; if (m > cuts[0]) return 2;
    return (abn ? (g1 === 1 ? m > 1 : m >= g1) : m > 1) ? 1 : 0;
  };
  let best = { g: -1 };
  rows.forEach((r) => {
    const g = Math.max(grade(r, 'alt', [3, 5, 20], 1.5), grade(r, 'ast', [3, 5, 20], 1.5), grade(r, 'alp', [2.5, 5, 20], 2), grade(r, 'tbili', [1.5, 3, 10], 1));
    if (g > best.g) best = { g: g, visit: r.visit };
  });
  return best;
}
// Hy's law laboratory criteria on one sample: ALT or AST above 3 x ULN, bilirubin above 2 x ULN, ALP below 2 x ULN.
function hysFromLabs(sid) {
  const rows = view('LABS').filter((r) => s_(r.study_id).toUpperCase() === sid);
  for (const r of rows) {
    const t = xUln(r, 'alt'), a = xUln(r, 'ast'), b = xUln(r, 'tbili');
    if (!((t !== null && t > 3) || (a !== null && a > 3)) || b === null || !(b > 2)) continue;
    const p = xUln(r, 'alp');
    if (p === null) return { visit: r.visit, text: 'ALT or AST above 3 × and bilirubin above 2 × ULN at ' + r.visit + '; ALP or its upper limit missing, so cholestasis cannot be checked' };
    if (p >= 2) continue;
    return { visit: r.visit, text: 'lab criteria met at ' + r.visit + ' (ALP below 2 × ULN); now rule out other causes' };
  }
  return null;
}
// Injury pattern for RUCAM: R = (ALT / ULN) / (ALP / ULN) on the row with the highest ALT multiple.
function rFromLabs(sid) {
  let top = null;
  view('LABS').filter((r) => s_(r.study_id).toUpperCase() === sid).forEach((r) => { const a = xUln(r, 'alt'); if (a !== null && xUln(r, 'alp') !== null && (!top || a > top.a)) top = { a: a, p: xUln(r, 'alp'), visit: r.visit }; });
  if (!top || !(top.p > 0)) return null;
  const R = Math.round((top.a / top.p) * 10) / 10;
  return { R: R, visit: top.visit, type: R >= 5 ? 'H' : 'C', text: 'R = ' + R + ' at ' + top.visit + ': ' + (R >= 5 ? 'hepatocellular' : R <= 2 ? 'cholestatic' : 'mixed') };
}
function rucamLive(v) {
  const t = rucamTotal_(v); if (t === '') return null;
  return t + ' (' + rucamBand_(t) + ')';
}
function tbl(rows, head) {
  return el('table', { class: 'info-tbl' }, head ? el('thead', null, el('tr', null, head.map((h) => el('th', null, h)))) : null,
    el('tbody', null, rows.map((r) => el('tr', null, r.map((c) => el('td', null, c))))));
}
const INFO = {
  e2_ctcae: () => [
    el('p', null, el('b', null, 'CTCAE version 5.0, liver terms'), ' (grade the worst of ALT, AST, ALP and bilirubin; use the V1 value as the baseline)'),
    tbl([['ALT or AST increased', 'above ULN to 3 × ULN', 'above 3 to 5 × ULN', 'above 5 to 20 × ULN', 'above 20 × ULN'],
         ['Bilirubin increased', 'above ULN to 1.5 × ULN', 'above 1.5 to 3 × ULN', 'above 3 to 10 × ULN', 'above 10 × ULN'],
         ['ALP increased', 'above ULN to 2.5 × ULN', 'above 2.5 to 5 × ULN', 'above 5 to 20 × ULN', 'above 20 × ULN'],
         ['Hepatic failure', '–', '–', 'asterixis, mild encephalopathy, drug-induced liver injury, limits self-care', 'moderate or severe encephalopathy, coma, life-threatening']], ['Term', 'Grade 1', 'Grade 2', 'Grade 3', 'Grade 4']),
    el('p', { class: 'small' }, 'If the V1 value was already above the upper limit, CTCAE grades ALT and AST by the multiple of the baseline value: 1.5 to 3 × baseline is grade 1, above 3 to 5 grade 2, above 5 to 20 grade 3, above 20 grade 4. ALP: 2 to 2.5 × baseline grade 1, above 2.5 to 5 grade 2, above 5 to 20 grade 3, above 20 grade 4. Bilirubin: above 1 to 1.5 × baseline grade 1, above 1.5 to 3 grade 2, above 3 to 10 grade 3, above 10 grade 4. Grade 5: death.'),
    el('p', null, el('b', null, 'For this study (people on ATT)')),
    el('ul', { class: 'steps' },
      el('li', null, 'Use the laboratory result at the time of the event, and the same laboratory upper limit of normal that is printed on the report.'),
      el('li', null, 'Grade 1 is ALT up to 3 × ULN. An ALT of exactly 3 × ULN is still grade 1, but it already meets the study liver injury definition if there are symptoms or jaundice.'),
      el('li', null, 'Grade 2 and above, or any rise with symptoms or jaundice: check the study definition (manual Part 4.2), tell the treating team the same day and complete form E2.'),
      el('li', null, 'Grade 5 only if the death is attributed to the liver injury. A death from tuberculosis or another cause is not grade 5 for this event.'),
      el('li', null, 'Stopping or changing ATT is the treating team\'s decision, not the study\'s.'))],
  e2_hys_law: () => [
    el('p', null, el('b', null, 'Hy\'s law: all four must be true')),
    el('ul', { class: 'steps' },
      el('li', null, 'ALT or AST above 3 × the upper limit of normal'),
      el('li', null, 'Total bilirubin above 2 × the upper limit of normal'),
      el('li', null, 'No initial cholestasis: ALP is not raised to 2 × ULN or more'),
      el('li', null, 'No other explanation for the combination (viral hepatitis, biliary obstruction, alcohol, another drug): see RUCAM item 5')),
    el('p', { class: 'small' }, 'The bilirubin rise and the ALT or AST rise should be from the same blood sample or from samples taken close together. Answer Y only when all four are met. If an alternative cause is found, answer N.'),
    el('p', { class: 'small' }, 'If Y: tell the treating team the same day. Judge whether the event is serious (death, hospital admission or longer stay, lasting disability, life-threatening) and, if so, report to the IRB within 7 days (manual 4.2).')],
  e2_rucam_type: () => [
    el('p', null, el('b', null, 'R ratio'), ' = (ALT ÷ ALT upper limit) ÷ (ALP ÷ ALP upper limit), from the first abnormal result of the event.'),
    tbl([['R 5 or more', 'hepatocellular', 'H'], ['R above 2 and below 5', 'mixed', 'C'], ['R 2 or less', 'cholestatic', 'C']], ['R', 'Pattern', 'Choose']),
    el('p', { class: 'small' }, 'Hepatocellular uses the ALT scale. Cholestatic and mixed share the ALP scale, which also counts pregnancy and has longer time windows. The app suggests the pattern from the lab rows; you confirm it.')],
  e2_rucam_course: () => [el('p', { class: 'small' }, 'Use ALT for the hepatocellular pattern (answers A to E) and ALP for cholestatic or mixed (answers F to H). Compare the value after the drug was stopped with the highest value. If the drug was not stopped, choose the "drug was continued" answer for your pattern.')],
  e2_rucam_conmed: () => [el('p', { class: 'small' }, 'This study scores the whole ATT regimen as one suspect. Do not count isoniazid, rifampicin, pyrazinamide or ethambutol here. Count only other drugs or herbs taken in the same period.')],
  e2_rucam_altcause: () => [
    el('p', null, el('b', null, 'Group I (7 causes)')),
    el('ul', { class: 'steps' }, ['Hepatitis A: anti-HAV IgM', 'Hepatitis B: HBsAg, anti-HBc IgM, HBV DNA', 'Hepatitis C: anti-HCV, HCV RNA', 'Hepatitis E: anti-HEV IgM, IgG, HEV RNA', 'Liver and bile duct imaging: ultrasound with Doppler, or CT, or MRC', 'Alcoholism: AST/ALT ratio 2 or more', 'Recent acute low blood pressure'].map((t) => el('li', null, t))),
    el('p', null, el('b', null, 'Group II')),
    el('ul', { class: 'steps' }, ['Complications of an underlying disease: sepsis, metastatic cancer, autoimmune hepatitis, chronic hepatitis B or C, primary biliary or sclerosing cholangitis, genetic liver disease', 'Infection suggested by symptoms, ultrasound or tests: CMV, EBV, HSV, VZV'].map((t) => el('li', null, t)))],
  e2_rucam_prev: () => [el('p', { class: 'small' }, 'Isoniazid, rifampicin and pyrazinamide each carry a liver warning in their product information, so the usual answer is "labelled".')],
  e2_rucam_onset: () => [el('p', { class: 'small' }, 'Count from the day ATT was started (day 0). After a restart of ATT, count from the restart. Answer C only if the reaction began after ATT had been stopped.')]
};
function infoBtn(key) {
  const f = INFO[key]; if (!f) return null;
  const panel = el('div', { class: 'info-panel', hidden: true }, f());
  const b = el('button', { type: 'button', class: 'btn info-btn', onclick: () => { panel.hidden = !panel.hidden; b.textContent = panel.hidden ? 'Details' : 'Hide details'; } }, 'Details');
  return el('div', { class: 'info' }, b, panel);
}

// ---- visit checklist: what to do and order at each visit (from manual Part 3). Fixed text, no patient data.
const BLOOD_FULL = 'Blood count with differential (CBC), liver tests (ALT, AST, ALP, total bilirubin), HbA1c, lipids (triglycerides, HDL, total and LDL cholesterol), HBsAg, anti-HCV, HIV';
const M_ALL = ['Weight in kg, light clothing, shoes off', 'Waist in cm, midway between the lowest rib and the hip bone, after a normal breath out', 'Mid-upper arm circumference (MUAC) in mm, left arm'];
const M_V1 = ['Height in cm, shoes off'].concat(M_ALL);
const E_ALL = ['Temperature (axillary)', 'Pulse, counted for a full minute', 'Conjunctival pallor', 'Chest auscultation'];
const S_TB = 'TBscore symptoms: cough, haemoptysis, breathlessness, chest pain, night sweats';
const S_HEP = 'Liver symptoms: nausea, vomiting, loss of appetite, abdominal pain, dark urine, yellow eyes or skin, unexplained tiredness';
const VISIT_GUIDE = {
  V1: { name: 'Visit 1 · Baseline', when: 'Day 0 to 7 after ATT started', measure: M_V1, examine: E_ALL, symptoms: [S_TB, 'How many weeks the symptoms have lasted', S_HEP],
    order: [['Fasting bloods, 08:00 to 10:00. Write the draw time on the slip', BLOOD_FULL], ['Chest radiograph', 'The routine film. Tell the PI when it is ready']],
    do: ['Consent, then assign the next study number', 'History: smoking, alcohol, diabetes, hypertension', 'Questionnaires PHQ-9 and GAD-7, unless declined'],
    enter: ['Enrolment first', 'Baseline form', 'Laboratory results when they return', 'Chest radiograph date', 'Questionnaires (V1)'] },
  V2: { name: 'Visit 2 · Month 1', when: 'Day 21 to 35', measure: [], examine: [], symptoms: [S_HEP],
    order: [['Liver tests (ALT, AST, ALP, total bilirubin)', 'If any symptom is present, draw them the same day']],
    do: ['Ask about each liver symptom directly', 'Treatment status and adherence'],
    enter: ['Visit form (V2)', 'Laboratory results when they return', 'Check the liver injury definition as soon as the result is back'] },
  V3: { name: 'Visit 3 · Month 2', when: 'Day 49 to 70 · end of intensive phase', measure: M_ALL, examine: E_ALL, symptoms: [S_TB, S_HEP],
    order: [['Blood count (CBC) and liver tests (ALT, AST, ALP, total bilirubin)', ''], ['Sputum smear', 'Record the date and result']],
    do: ['Treatment status and adherence', 'Sputum conversion: Y, N or U. Never leave it blank'],
    enter: ['Visit form (V3)', 'Laboratory results when they return', 'Check the liver injury definition'] },
  V4: { name: 'Visit 4 · Month 3', when: 'Day 77 to 98', measure: [], examine: [], symptoms: [S_HEP],
    order: [['HbA1c, blood count (CBC) and liver tests (ALT, AST, ALP, total bilirubin)', 'Enter the HbA1c with its unit']],
    do: ['Treatment status and adherence', 'New diabetes found: refer for diabetes care and record it'],
    enter: ['Visit form (V4)', 'Laboratory results when they return'] },
  V5: { name: 'Visit 5 · Month 6', when: 'Day 154 to 182 · treatment completion', measure: M_ALL, examine: E_ALL, symptoms: [S_TB, S_HEP],
    order: [['Blood count (CBC) and liver tests (ALT, AST, ALP, total bilirubin)', ''], ['Sputum smear', 'Record the date and result'], ['Spirometry', 'Only if smear negative and not declined']],
    do: ['Treatment status and adherence', 'Treatment outcome', 'Questionnaires PHQ-9 and GAD-7, unless declined'],
    enter: ['Visit form (V5)', 'Laboratory results when they return', 'Spirometry', 'Questionnaires (V5)', 'End of study: status C and the date'] }
};
function visitsScreen() {
  const due = role() === 'dots' || !S.server ? [] : derived().schedule.filter((r) => r[5] !== 'upcoming');
  return topBar('Visit checklist').concat([el('main', null,
    el('div', { class: 'card small muted' }, 'Tap a visit to see what to order and do. Every visit is counted from the day ATT started.'),
    el('div', { class: 'list' }, Object.keys(VISIT_GUIDE).map((v) => el('button', { class: 'row', onclick: () => go('visitguide', { v: v }) },
      el('div', { class: 'main' }, el('div', null, VISIT_GUIDE[v].name), el('div', { class: 'sub' }, VISIT_GUIDE[v].when)),
      due.filter((r) => r[1] === v).length ? el('span', { class: 'chip warn' }, due.filter((r) => r[1] === v).length + ' due') : null, el('span', { class: 'chev' })))))
  ]);
}
function visitGuideScreen(p) {
  const g = VISIT_GUIDE[p.v], due = role() === 'dots' || !S.server ? [] : derived().schedule.filter((r) => r[1] === p.v && r[5] !== 'upcoming');
  const list = (items) => el('ul', { class: 'steps' }, items.map((t) => el('li', null, t)));
  return topBar(g.name).concat([el('main', null,
    el('div', { class: 'card' }, el('b', null, g.when)),
    g.measure.length + g.examine.length + g.symptoms.length ? [el('h2', null, 'Examine and measure'),
      el('div', { class: 'card' },
        g.measure.length ? [el('b', null, 'Measure'), list(g.measure)] : null,
        g.examine.length ? [el('b', null, 'Examine'), list(g.examine)] : null,
        g.symptoms.length ? [el('b', null, 'Ask about'), list(g.symptoms)] : null)] : null,
    el('h2', null, 'Order'),
    el('div', { class: 'list' }, g.order.map((o) => el('div', { class: 'row' }, el('div', { class: 'main' }, el('div', null, o[0]), o[1] ? el('div', { class: 'sub' }, o[1]) : null)))),
    el('h2', null, 'Do at the visit'), el('div', { class: 'card' }, list(g.do)),
    el('h2', null, 'Enter in this app'), el('div', { class: 'card' }, list(g.enter)),
    due.length ? [el('h2', null, 'Due now or overdue'), el('div', { class: 'list' }, due.map((r) => el('button', { class: 'row', onclick: () => go('participant', { sid: r[0] }) },
      el('div', { class: 'main' }, el('div', null, r[0])), el('span', { class: 'chip ' + (r[5] === 'overdue' ? 'bad' : 'warn') }, r[5]), el('span', { class: 'chev' }))))] : null,
    el('div', { class: 'card small muted' }, 'Abnormal results and urgent events: manual Part 4. Liver injury and PHQ-9 item 9 above 0 are acted on the same day.')
  )]);
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
// A visit's forms stay faded and cannot be opened until the visit window starts (counted from the date ATT started).
// A form that already has a record stays open, and so does everything once the window has begun, including late entry.
function visitOpens(sid, v) {
  const e = find('S1_ENROL', { study_id: sid }), d0 = e ? dayNo_(e.att_start_date) : null, w = CFG.WINDOWS[v], t = dayNo_(todayIso());
  if (d0 === null || !w || t === null || t >= d0 + w[1]) return '';
  return isoOf_(d0 + w[1]);
}
function lockedRow(name, opens) { return el('div', { class: 'row locked', 'aria-disabled': 'true' }, el('div', { class: 'main' }, el('div', null, name), el('div', { class: 'sub' }, 'opens ' + opens)), el('span', { class: 'chip' }, 'not yet')); }
function participant(p) {
  const sid = p.sid, out = derived(), e = find('S1_ENROL', { study_id: sid });
  if (!e) return topBar(sid).concat([el('main', null, el('div', { class: 'card' }, 'This study number is not in the workbook (it may have been withdrawn).'))]);
  const dp = out.participant.filter((r) => r[0] === sid)[0] || [];
  const dpk = DERIVED.DERIVED_PARTICIPANT.map((x) => x[0]), D = {}; dpk.forEach((k, i) => { D[k] = dp[i]; });
  const d0 = dayNo_(e.att_start_date), today = dayNo_(todayIso()), sched = {};
  out.schedule.filter((r) => r[0] === sid).forEach((r) => { sched[r[1]] = r[5]; });
  const optQ = e.optout_questionnaires === 'Y', optS = e.optout_spirometry === 'Y';
  let curV = 'V1';
  const formRow = (tab, visit) => {
    if ((tab === 'PHQ_GAD' && optQ) || (tab === 'SPIRO' && optS)) return el('div', { class: 'row' }, el('div', { class: 'main' }, el('div', null, NAMES[tab]), el('div', { class: 'sub' }, 'declined on the consent form')));
    const key = visit ? { study_id: sid, visit } : { study_id: sid };
    const opens = visitOpens(sid, curV);
    if (opens && tab !== 'END_STUDY' && !find(tab, key)) return lockedRow(NAMES[tab], opens);
    return el('button', { class: 'row', onclick: () => go('form', { tab, key }) }, el('div', { class: 'main' }, el('div', null, NAMES[tab])), statusChip(find(tab, key)), el('span', { class: 'chev' }));
  };
  const visits = ['V1', 'V2', 'V3', 'V4', 'V5'].map((v) => {
    const w = CFG.WINDOWS[v], range = d0 !== null ? isoOf_(d0 + w[1]) + ' to ' + isoOf_(d0 + w[2]) : 'set the date ATT started';
    const st = sched[v];
    return [el('h2', null, v + ' · ' + (v === 'V1' ? 'baseline' : 'month ' + ({ V2: 1, V3: 2, V4: 3, V5: 6 })[v]) + ' ', st ? el('span', { class: 'chip ' + (st === 'overdue' ? 'bad' : st === 'due now' ? 'warn' : '') }, st) : null),
      el('div', { class: 'list' }, el('div', { class: 'row' }, el('div', { class: 'main sub' }, 'Window ' + range)), (curV = v, VISIT_FORMS[v].map((f) => formRow(f[0], f[1]))))];
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
    role() === 'pi' && !T.practice ? el('div', { class: 'list conf' }, el('button', { class: 'row', onclick: () => go('link', { sid: sid }) }, el('div', { class: 'main' }, el('div', null, 'Link'), el('div', { class: 'sub' }, 'telephone, call, WhatsApp · online only')), el('span', { class: 'chev' }))) : null,
    visits,
    el('h2', null, 'Unscheduled and events'),
    el('div', { class: 'list' },
      view('LABS').filter((r) => r.study_id === sid && /^U/.test(r.visit)).map((r) => el('button', { class: 'row', onclick: () => go('form', { tab: 'LABS', key: { study_id: sid, visit: r.visit } }) }, el('div', { class: 'main' }, el('div', null, 'Unscheduled liver test ' + r.visit), el('div', { class: 'sub' }, r.sample_date || '')), statusChip(r), el('span', { class: 'chev' }))),
      nextU && canData() ? el('button', { class: 'row', onclick: () => go('form', { tab: 'LABS', key: { study_id: sid, visit: nextU } }) }, el('div', { class: 'main' }, el('div', null, '+ Unscheduled liver test (' + nextU + ')')), el('span', { class: 'chev' })) : null,
      evs.map((r) => el('button', { class: 'row', onclick: () => go('form', { tab: 'EVENTS', key: r.event_no ? { event_no: r.event_no } : { _rid: r._rid } }) }, el('div', { class: 'main' }, el('div', null, 'Event ' + (r.event_type || '') + (r.event_no ? ' #' + r.event_no : '')), el('div', { class: 'sub' }, r.detected_date || '')), statusChip(r), el('span', { class: 'chev' }))),
      canData() ? el('button', { class: 'row', onclick: () => go('form', { tab: 'EVENTS', key: {}, preset: { study_id: sid } }) }, el('div', { class: 'main' }, el('div', null, '+ Record an event (E1 to E4)')), el('span', { class: 'chev' })) : null));
  return topBar(sid).concat([main]);
}
// ---- measurement nurse: pick an enrolled participant, then the height, weight, waist and arm forms only
function measureList() {
  const q = el('input', { class: 'search', type: 'search', placeholder: 'Search study number', autocomplete: 'off' });
  const list = el('div', { class: 'list' });
  const fill = () => {
    const f = s_(q.value).toUpperCase();
    const rows = view('S1_ENROL').filter((r) => r.study_id && s_(r.study_id).toUpperCase().includes(f)).sort((a, b) => (a.study_id < b.study_id ? -1 : 1));
    list.replaceChildren(...(rows.length ? rows.map((r) => el('button', { class: 'row', onclick: () => go('measurefor', { sid: r.study_id }) },
      el('div', { class: 'main' }, el('div', null, r.study_id), el('div', { class: 'sub' }, 'enrolled ' + (r.enrol_date || '?'))),
      r._pending ? el('span', { class: 'chip ' + (r._pending === 'pending' ? 'pend' : 'bad') }, r._pending === 'pending' ? 'unsent' : 'fix') : null, el('span', { class: 'chev' }))) : [el('div', { class: 'empty' }, 'No participants yet. Enrol first.')]));
  };
  q.addEventListener('input', fill); fill();
  return topBar('Measurements').concat([el('main', null, q, list)]);
}
// ---- PI: pick an enrolled participant, then open the confidential Link screen (same screen as from the participant page)
function linkPick() {
  if (role() !== 'pi' || T.practice) return topBar('Link').concat([el('main', null, el('div', { class: 'card' }, 'Link is for the PI only, and is not available in practice mode.'))]);
  const q = el('input', { class: 'search', type: 'search', placeholder: 'Search study number', autocomplete: 'off' });
  const list = el('div', { class: 'list conf' });
  const fill = () => {
    const f = s_(q.value).toUpperCase();
    const rows = view('S1_ENROL').filter((r) => r.study_id && s_(r.study_id).toUpperCase().includes(f)).sort((a, b) => (a.study_id < b.study_id ? -1 : 1));
    list.replaceChildren(...(rows.length ? rows.map((r) => el('button', { class: 'row', onclick: () => go('link', { sid: r.study_id }) },
      el('div', { class: 'main' }, el('div', null, r.study_id), el('div', { class: 'sub' }, 'telephone, call, WhatsApp · online only')), el('span', { class: 'chev' }))) : [el('div', { class: 'empty' }, 'No participants match.')]));
  };
  q.addEventListener('input', fill); fill();
  return topBar('Link').concat([el('main', null, q, list)]);
}
function measureFor(p) {
  const sid = p.sid, row = (tab, key, name) => {
    const opens = visitOpens(sid, key.visit || 'V1');
    if (opens && !find(tab, key)) return lockedRow(name, opens);
    return el('button', { class: 'row', onclick: () => go('form', { tab, key }) }, el('div', { class: 'main' }, el('div', null, name)), statusChip(find(tab, key)), el('span', { class: 'chev' }));
  };
  return topBar(sid).concat([el('main', null,
    el('div', { class: 'list' }, row('S2_BASELINE', { study_id: sid }, 'V1 baseline: height, weight, waist, arm'),
      NURSE_VISITS.map((v) => row('VISITS', { study_id: sid, visit: v }, v + ': weight, waist, arm'))),
    el('h2', null, 'Enrolment'),
    el('div', { class: 'list' }, row('S1_ENROL', { study_id: sid }, 'Enrolment details')))]);
}
function due() {
  const out = derived();
  const rows = out.schedule.filter((r) => r[5] !== 'upcoming').concat(out.schedule.filter((r) => r[5] === 'upcoming'));
  return topBar('Due and overdue').concat([el('main', null, el('div', { class: 'list' }, rows.length ? rows.map((r) => el('button', { class: 'row', onclick: () => go('participant', { sid: r[0] }) },
    el('div', { class: 'main' }, el('div', null, r[0] + ' · ' + r[1]), el('div', { class: 'sub' }, 'window ' + r[3] + ' to ' + r[4])),
    el('span', { class: 'chip ' + (r[5] === 'overdue' ? 'bad' : r[5] === 'due now' ? 'warn' : '') }, r[5]), el('span', { class: 'chev' }))) : el('div', { class: 'empty' }, 'Nothing due')))]);
}
// ---- query navigation: open the exact form, scroll to the field and flash it, with the query shown on top
function fieldName(tab, k) { const d = defOf(tab), c = d && d.cols.filter((x) => x.key === k)[0]; return c ? c.label.split(' (')[0] : k; }
function openQuery(q) {
  const tab = q[1], keys = APP_KEYS[tab], query = q[4] + (q[5] ? ': ' + q[5] : '');
  if (!keys || !defOf(tab)) return q[0] ? go('participant', { sid: q[0] }) : go('screening');
  let key = null;
  if (tab === 'S0_SCREEN' || tab === 'EVENTS') key = q[7] ? { [APP_SERIAL[tab]]: q[7] } : null;
  else { key = {}; keys.forEach((k) => { key[k] = k === 'study_id' ? q[0] : k === 'visit' ? q[3] : ''; }); if (keys.some((k) => !key[k])) key = null; }
  if (!key) return q[0] ? go('participant', { sid: q[0] }) : go('screening');
  go('form', { tab: tab, key: key, focus: q[6], query: query });
}
function focusField(k) {
  let n = document.getElementById('f-' + k);
  if (!n && T.form && T.form.tab === 'LABS' && !T.form.showAll) { T.form.showAll = true; T.refill(); n = document.getElementById('f-' + k); }
  if (!n) return;
  n.scrollIntoView({ block: 'center', behavior: 'smooth' });
  n.classList.remove('flash'); void n.offsetWidth; n.classList.add('flash');
  setTimeout(() => n.classList.remove('flash'), 2600);
}
function queries() {
  const out = derived();
  T.qopen = T.qopen || {};
  const groups = {}, order = [];
  out.queries.forEach((q) => { const g = q[0] || 'Screening log'; if (!groups[g]) { groups[g] = []; order.push(g); } groups[g].push(q); });
  order.sort();
  const qrow = (q) => el('button', { class: 'row qrow', onclick: () => openQuery(q) },
    el('div', { class: 'main' }, el('div', null, (NAMES[q[1]] || q[1]) + (q[3] ? ' · ' + q[3] : '')), el('div', { class: 'sub' }, q[4] + (q[5] ? ': ' + q[5] : '')),
      q[6] ? el('div', { class: 'sub qfield' }, 'Opens at: ' + fieldName(q[1], q[6])) : null), el('span', { class: 'chev' }));
  const block = (g) => {
    const open = !!T.qopen[g], list = groups[g].slice().sort((a, b) => String(a[1] + a[3]).localeCompare(String(b[1] + b[3])));
    const forms = []; list.forEach((q) => { const f = NAMES[q[1]] || q[1]; if (forms.indexOf(f) < 0) forms.push(f); });
    return el('div', { class: 'qgroup' + (open ? ' open' : '') },
      el('button', { class: 'row qhead', onclick: () => { T.qopen[g] = !open; render(); } },
        el('div', { class: 'main' }, el('div', null, g), el('div', { class: 'sub' }, forms.join(', '))), el('span', { class: 'qcount' }, String(list.length)), el('span', { class: 'chev' })),
      open ? el('div', { class: 'qbody' }, list.map(qrow)) : null);
  };
  return topBar('Queries').concat([el('main', null, el('p', { class: 'small muted' }, 'Grouped by participant. Tap a study number to open its queries. Worked out on this phone from the latest data, including entries not yet sent.'),
    out.queries.length ? el('div', { class: 'list' }, order.map(block)) : el('div', { class: 'list' }, el('div', { class: 'empty' }, 'No queries')))]);
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
  if (T.practice) return topBar('Settings').concat([el('main', null, practiceCard())]);
  const pending = S.outbox.length;
  return topBar('Settings').concat([el('main', null,
    el('div', { class: 'list' }, [['Account', S.cfg.email], ['Role', S.cfg.role], ['Initials', S.cfg.initials], ['Server', (S.cfg.api || '').replace(/^https:\/\/([^/]+).*$/, '$1')],
      ['App version', APP_VERSION + ' (rules v' + CFG.VERSION + ')'], ['Last update', S.lastSync ? new Date(S.lastSync).toLocaleString('en-GB') : 'never'], ['Entries on this phone not yet in the workbook', String(pending)]]
      .map((r) => el('div', { class: 'row' }, el('div', { class: 'main' }, el('div', { class: 'sub' }, r[0]), el('div', null, r[1] || '–'))))),
    el('button', { class: 'btn primary block', onclick: () => sync() }, 'Sync now'), el('p'),
    role() !== 'dots' ? el('button', { class: 'btn block', onclick: () => modal('Start practice mode?', [el('p', null, 'You will work on made-up participants. Nothing is saved or sent to the study. Your real entries are kept safe and come back when you leave practice.')], [['Cancel', null], ['Start practice', practiceStart, 'primary']]) }, 'Practice mode (training)') : null, el('p'),
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
  if (isNurse() && !nurseCol_(tab, c.key)) return false;
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
    if (c.key === 'e2_rucam_score') return false;
    const ri = RUCAM.filter((it) => it[0] === c.key && it[3])[0];
    if (ri) return t === 'E2' && s_(vals.e2_rucam_type).toUpperCase() === ri[3];
    if (m) return t === m[1].toUpperCase();
  }
  if (tab === 'R_SCORES' && c.key === 'n_cavities') return s_(vals.cavity).toUpperCase() === 'Y';
  if (APP_SERIAL[tab] === c.key) return false;
  return true;
}
function readOnly(tab) {
  if (isNurse()) return NURSE_SCOPE[tab] === undefined;
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
  if (p.query) main.append(el('div', { class: 'card qbanner' }, el('b', null, 'Query: '), p.query,
    p.focus ? el('button', { type: 'button', class: 'btn qgo', onclick: () => focusField(p.focus) }, 'Show the field') : null));
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
  if (p.focus && !p._focused) { p._focused = true; setTimeout(() => focusField(p.focus), 120); }
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
    if (F.tab === 'R_SCORES' && c.key === 'cavity') F.vals.n_cavities = v === 'N' ? '0' : (v === 'Y' && F.vals.n_cavities === '0' ? '' : F.vals.n_cavities);
    const m = fieldMsg(c); msg.textContent = m ? c.label.split(',')[0] + ' ' + m : ''; box.classList.toggle('err', !!m);
    if (rerender) { const y = window.scrollY; T.refill(); window.scrollTo(0, y); }
    paintCalc();
  };
  box.append(el('label', { class: 'lab', for: 'i-' + c.key }, c.label), ...[itemWording(c.key)].filter(Boolean), el('div', { class: 'hint' }, helpText_(c)), ...[infoBtn(c.key)].filter(Boolean));
  const val = s_(F.vals[c.key]);
  if (fixed && (APP_KEYS[F.tab].indexOf(c.key) >= 0 || F.ro)) {
    box.append(el('div', null, el('b', null, val || '–')));
    return box;
  }
  const relayout = ['visit', 'declined', 'event_type', 'phq9', 'hba1c_unit', 'glucose_unit', 'lipid_unit', 'smear_result', 'eligible', 'enrolled', 'e2_rucam_type'].indexOf(c.key) >= 0 || (F.tab === 'R_SCORES' && c.key === 'cavity');
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
    if (F.tab === 'R_SCORES' && (c.key === 'pct_lung' || c.key === 'n_cavities') && !F.ro) {      // tap choices; typing an exact value still works
      const picks = c.key === 'pct_lung' ? Array.from({ length: 21 }, (_, i) => String(i * 5)) : Array.from({ length: 10 }, (_, i) => String(i + 1));
      const row = el('div', { class: 'seg quick', role: 'group', 'aria-label': c.label + ', quick choices' });
      const paint = () => row.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.v === s_(F.vals[c.key])));
      picks.forEach((x) => row.append(el('button', { type: 'button', 'data-v': x, onclick: () => { inp.value = x; set(x); paint(); } }, x)));
      inp.addEventListener('input', paint); paint();
      box.append(row);
    }
    if (type === 'date' || type === 'time') {
      box.append(el('div', { class: 'inline' }, inp, el('button', { type: 'button', class: 'now', onclick: () => { inp.value = type === 'date' ? todayIso() : nowHm(); set(inp.value); } }, type === 'date' ? 'Today' : 'Now')));
    } else box.append(inp);
    if (c.type === 'sidnew' && !F.ro && !fixed && (F.tab === 'S1_ENROL' || F.tab === 'S0_SCREEN')) {      // pick the next number instead of typing it
      const nid = nextId(F.tab);
      inp.readOnly = false; inp.placeholder = 'type a number, or tap Next available';      // both ways stay open: the paper log may disagree with the suggestion
      box.append(el('button', { type: 'button', id: 'nextid', class: 'btn primary block', disabled: !nid, onclick: () => { inp.value = nid; set(nid); } }, nid ? 'Next available: ' + nid : 'No numbers left'));
    }
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
    if (!isNurse() && (F.tab === 'S2_BASELINE' || vis === 'V3' || vis === 'V5')) {
      const t9 = tbscore_(v, b, CFG.PULSE_PRIMARY), t1 = tbscore_(v, b, CFG.PULSE_SENSITIVITY);
      out.push(['TBscore', t9 === '' ? 'needs every item' : t9 + ' (pulse >100: ' + t1 + ')']);
    }
    if (F.tab === 'VISITS' && hepAny_(v) === true) out.push(['Liver symptoms', 'YES: liver tests today', true]);
  }
  if (F.tab === 'EVENTS' && s_(v.event_type) === 'E2') {
    const rl = rucamLive(v); out.push(['RUCAM score', rl || 'choose the injury pattern and answer every item']);
    if (sid) {
      const cg = ctcaeFromLabs(sid);
      out.push(['CTCAE 5.0, from the lab results', cg ? (cg.g > 0 ? 'grade ' + cg.g + ' (visit ' + cg.visit + ')' : 'below grade 1') + ' · you decide' : 'no lab row with ALT and its upper limit']);
      const hv = hysFromLabs(sid);
      out.push(["Hy's law lab criteria", hv ? hv.text : 'not met on the entered labs', !!hv]);
      const rp = rFromLabs(sid);
      out.push(['RUCAM injury pattern, from the labs', rp ? rp.text + ' · you decide' : 'needs ALT, ALP and both upper limits on one lab row', !!(rp && s_(v.e2_rucam_type) && s_(v.e2_rucam_type).toUpperCase() !== rp.type)]);
    }
  }
  if (F.tab === 'LABS') {
    const r = ratios_(v);
    ['nlr', 'plr', 'mlr', 'sii', 'siri'].forEach((k) => { if (r[k] !== '') out.push([k.toUpperCase(), r[k]]); });
    const x = ratio_(v.alt, v.alt_uln); if (x !== '') out.push(['ALT × ULN', x, x >= 3]);
    const xs = ratio_(v.ast, v.ast_uln); if (xs !== '') out.push(['AST × ULN', xs, xs >= 3]);
    const xp = ratio_(v.alp, v.alp_uln); if (xp !== '') out.push(['ALP × ULN', xp, xp >= 2]);
    if (x !== '' && xp !== '' && xp > 0) out.push(['R ratio (ALT ÷ ALP, as × ULN)', Math.round((x / xp) * 10) / 10]);
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
  if (F.tab === 'R_SCORES') { const gaps = readerGaps_(F.vals); Object.keys(gaps).forEach((k) => { const c = def.cols.filter((x) => x.key === k)[0]; if (c && errs.indexOf(c) < 0) { errs.push(c); const b = $('#f-' + k); if (b) { b.classList.add('err'); const mm = b.querySelector('.msg'); if (mm) mm.textContent = c.label.split(',')[0] + ' ' + gaps[k]; } } }); }
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
  if (F.tab === 'EVENTS' && s_(F.vals.event_type) === 'E2') { const rt = rucamTotal_(F.vals); F.vals.e2_rucam_score = rt === '' ? '' : String(rt); }
  if (F.tab === 'R_SCORES' && s_(F.vals.cavity).toUpperCase() === 'N') F.vals.n_cavities = '0';
  const vals = {}; def.cols.forEach((c) => { if (APP_SERIAL[F.tab] !== c.key || s_(F.vals[c.key])) vals[c.key] = F.vals[c.key]; });
  const entry = queueSave(F.tab, F.existing, vals);
  await saveState();
  F.dirty = false;
  const after = () => { back(); if (navigator.onLine) sync(); };
  if (!entry) { toast('No changes'); back(); return; }
  const savedMsg = T.practice ? 'Saved in practice only. Nothing was sent.' : navigator.onLine ? 'Saved. Sending…' : 'Saved on this phone. It will be sent when online.';
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


// ------------------------------------------------------------------ practice mode (training)
// A sandbox for new collaborators. It has its own made-up participants, lives only in memory, is thrown away on exit or lock,
// and is blocked at three points from ever touching the study: api() refuses to run, sync() does nothing, saveState() writes nothing.
const PRAC_A = idOf_(CFG.ID_MAX), PRAC_B = idOf_(CFG.ID_MAX - 1);   // the top of the number range, which a real study never reaches
function practiceTabs() {
  const today = dayNo_(todayIso()), role_ = S.cfg.role, first = dayNo_(CFG.EARLIEST);
  const at = (n) => isoOf_(Math.min(today, Math.max(first, today - n)));          // a date n days ago, never before the study could start
  const attA = Math.min(today, Math.max(first, today - 42)), v2 = attA + 24, iso = (n) => at(n);
  const row = (tab, o) => { const d = defOf(tab), k = d.cols.map((c) => c.key); return k.map((x) => (o[x] === undefined ? '' : String(o[x]))); };
  const keep = (tab) => (role_ === 'nurse' ? defOf(tab).cols.map((c) => c.key).filter((k) => nurseCol_(tab, k)) : defOf(tab).cols.map((c) => c.key));
  const data = {
    S0_SCREEN: [
      { screen_no: 1, screen_date: iso(42), age: 46, sex: 'M', smear_grade: '2', eligible: 'Y', enrolled: 'Y', study_id: PRAC_A, screened_by: 'PRAC' },
      { screen_no: 2, screen_date: iso(6), age: 39, sex: 'F', smear_grade: '1', eligible: 'Y', enrolled: 'Y', study_id: PRAC_B, screened_by: 'PRAC' },
      { screen_no: 3, screen_date: iso(5), age: 52, sex: 'M', smear_grade: '3', eligible: 'N', excl_code: EXCL[0][0], enrolled: 'N', screened_by: 'PRAC' }],
    S1_ENROL: [
      { study_id: PRAC_A, enrol_date: iso(40), att_start_date: iso(42), age_years: 46, sex: 'M', residence: 'U', education: '2', smoking: '0', alcohol: '0', dm_status: 'K', dm_years: 3, dm_drugs: 'M', htn: 'N', regimen: 'HRZE', smear_grade: '2', genexpert: 'D', rif_res: 'N', optout_questionnaires: 'N', optout_spirometry: 'N', entered_by: 'PRAC' },
      { study_id: PRAC_B, enrol_date: iso(4), att_start_date: iso(5), age_years: 39, sex: 'F', residence: 'R', education: '1', smoking: '0', alcohol: '0', dm_status: '0', htn: 'N', regimen: 'HRZE', smear_grade: '1', genexpert: 'D', rif_res: 'N', optout_questionnaires: 'N', optout_spirometry: 'N', entered_by: 'PRAC' }],
    S2_BASELINE: [{ study_id: PRAC_A, exam_date: iso(41), height_cm: 168, weight_kg: 52, waist_cm: 80, muac_mm: 230, examined_by: 'PRAC' }],
    VISITS: today >= attA + 21 ? [{ study_id: PRAC_A, visit: 'V2', attended: 'Y', visit_date: isoOf_(Math.min(today, v2)), treatment: 'C', adherence: 'G', entered_by: 'PRAC' }] : []
  };
  const tabs = {};
  SCHEMA.forEach((t) => { if (role_ === 'nurse' && NURSE_SCOPE[t.tab] === undefined) return; const cols = keep(t.tab); tabs[t.tab] = { cols, rows: (data[t.tab] || []).map((o) => { const full = row(t.tab, o), all = t.cols.map((c) => c.key); return cols.map((k) => full[all.indexOf(k)]); }) }; });
  if (role_ === 'reader1' || role_ === 'reader2') { tabs.R_SCORES = { cols: READER.cols.map((c) => c.key), rows: [] }; }
  return tabs;
}
function practiceStart() {
  if (T.practice) return;
  if (T.syncing) { toast('The phone is sending entries. Try again in a moment.'); return; }
  T.real = S;
  S = { cfg: Object.assign({}, S.cfg, { token: '', api: '', email: 'practice' }), outbox: [], lastSync: Date.now(), server: null };
  S.server = { tabs: practiceTabs(), at: Date.now(), films: /^reader/.test(T.real.cfg.role) ? [{ study_id: PRAC_A, cxr_date: isoOf_(dayNo_(todayIso()) - 41), repeat: false }, { study_id: PRAC_B, cxr_date: isoOf_(dayNo_(todayIso()) - 4), repeat: false }] : [] };
  T.practice = true; T.nav = []; T.form = null; render();
}
function practiceStop() { if (!T.practice) return; S = T.real; T.real = null; T.practice = false; T.nav = []; T.form = null; render(); }
function practiceCommit() {                       // "sending" in practice: apply the queued entries to the sandbox copy only
  S.outbox.filter((c) => c.status === 'pending').forEach((c) => {
    const t = S.server.tabs[c.tab], d = defOf(c.tab), keys = APP_KEYS[c.tab], serial = APP_SERIAL[c.tab];
    if (!t || !d) return;
    const o = {}; t.cols.forEach((k, i) => { o[k] = ''; });
    let at = -1;
    t.rows.forEach((r, i) => { const x = {}; t.cols.forEach((k, j) => { x[k] = r[j]; }); if (at < 0 && keys.every((k) => s_(x[k]) !== '' && s_(x[k]).toUpperCase() === s_(c.values[k]).toUpperCase())) at = i; });
    if (at < 0) { t.rows.push(t.cols.map(() => '')); at = t.rows.length - 1; }
    Object.keys(c.values).forEach((k) => { const j = t.cols.indexOf(k); if (j >= 0) t.rows[at][j] = s_(c.values[k]); });
    if (serial && t.cols.indexOf(serial) >= 0 && !s_(t.rows[at][t.cols.indexOf(serial)])) t.rows[at][t.cols.indexOf(serial)] = String(t.rows.reduce((m, r) => Math.max(m, num_(r[t.cols.indexOf(serial)]) || 0), 0) + 1);
  });
  S.outbox = [];
}
function practiceCard() {
  return el('div', { class: 'card practice-card' }, el('b', null, 'Practice mode'), el('div', { class: 'small' }, 'Made-up participants (' + idOf_(CFG.ID_MAX) + ' and ' + idOf_(CFG.ID_MAX - 1) + '). Use it to learn the screens. Nothing you enter is saved or sent anywhere, and it is cleared when you leave or the phone locks.'),
    el('button', { class: 'btn primary block', onclick: practiceStop }, 'Leave practice and return to the study'));
}

// ------------------------------------------------------------------ start
function readJoin(given) {
  const h = given || location.hash;
  if (h.indexOf('#join=') !== 0) return false;
  let ok = false;
  const raw = h.slice(6), i = raw.lastIndexOf('~');
  const apiUrl = decodeURIComponent(raw.slice(0, i)), code = raw.slice(i + 1);
  if (/^https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec$/.test(apiUrl) && /^[0-9a-f]{32}$/.test(code)) { T.join = { api: apiUrl, code }; ok = true; }
  if (!given) history.replaceState(null, '', location.pathname + location.search);
  return given ? ok : true;
}
window.addEventListener('hashchange', () => { if (readJoin() && !KEY) render(); });
(async function start() {
  readJoin();
  try { T.hasVault = !!(await kvGet('vault')); } catch (e) { T.hasVault = false; }
  if ('serviceWorker' in navigator) setupAutoUpdate();
  render();
})();

// ---- automatic updates: nothing is asked of the user. A new version is fetched in the background and
// switched in the next time the app is on its lock screen (after locking, the idle lock, or when reopened),
// so it never interrupts an entry and never needs the PIN to be typed because of the update.
let updateReady = false;
function applyUpdateIfSafe() {
  if (!updateReady || KEY || T.pin || T.join) return;                       // only when locked, no PIN half typed, not mid-setup
  location.reload();
}
function setupAutoUpdate() {
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).then((reg) => {
    const check = () => { if (navigator.onLine) reg.update().catch(() => {}); };
    check();
    window.addEventListener('online', check);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) check(); });
    setInterval(check, 30 * 60 * 1000);
  }).catch(() => {});
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (hadController) { updateReady = true; applyUpdateIfSafe(); } });
  setInterval(applyUpdateIfSafe, 15000);
}
