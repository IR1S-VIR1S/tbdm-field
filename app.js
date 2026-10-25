/* TBDM Field App v1.0. Offline data entry for the LGH TB-DM cohort.
 * Entries are kept on the phone, encrypted with a key made from the user's PIN, and sent to the
 * study workbook (TBDM_DataSystem.gs web app) whenever the phone is online. The rules, codes and
 * calculations come from logic.js, which build.js copies from the workbook script itself. */
'use strict';
const APP_VERSION = '1.0';
const BUILD_ID = '528178ebc9f1';                 // replaced by build.js with the build's hash
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
  return crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: PBKDF2_ROUNDS, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
}
// A page refresh (pull down to reload) would otherwise ask for the PIN again. For the open tab only, the key is kept in
// session storage until the same idle limit that locks the app, the Lock button, or closing the tab. It never reaches disk or the server.
const SESS = 'tbdm-sess';
function b64(u8) { let t = ''; u8.forEach((c) => { t += String.fromCharCode(c); }); return btoa(t); }
async function sessSave() {
  try { const raw = new Uint8Array(await crypto.subtle.exportKey('raw', KEY)); sessionStorage.setItem(SESS, JSON.stringify({ k: b64(raw), s: b64(T.salt), t: Date.now() + IDLE_LOCK_MS })); } catch (e) { /* storage blocked: the PIN is simply asked again */ }
}
function sessTouch() { try { const o = JSON.parse(sessionStorage.getItem(SESS) || 'null'); if (o) { o.t = Date.now() + IDLE_LOCK_MS; sessionStorage.setItem(SESS, JSON.stringify(o)); } } catch (e) { /* ignore */ } }
function sessClear() { try { sessionStorage.removeItem(SESS); } catch (e) { /* ignore */ } }
async function sessRestore() {
  try {
    const o = JSON.parse(sessionStorage.getItem(SESS) || 'null');
    if (!o || !(o.t > Date.now())) { sessClear(); return false; }
    const vault = await kvGet('vault');
    if (!vault) { sessClear(); return false; }
    const key = await crypto.subtle.importKey('raw', Uint8Array.from(atob(o.k), (c) => c.charCodeAt(0)), 'AES-GCM', true, ['encrypt', 'decrypt']);
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: vault.iv }, key, vault.ct);
    T.salt = vault.salt; KEY = key; S = JSON.parse(new TextDecoder().decode(pt)); bumpIdle();
    return true;
  } catch (e) { sessClear(); return false; }
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
  sessSave();
}

// ---- Face ID / fingerprint unlock, as an alternative to the PIN.
// The PIN stays the master secret. At enrolment the PIN is encrypted under a key that the phone's own authenticator releases only after
// a Face ID or fingerprint check (the WebAuthn PRF extension). Nothing the phone stores can open the vault without that check.
// Where the phone or browser cannot do this, the option is not offered: a version that merely hides the PIN behind a button would be weaker than the PIN itself.
function bioIcon() {                                       // a plain face-scan symbol: corner brackets, two eyes, a nose and a smile
  const b = el('span', { class: 'bioico', 'aria-hidden': 'true' });
  b.innerHTML = '<svg viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M6 17V12a6 6 0 0 1 6-6h5M31 6h5a6 6 0 0 1 6 6v5M42 31v5a6 6 0 0 1-6 6h-5M17 42h-5a6 6 0 0 1-6-6v-5"/><path d="M17.5 19v3M30.5 19v3M24 19.5v6.5h-2.2M17.5 31.5c3.8 3.6 9.2 3.6 13 0"/></svg>';
  return b;
}
async function bioAvailable() {
  T.bioWhy = '';
  if (!(window.PublicKeyCredential && navigator.credentials && navigator.credentials.create)) { T.bioWhy = 'WebAuthn: not in this browser'; return false; }
  try { const v = await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable(); T.bioWhy = 'WebAuthn: yes; built-in biometric reported: ' + (v ? 'yes' : 'no'); return !!v; }
  catch (e) { T.bioWhy = 'WebAuthn: yes; check failed (' + (e && e.name) + ')'; return false; }
}
async function bioWrapKey(prf) {
  const base = await crypto.subtle.importKey('raw', prf, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info: new TextEncoder().encode('tbdm pin wrap v1') }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
function prfOut(cred) { const x = cred && cred.getClientExtensionResults && cred.getClientExtensionResults(); return x && x.prf && x.prf.results && x.prf.results.first ? new Uint8Array(x.prf.results.first) : null; }
const rnd = (n) => crypto.getRandomValues(new Uint8Array(n));
async function bioAsk(id, prfSalt) {
  const a = await navigator.credentials.get({ publicKey: { challenge: rnd(32), allowCredentials: [{ type: 'public-key', id, transports: ['internal'] }], userVerification: 'required', hints: ['client-device'], timeout: 60000, extensions: { prf: { eval: { first: prfSalt } } } } });
  return prfOut(a);
}
async function bioEnrol() {
  // Called straight from the tap (the phone only allows Face ID in answer to a tap). The unlocked vault key is what gets locked behind Face ID, so no PIN is typed.
  let step = 'start';
  try {
    if (!KEY) throw new Error('The app is locked.');
    const raw = new Uint8Array(await crypto.subtle.exportKey('raw', KEY)), prfSalt = rnd(32);
    step = 'passkey';
    const cred = await navigator.credentials.create({ publicKey: { rp: { name: 'TBDM Field' }, user: { id: rnd(16), name: S.cfg.email || 'user', displayName: S.cfg.initials || 'user' }, challenge: rnd(32),
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }], authenticatorSelection: { authenticatorAttachment: 'platform', userVerification: 'required', residentKey: 'discouraged' },
      hints: ['client-device'], timeout: 60000, extensions: { prf: { eval: { first: prfSalt } } } } });
    const id = new Uint8Array(cred.rawId);
    step = 'secret';
    const out = prfOut(cred) || await bioAsk(id, prfSalt);               // some phones only report support at creation and give the secret on the next check
    if (!out) throw new Error('This phone or browser cannot lock the app to Face ID or fingerprint. Keep using the PIN.');
    step = 'save';
    const iv = rnd(12), ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await bioWrapKey(out), raw);
    await kvSet('bio', { v: 2, id, prfSalt, iv, ct, salt: T.salt });
    T.hasBio = true;
  } catch (e) { if (e && !e.step) e.step = step; throw e; }
}
async function bioOpen() {
  const b = await kvGet('bio');
  if (!b || b.v !== 2) throw Object.assign(new Error('not set up'), { name: 'OperationError' });
  const out = await bioAsk(b.id, b.prfSalt);
  if (!out) throw new Error('The check did not release the key.');
  const raw = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b.iv }, await bioWrapKey(out), b.ct);
  const key = await crypto.subtle.importKey('raw', raw, 'AES-GCM', true, ['encrypt', 'decrypt']);
  const vault = await kvGet('vault');
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: vault.iv }, key, vault.ct);                    // fails if the vault was reset since
  T.salt = vault.salt; KEY = key; S = JSON.parse(new TextDecoder().decode(pt));
  sessSave();
}
async function bioTurnOn() {
  try { await bioEnrol(); toast('Face ID or fingerprint is on'); }
  catch (e) { toast(e && e.name === 'NotAllowedError' ? 'Cancelled, or the phone refused the Face ID check. Nothing was changed.' : 'Could not turn it on (build ' + BUILD_ID.slice(0, 6) + ', ' + (e && e.step ? e.step + ': ' : '') + (e && e.name) + ': ' + ((e && e.message) || '') + ')'); }
  render();
}
const BIOASK = 'tbdm-bioask';
// After a correct PIN: if this phone can do Face ID or fingerprint and it is not on yet, offer it once. "Not now" is remembered and the offer is not repeated;
// the person can still turn it on in Settings, or by tapping the face icon on the lock screen.
function offerBio() {
  let declined = false; try { declined = localStorage.getItem(BIOASK) === 'no'; } catch (e) { /* ignore */ }
  const wanted = T.bioWant; T.bioWant = false;
  if (!KEY || T.practice || T.hasBio || !T.bioOk || (declined && !wanted)) return;
  modal('Open the app with Face ID or fingerprint?', [el('p', null, 'Next time you can unlock without typing the PIN. The PIN keeps working as a back-up.')],
    [['Not now', () => { try { localStorage.setItem(BIOASK, 'no'); } catch (e) { /* ignore */ } }], ['Set up', bioTurnOn, 'primary']]);
}
async function bioOff() { try { await kvDel('bio'); } catch (e) { /* ignore */ } T.hasBio = false; }

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
  const out = computeDerived_(data(), todayIso(), S && S.server && S.server.held);
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
async function api(body, ms) {
  if (T.practice) throw new Error('practice mode: the app never contacts the study');
  const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), ms || 45000);
  try {
    const r = await fetch(S ? S.cfg.api : T.join.api, { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      signal: ctl.signal, redirect: 'follow', credentials: 'omit', cache: 'no-store' });
    return await r.json();
  } finally { clearTimeout(timer); }
}
// The workbook takes several seconds per entry, and this phone gives up on a request after 45 seconds, so a long queue goes in small batches.
const PUSH_BATCH = 5;
async function sync() {
  if (!S || T.syncing || T.practice) return;
  if (!navigator.onLine) { T.syncError = 'offline'; paintSync(); return; }
  T.syncing = true; paintSync();
  let synced = false;
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
    for (let i = 0; i < pending.length; i += PUSH_BATCH) {
      const batch = pending.slice(i, i + PUSH_BATCH).map((c) => ({ cid: c.cid, tab: c.tab, rid: c.rid, create: c.create, values: c.values, base: c.base, by: c.by }));
      const revs = {}; pending.slice(i, i + PUSH_BATCH).forEach((c) => { revs[c.cid] = c.rev; });
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
    await pushConf(still);
    if (S.server && S.server.photos && (S.photoOut || []).length) await pushPhotos(still);
    const pull = await api({ op: 'pull', token: S.cfg.token }); still();
    if (!pull.ok) throw Object.assign(new Error(pull.error || 'the server refused'), { code: pull.code });
    S.server = { tabs: pull.tabs, films: pull.films || [], regnums: pull.regnums || [], held: pull.held || [], photos: !!pull.photos, access: pull.access || null, accessStored: pull.accessStored || null, at: Date.now() };
    if (pull.photos && (S.photoOut || []).length) await pushPhotos(still);          // photos taken before the feature reached this phone
    if (Array.isArray(pull.held) && S.nums && S.nums.blocks) S.nums.blocks = S.nums.blocks.filter((b) => pull.held.some((h) => h.from === b.from && h.to === b.to));   // the workbook was cleared: blocks it no longer holds are dropped
    T.weak = false; S.cfg.role = pull.role; S.cfg.email = pull.email;
    S.lastSync = Date.now(); T.syncError = ''; T.revoked = false;
    await saveState();
    try { await confRefresh(still); } catch (e) { if (e.quiet || e.code === 401) throw e; }      // a failure here never fails the sync
    synced = true;
  } catch (e) {
    if (e.quiet) return;
    T.syncError = e.name === 'AbortError' ? 'timed out' : (e.message || 'failed');
    if (e.code === 401) { T.revoked = true; if (S === mine) { S.conf = null; S.confOut = []; saveState().catch(() => {}); } }      // a phone that lost access keeps no confidential copy
  } finally {
    T.syncing = false;
    if (T.form && T.form.dirty) paintSync(); else render();
  }
  // Spare study numbers are fetched after the sync has finished and redrawn, so this extra request never delays the redraw
  // (a late redraw can land while someone is typing into a form they have just opened). It changes no screen by itself.
  if (synced && S === mine && !T.practice) topUpNumbers(mine, () => { if (S !== mine) throw Object.assign(new Error('stopped'), { quiet: true }); }).catch(() => {});
}

// ------------------------------------------------------------------ locking
function bumpIdle() { clearTimeout(T.idle); if (KEY) { T.idle = setTimeout(lock, IDLE_LOCK_MS); sessTouch(); } }
function lock() { T.bioTried = false; sessClear(); T.practice = false; T.real = null; KEY = null; S = null; T.form = null; T.reg = null; T.link = null; T.roles = null; resetNav(); T.pin = ''; clearTimeout(T.idle); render(); applyUpdateIfSafe(); }
['pointerdown', 'keydown'].forEach((ev) => document.addEventListener(ev, bumpIdle, { passive: true }));
document.addEventListener('visibilitychange', () => {
  if (document.hidden) T.hiddenAt = Date.now();
  else if (KEY && T.hiddenAt && Date.now() - T.hiddenAt > IDLE_LOCK_MS) lock();
});
window.addEventListener('online', () => { T.weak = false; paintSync(); sync(); });
// Pull down at the top of any screen to sync. The Sync icon in the bar spins while it runs (no extra animation in the page).
(function pullToSync() {
  const PULL = 70; let y0 = null, dy = 0;
  const ready = () => KEY && S && !T.practice && $('#modal').hidden && (window.scrollY || document.documentElement.scrollTop || 0) <= 0;
  document.addEventListener('touchstart', (e) => { y0 = e.touches.length === 1 && ready() && !e.target.closest('.bnav, #modal') ? e.touches[0].clientY : null; dy = 0; }, { passive: true });
  document.addEventListener('touchmove', (e) => { if (y0 !== null) dy = (e.touches[0].clientY - y0) * 0.55; }, { passive: true });
  document.addEventListener('touchend', () => {
    if (y0 === null) return; y0 = null;
    if (dy < PULL) return;
    if (!navigator.onLine) { toast('No internet connection. Entries stay on this phone.'); return; }
    T.spinUntil = Date.now() + 900; setTimeout(paintSync, 950); sync(); paintSync();
  }, { passive: true });
})();
window.addEventListener('offline', paintSync);
['online', 'offline'].forEach((ev) => window.addEventListener(ev, () => { if (KEY && cur().name === 'home') render(); }));   // online-only tiles appear and disappear
setInterval(() => { if (KEY && navigator.onLine && !T.syncing && S.outbox.some((c) => c.status === 'pending')) sync(); }, 120000);

// ------------------------------------------------------------------ navigation
// The in-app stack and the browser history move together, so the edge swipe (right to left) and the Android back gesture go back one screen.
let navSkip = false, navEpoch = 0;   // epoch: bumped when the stack is reset (lock, practice), so older history entries are not replayed
function navSnap() { return { depth: T.nav.length, epoch: navEpoch, nav: JSON.parse(JSON.stringify(T.nav)) }; }   // each history entry remembers the stack it stands for, so going forward can restore it
function resetNav() { T.nav = []; navEpoch++; history.replaceState(navSnap(), ''); }
// set while the app itself moves the history, so the listener does not pop a second time
function go(name, p) { T.nav.push({ name, p: p || {} }); history.pushState(navSnap(), ''); T.form = null; render(); window.scrollTo(0, 0); }
function back() {
  T.nav.pop(); T.form = null; render(); window.scrollTo(0, 0);
  if (history.state && history.state.depth > T.nav.length && history.state.epoch === navEpoch) { navSkip = true; history.back(); }
}
window.addEventListener('popstate', (ev) => {
  if (navSkip) { navSkip = false; return; }
  const want = ev.state && ev.state.depth ? ev.state.depth : 0, ep = ev.state && ev.state.epoch ? ev.state.epoch : 0;
  if (ep !== navEpoch) { navEpoch = ep; T.nav = []; T.form = null; render(); window.scrollTo(0, 0); return; }   // older than the last reset: start screen
  if (want > T.nav.length && ev.state && Array.isArray(ev.state.nav)) { T.nav = ev.state.nav; T.form = null; render(); window.scrollTo(0, 0); return; }   // forward: restore the screen
  if (want >= T.nav.length) { if (want > T.nav.length) history.replaceState(navSnap(), ''); return; }
  if (T.form && T.form.dirty) { history.pushState(navSnap(), ''); confirmLeave(back); return; }   // unsaved changes: ask first, as the Back button does
  while (T.nav.length > want) T.nav.pop();
  T.form = null; render(); window.scrollTo(0, 0);
});
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
    queries: queries, measure: measureList, measurefor: measureFor, attention: attention, films: films, settings: settings, tools: tools, screening: screening, qclog: qclog, register: registerScreen, link: linkScreen, linkpick: linkPick, visits: visitsScreen, visitguide: visitGuideScreen, photos: photosScreen, roles: rolesScreen };
  const body = (screens[c.name] || home)(c.p);
  app.append(...body);
  const hasNav = !!(S && S.server) && navIds().concat(c.name === 'tools' ? ['tools'] : []).indexOf(c.name) >= 0;
  if (hasNav) app.append(bottomNav(c.name === 'tools' ? 'settings' : c.name));
  // iOS home-screen apps (WebKit bug 301994): on a page shorter than the screen, a bar pinned to the bottom floats about one
  // status bar above the real bottom. Pages long enough to scroll are fine, so short pages are made just taller than the screen.
  let sa = false; try { sa = !!(navigator.standalone || (window.matchMedia && matchMedia('(display-mode: standalone)').matches)); } catch (e) { sa = false; }
  app.style.minHeight = hasNav && sa ? (Math.max(screen.height || 0, innerHeight) + 1) + 'px' : '';
}
// Roles that use the visit checklist (not the nurse, the DOTS incharge or the radiology readers).
function hasGuide() { return can('checklist'); }                 // the per-visit checklist follows the Visit checklist tick
function topBar(title, opts) {
  opts = opts || {};
  const bar = el('header', { class: 'top' },          // the title is centred between the left (Back) and right (Lock) slots
    el('div', { class: 'tl' }, T.nav.length ? el('button', { class: 'back', 'aria-label': 'Back', onclick: () => confirmLeave(back) }, '‹ Back') : null),
    // "Laboratory results · TBDM-001" is shown on two lines so a centred title never hides the study number
    el('h1', null, ...(/ · TBDM-\d+/.test(s_(title)) ? [s_(title).replace(/ · (TBDM-\d+.*)$/, ''), el('small', null, s_(title).replace(/^.* · (TBDM-\d+.*)$/, '$1'))] : [title])),
    el('div', { class: 'tr' }, opts.noMenu ? null : el('button', { class: 'icon lockbtn', 'aria-label': 'Lock', title: 'Lock', onclick: (ev) => { const b = ev.currentTarget; confirmLeave(() => { b.classList.add('locking'); setTimeout(lock, 420); }); } }, icon('padlock'))));
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
    el('button', { class: 'syncbtn' + (T.syncing || Date.now() < (T.spinUntil || 0) ? ' spin' : ''), 'aria-label': 'Sync', title: 'Sync', onclick: syncTap, disabled: T.syncing || !online }, icon('sync')));
}
// A tap spins the sync icon for as long as the sync runs, and for at least a moment so a quick one is still seen.
function syncTap() { T.spinUntil = Date.now() + 900; setTimeout(paintSync, 950); sync(); paintSync(); }
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
      await saveState(); sessSave(); T.hasVault = true; T.join = null;
      if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
      bumpIdle(); render(); sync();
    } catch (e) { msg.textContent = e.message; btn.disabled = false; btn.textContent = 'Join'; }
  } }, 'Join');
  return el('div', { class: 'setup' }, el('h2', null, 'Join the TB-DM study'),
    el('div', { class: 'card' }, el('p', { class: 'small muted' }, 'This phone will keep study entries, encrypted, until they are sent. Study entries never contain a name, CNIC, telephone number, address or MRN. Those are recorded only in the confidential Link register, which only the PI and the DOTS incharge can open.')),
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
      await openVault(pin); localStorage.setItem('tbdm-fails', '0'); T.lockMsg = ''; resetNav(); bumpIdle(); render(); sync();
      offerBio();
    } catch (e) {
      const f = fails + 1; localStorage.setItem('tbdm-fails', String(f));
      if (f >= 5) localStorage.setItem('tbdm-wait', String(Date.now() + Math.min(3600, Math.pow(2, f - 4) * 15) * 1000));
      T.lockMsg = 'Wrong PIN.'; render();
    }
  };
  const tryBio = async (auto) => {
    if (T.bioBusy === 'asking') return;                       // one check at a time: a second request would cancel the first and make the phone ask twice
    T.bioBusy = 'asking';
    T.lockMsg = ''; if (!auto) render();
    try { await bioOpen(); localStorage.setItem('tbdm-fails', '0'); T.lockMsg = ''; resetNav(); bumpIdle(); render(); sync(); }
    catch (e) {
      if (e && e.name === 'OperationError') { await bioOff(); T.lockMsg = 'Face ID or fingerprint no longer matches this PIN. Use the PIN, then set it up again in Settings.'; }          // the PIN changed or the key is gone
      else T.lockMsg = auto ? '' : e && e.name === 'NotAllowedError' ? 'Cancelled. Use the PIN, or try again.' : 'Face ID or fingerprint did not open the app. Use the PIN.';          // an automatic try that the phone declines stays quiet
      render();
    } finally { T.bioBusy = false; }
  };
  if (T.hasBio && !T.join && !T.bioTried && !(Date.now() < until)) { T.bioTried = true; T.bioBusy = 'waiting'; setTimeout(() => { if (!KEY && T.hasBio) tryBio(true); else T.bioBusy = false; }, 350); }          // ask for Face ID as soon as the lock screen appears, once per lock; the button stays for another try
  const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'del', '0', 'ok'];
  return el('div', { class: 'lock' }, el('h1', null, 'TBDM Field App'),
    el('p', null, T.join ? 'An invitation link was opened, but this phone is already set up. Unlock, then reset the phone in Settings to use it.' : 'Enter your PIN'),
    dots, el('div', { class: 'pad' }, keys.map((k) => el('button', { class: k.length > 1 ? 'txt' : '', 'aria-label': k === 'del' ? 'Delete' : k === 'ok' ? 'Unlock' : k, onclick: () => press(k) },
      k === 'del' ? 'Delete' : k === 'ok' ? 'Unlock' : k))), err,
    (T.hasBio || T.bioOk) && !T.join ? el('button', { class: 'bio', id: 'bio-unlock', type: 'button', 'aria-label': 'Unlock with Face ID or fingerprint', title: 'Face ID or fingerprint', onclick: () => { if (T.hasBio) tryBio(false); else { T.bioWant = true; T.lockMsg = 'Type your PIN once. You will then be asked to set up Face ID or fingerprint.'; render(); } } }, bioIcon()) : null);
}

// ------------------------------------------------------------------ home and lists
function role() { return S.cfg.role || 'data'; }
// What this phone's role may do: the ticks the PI set in the Role manager, sent with every pull (the workbook enforces them).
// An older workbook sends none: then the defaults apply, which match the access every role had before the Role manager.
function acc() { const src = (T.real && T.real.server) || (S && S.server); return src && src.access ? src.access : accessFor_(role(), null); }
const can = (k) => !!acc()[k];
const isReader = () => role() === 'reader1' || role() === 'reader2';
const limited = () => !isReader() && role() !== 'pi' && !can('view');        // holds only the tabs and columns its ticks need
const confRole = () => can('numbers') || can('ident');
const canData = () => can('screen');
const isNurse = () => limited() && can('measure');                // the measurement view: Measure tab and the short participant page
// The next study number, from this phone's enrolments and screening lines (including ones not yet sent).
// Enrolment first offers a number already given on a screening line (enrolled = Y) that has no enrolment record yet.
function nextId(tab) {
  const re = new RegExp('^' + CFG.ID_PREFIX + '(\\d+)$', 'i'), num = (v) => { const m = re.exec(s_(v)); return m && +m[1] >= 1 && +m[1] <= CFG.ID_MAX ? +m[1] : 0; };
  const enrolled = {}, used = {}, waiting = []; let top = 0;
  view('S1_ENROL').forEach((r) => { const n = num(r.study_id); if (n) { enrolled[n] = used[n] = true; top = Math.max(top, n); } });
  const out = {};   // numbers whose screening line says not eligible or not enrolled: used up, never offered for enrolment
  view('S0_SCREEN').forEach((r) => { const n = num(r.study_id); if (n) { used[n] = true; top = Math.max(top, n); if (r.eligible === 'N' || r.enrolled === 'N') out[n] = true; else if (!enrolled[n] && r.enrolled === 'Y') waiting.push(n); } });
  ((S.server && S.server.regnums) || []).forEach((p) => { const n = num(p[0]); if (n) { used[n] = true; top = Math.max(top, n); if (p[1] === 'E' && !enrolled[n] && !out[n] && waiting.indexOf(n) < 0) waiting.push(n); } });   // numbers the register has given out
  if (tab === 'S1_ENROL' && waiting.length) return idOf_(Math.min.apply(null, waiting));
  if (T.practice) { for (let n = CFG.ID_MAX - 2; n >= 1; n--) if (!used[n]) return idOf_(n); return ''; }   // practice numbers count down from the top of the range
  if (S.nums && S.nums.old) return top >= CFG.ID_MAX ? '' : idOf_(top + 1);   // a workbook script that cannot hand out blocks yet: the old rule, until the PI upgrades it
  const free = ownFree();
  return free.length ? idOf_(free[0]) : '';
}
// Number blocks. The workbook hands this phone its own run of numbers while it is online (numbers_block); offline, only those are offered,
// so two phones that are both offline never offer the same number. A number typed from a patient's card is accepted whatever block it falls in.
function usedNums() {
  const re = new RegExp('^' + CFG.ID_PREFIX + '(\\d+)$', 'i'), used = {}, mark = (v) => { const m = re.exec(s_(v)); if (m) used[+m[1]] = true; };
  view('S1_ENROL').forEach((r) => mark(r.study_id)); view('S0_SCREEN').forEach((r) => mark(r.study_id));
  ((S.server && S.server.regnums) || []).forEach((p) => mark(p[0]));
  (S.confOut || []).forEach((c) => mark(c.body && c.body.study_id)); ((S.conf && S.conf.rows) || []).forEach((r) => mark(r.study_id));
  return used;
}
function ownFree() {
  const used = usedNums(), out = [];
  ((S.nums && S.nums.blocks) || []).forEach((b) => { for (let n = b.from; n <= b.to; n++) if (!used[n]) out.push(n); });
  return out.sort((a, b) => a - b);
}
async function topUpNumbers(mine, still) {              // called by sync() once the pull has succeeded; a failure here never fails the sync
  if (T.practice || !(canData() || can('numbers'))) return;
  const N = S.nums || (S.nums = { dev: '', blocks: [], got: false, old: false, pend: '', err: '' });
  if (!N.dev) N.dev = rid();
  if (N.got && !N.old && ownFree().length > CFG.BLOCK_LOW) return;
  if (!N.pend) N.pend = rid();                          // the same id on a retry, so a lost reply never reserves a second block
  try {
    const res = await api({ op: 'numbers_block', token: S.cfg.token, rid: N.pend, dev: N.dev }); still();
    if (res.ok) { N.blocks = res.blocks || []; N.got = true; N.old = false; N.pend = ''; N.err = ''; }
    else if (res.error === 'unknown operation') { N.old = true; N.err = ''; }          // the workbook script has not been upgraded: keep the old behaviour
    else N.err = res.error || 'could not get numbers';
  } catch (e) { if (e.quiet) throw e; }
  if (S === mine) await saveState();
}
function nextNo() { const n = nextId('S1_ENROL'); return n ? 'Next: ' + n : 'No numbers left'; }
// Screened, eligible and agreed, with a study number, and not yet enrolled. Worked out from this phone's own data, so it needs no signal.
function waitingEnrol() {
  const done = enrolledMap(), out = [];
  view('S0_SCREEN').forEach((r) => { const id = s_(r.study_id).toUpperCase(); if (id && r.eligible === 'Y' && r.enrolled === 'Y' && !done[id] && out.indexOf(id) < 0) out.push(id); });
  return out.sort();
}
// Enrolled numbers whose name, record number and telephone are not yet recorded (known from the last register load; the register is online only)
function identifiersPending(L) { return L && L.link ? L.rows.filter((r) => r.status === 'E' && !r.mrn && !r.phone) : []; }
// Useful at a glance on the Screen tile: how many patients this phone has screened today (including lines not yet sent).
function screenedToday() { const t = todayIso(), n = view('S0_SCREEN').filter((r) => s_(r.screen_date) === t).length; return n ? n + ' screened today' : 'None screened today'; }
function enrolTile() {
  const w = waitingEnrol();
  return el('button', { class: 'tile primary', onclick: () => go('form', { tab: 'S1_ENROL', key: {} }) }, el('b', null, 'Enrolment'),
    el('span', null, w.length ? ['Waiting now:', el('br'), w[0] + (w.length > 1 ? ' and ' + (w.length - 1) + ' more' : '')] : 'Patient Study Number'));
}
// Every patient carries a card with the study number. Typing it here opens whatever that person needs next, whatever the role.
// One rule for every box that takes the number on the patient's card: "7", "07", "007", "TBDM7" and "tbdm 7" all become TBDM-007.
// Anything else is returned tidied but unchanged, so the usual "not a valid study number" check still catches it.
function normId(v) {
  const t = s_(v).trim().toUpperCase().replace(/\s+/g, ''), m = new RegExp('^(?:' + CFG.ID_PREFIX.replace(/-$/, '') + '-?)?(\\d{1,3})$').exec(t);
  return m ? idOf_(+m[1]) : t;
}
function findPatient(raw) {
  const sid = normId(raw);
  if (!idOk_(sid)) { toast('Not a study number. Type it as on the card, for example ' + idOf_(7)); return; }
  recordRecent(sid);
  const e = find('S1_ENROL', { study_id: sid }), sc = view('S0_SCREEN').filter((r) => code_(r.study_id) === sid)[0];
  if (e) { if (can('view')) go('participant', { sid }); else if (can('measure')) go('measurefor', { sid }); else toast(sid + ' is enrolled.'); return; }
  if (sc && sc.eligible === 'Y' && sc.enrolled === 'Y') {
    modal(sid + ' is screened and waiting', [el('p', null, 'Eligible and agreed, not enrolled yet.')],
      [['Close', null], ['Enrol', () => go('form', { tab: 'S1_ENROL', key: {}, preset: { study_id: sid, age_years: sc.age, sex: sc.sex }, carried: ['age_years', 'sex'] }), 'primary']]);
    return;
  }
  if (sc) { modal(sid + ' was screened', [el('p', null, sc.eligible === 'N' ? 'Not eligible' + (sc.excl_code ? ' (exclusion ' + sc.excl_code + ')' : '') + ', so not enrolled.' : 'Screened, not enrolled.')], [['Close', null]]); return; }
  modal(sid + ' is not in the study yet', [el('p', null, 'No screening line has this number on this phone. If the patient was screened on another phone, sync first.')],
    [['Close', null], ['Screen this patient', () => go('form', { tab: 'S0_SCREEN', key: {}, preset: { study_id: sid } }), 'primary']]);
}
// The five patients this phone opened most recently (kept in memory only: nothing is written to the phone).
T.recent = T.recent || [];
T.lastTap = 0;
document.addEventListener('pointerdown', () => { T.lastTap = Date.now(); }, true);
function recordRecent(sid) { if (!sid) return; T.recent = [sid].concat(T.recent.filter((x) => x !== sid)).slice(0, 5); }
function findBox(short) {
  const recent = el('div', { class: 'recent', id: 'recent', hidden: true, role: 'listbox', 'aria-label': 'Recently opened patients' },
    el('div', { class: 'small muted' }, 'Recently opened'),
    ...T.recent.map((sid) => el('button', { type: 'button', class: 'recent-item', onmousedown: (ev) => ev.preventDefault(), onclick: () => { $('#find').value = sid; findPatient(sid); } }, sid)));
  const show = (on) => { const r = $('#recent'); if (r && T.recent.length) r.hidden = !on; };
  return el('div', { class: 'card find' }, el('label', { class: 'lab', for: 'find' }, 'Patient Study Number'),
    el('div', { class: 'inline' },
      el('input', { id: 'find', type: 'tel', inputmode: 'numeric', autocomplete: 'off', autocapitalize: 'characters', placeholder: short ? idOf_(7) : 'e.g. ' + idOf_(7) + ' or 7',
        onfocus: () => show(true),
        oninput: (ev) => { const t = s_(ev.target.value).trim().toUpperCase(); if (/^(TBDM-?)?\d{3}$/.test(t) && idOk_(normId(t))) findPatient(t); },          // a complete three-digit number opens the patient at once
        // The tick (Done) on the number pad only closes the keyboard. If the keyboard closed without the person tapping anything else, open the patient straight away.
        onblur: (ev) => { const box = ev.target; box.value = normId(box.value); setTimeout(() => show(false), 150);
          if (box.value && idOk_(box.value) && Date.now() - T.lastTap > 500) findPatient(box.value); },
        onkeydown: (ev) => { if (ev.key === 'Enter') findPatient(ev.target.value); } }),
      el('button', { class: 'btn primary', type: 'button', id: 'findgo', onclick: () => findPatient($('#find').value) }, 'Open')),
    recent);
}
const ICONS = {
  camera: '<path d="M4 8h3l1.5-2.5h7L17 8h3a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z"/><circle cx="12" cy="13" r="3.5"/>',
  records: '<path d="M6 3h9l4 4v14H6z"/><path d="M14 3v5h5"/><rect x="8.5" y="11" width="8" height="6.5" rx="1"/><path d="m8.5 16 2.5-2.5 2 2 1.5-1.5 2 2"/>',
  ruler: '<rect x="3" y="8" width="18" height="8" rx="1.5"/><path d="M7 8v3M11 8v4M15 8v3M19 8v4"/>',
  home: '<path d="M3 11.5 12 4l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/>',
  people: '<circle cx="9" cy="8" r="3.2"/><path d="M3 20c0-3.3 2.7-5.5 6-5.5s6 2.2 6 5.5"/><circle cx="17" cy="9" r="2.4"/><path d="M16.5 14.6c2.7.2 4.5 2 4.5 4.9"/>',
  due: '<rect x="3.5" y="5" width="17" height="15" rx="2"/><path d="M3.5 10h17M8 3v4M16 3v4"/>',
  query: '<circle cx="12" cy="12" r="8.5"/><path d="M9.6 9.4a2.5 2.5 0 1 1 3.6 2.2c-.8.4-1.2.9-1.2 1.8M12 16.6v.1"/>',
  logs: '<path d="M6 3h9l4 4v14H6z"/><path d="M14 3v5h5M9 13h7M9 17h7"/>',
  list: '<rect x="4.5" y="3.5" width="15" height="17" rx="2"/><path d="m8 9 1.6 1.6L12.5 7.5M8 15.5h8M14 10h2.5"/>',
  phone: '<path d="M6.5 3.5h3l1.5 4-2 1.3a11 11 0 0 0 6.2 6.2l1.3-2 4 1.5v3a2 2 0 0 1-2 2A15.5 15.5 0 0 1 4.5 5.5a2 2 0 0 1 2-2z"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
  padlock: '<rect x="4.5" y="10.5" width="15" height="10" rx="2"/><path class="shackle" d="M8 10.5V8a4 4 0 0 1 8 0v2.5"/><path d="M12 14.5v2.5"/>',
  lock: '<rect x="4.5" y="10.5" width="15" height="10" rx="2"/><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5M12 14.5v2.5"/>',
  sync: '<path d="M20 11a8 8 0 0 0-14.3-4.6L4 8.5M4 4v4.5h4.5M4 13a8 8 0 0 0 14.3 4.6l1.7-2.1M20 20v-4.5h-4.5"/>',
  export: '<path d="M12 14.5v-11M7.5 8 12 3.5 16.5 8M4.5 16.5v2a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-2"/>',
  update: '<path d="M12 3.5v11M7.5 10l4.5 4.5 4.5-4.5M4.5 16.5v2a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-2"/>',
  face: '<path d="M4 8V6a2 2 0 0 1 2-2h2M16 4h2a2 2 0 0 1 2 2v2M20 16v2a2 2 0 0 1-2 2h-2M8 20H6a2 2 0 0 1-2-2v-2M9 9.5v1M15 9.5v1M12 9.5v3.5h-1M9.2 15.6a4 4 0 0 0 5.6 0"/>',
  practice: '<path d="M2.5 9 12 4.5 21.5 9 12 13.5z"/><path d="M6.5 11v4.5c0 1.5 2.5 3 5.5 3s5.5-1.5 5.5-3V11M21.5 9v5"/>',
  check: '<path d="M9 3.5h6l1 2h2.5a1 1 0 0 1 1 1V20a1 1 0 0 1-1 1h-13a1 1 0 0 1-1-1V6.5a1 1 0 0 1 1-1H8z"/><path d="m8.5 13 2.4 2.4 4.6-4.8"/>',
  roles: '<rect x="3.5" y="3.5" width="17" height="17" rx="2.5"/><path d="M3.5 9.5h17M3.5 14.5h17M9.5 3.5v17"/><path d="m12.2 12 1.3 1.3 2.6-2.6"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M18.7 5.3l-2.1 2.1M7.4 16.6l-2.1 2.1"/>'
};
const ICON_DETAIL = { due: [1], query: [1], list: [1], ruler: [1] };   // inner strokes that must stay visible when the bar icon is filled
function icon(k) { const s = el('span', { class: 'ico', 'aria-hidden': 'true' }); s.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' + ICONS[k] + '</svg>'; { (ICON_DETAIL[k] || []).forEach((i) => { const c = s.querySelector('svg').children[i]; if (c) c.setAttribute('class', 'd'); }); } return s; }
// Every role gets the bar; the roles differ only in which tabs appear.
function navIds() {
  if (isReader()) return ['home', 'films', 'settings'];
  const ids = ['home'];
  if (can('view')) ids.push('participants'); else if (can('measure')) ids.push('measure');
  if (can('due')) ids.push('due');
  if (can('queries')) ids.push('queries');
  if (can('checklist')) ids.push('visits');
  if (can('contacts')) ids.push('linkpick');
  if (can('numbers') || can('ident')) ids.push('register');
  return ids.concat(['settings']);
}
const NAV_TABS = [['home', 'Home', 'home'], ['measure', 'Measure', 'ruler'], ['participants', 'Participants', 'people'], ['due', 'Due', 'due'], ['queries', 'Queries', 'query'], ['visits', 'Checklist', 'list'], ['films', 'Films', 'list'], ['linkpick', 'Contacts', 'phone'], ['register', 'Link register', 'link'], ['settings', 'Settings', 'settings']];
function tabTo(name) { confirmLeave(() => { resetNav(); if (name === 'register' && T.reg) T.reg.list = null; if (name !== 'home') go(name); else { T.form = null; render(); window.scrollTo(0, 0); } }); }
// The bar can be rearranged: hold a tab for a moment, then slide it left or right. The order is kept on this phone (not sensitive, not sent anywhere).
const NAVKEY = 'tbdm-nav';
function navSaved() { try { const v = JSON.parse(localStorage.getItem(NAVKEY) || 'null'); return Array.isArray(v) ? v : []; } catch (e) { return []; } }
function navOrdered(tabs) { const o = navSaved(), rank = (t) => { const i = o.indexOf(t[0]); return i < 0 ? 999 : i; }; return tabs.map((t, i) => [t, i]).sort((a, b) => rank(a[0]) - rank(b[0]) || a[1] - b[1]).map((x) => x[0]); }
function navDrag(nav) {
  let timer = 0, drag = null, sx = 0, sy = 0, swallow = false, edge = 0;
  const btns = () => Array.from(nav.querySelectorAll('.bn'));
  const stop = (save) => {
    clearTimeout(timer); clearInterval(edge);
    if (drag) {
      drag.el.classList.remove('dragging'); drag.el.style.transform = ''; nav.classList.remove('dragmode');
      if (save) { try { localStorage.setItem(NAVKEY, JSON.stringify(btns().map((b) => b.dataset.tab))); } catch (e) { /* ignore */ } }
      drag = null; swallow = true; setTimeout(() => { swallow = false; }, 350);
    }
  };
  const follow = (x) => {
    const e = drag.el; e.style.transform = '';
    const mid = (r) => r.left + r.width / 2;
    let moved = true;
    while (moved) {                                                    // swap with a neighbour once the finger passes its middle
      moved = false; const r = e.getBoundingClientRect(), prev = e.previousElementSibling, next = e.nextElementSibling;
      if (prev && x < mid(prev.getBoundingClientRect())) { nav.insertBefore(e, prev); moved = true; }
      else if (next && x > mid(next.getBoundingClientRect())) { nav.insertBefore(next, e); moved = true; }
    }
    const r2 = e.getBoundingClientRect(); e.style.transform = 'translateX(' + Math.round(x - (r2.left + r2.width / 2)) + 'px) scale(1.08)';
    drag.x = x;
  };
  nav.addEventListener('touchmove', (ev) => { if (drag) ev.preventDefault(); }, { passive: false });          // no sideways scrolling while a tab is being carried
  nav.addEventListener('contextmenu', (ev) => ev.preventDefault());
  nav.addEventListener('click', (ev) => { if (swallow) { ev.stopPropagation(); ev.preventDefault(); } }, true);
  btns().forEach((b) => {
    b.addEventListener('pointerdown', (ev) => {
      if (drag) return; sx = ev.clientX; sy = ev.clientY; clearTimeout(timer);
      timer = setTimeout(() => {
        drag = { el: b, x: sx }; b.classList.add('dragging'); nav.classList.add('dragmode');
        try { b.setPointerCapture(ev.pointerId); } catch (e) { /* ignore */ }
        if (navigator.vibrate) navigator.vibrate(15);
        follow(sx);
        edge = setInterval(() => { if (!drag) return; const r = nav.getBoundingClientRect(); if (drag.x < r.left + 36) nav.scrollLeft -= 8; else if (drag.x > r.right - 36) nav.scrollLeft += 8; follow(drag.x); }, 30);
      }, 450);
    });
    b.addEventListener('pointermove', (ev) => {
      if (drag) { follow(ev.clientX); return; }
      if (Math.abs(ev.clientX - sx) > 10 || Math.abs(ev.clientY - sy) > 10) clearTimeout(timer);                 // the person is scrolling, not holding
    });
    ['pointerup', 'pointercancel'].forEach((n) => b.addEventListener(n, () => { clearTimeout(timer); stop(true); }));
  });
}
function bottomNav(active) {
  let dueN = 0, qN = 0;
  try { const d = derived(); dueN = d.schedule.filter((r) => r[5] !== 'upcoming').length; qN = d.queries.length; } catch (e) { dueN = 0; qN = 0; }
  const pend = T.practice || !confCopy() && !(T.reg && T.reg.list) ? 0 : identifiersPending(T.reg && T.reg.list ? T.reg.list : confAsList()).length;
  const ids = navIds();
  const tabs = navOrdered(NAV_TABS.filter((t) => ids.indexOf(t[0]) >= 0 && ((t[0] !== 'linkpick' && t[0] !== 'register') || !T.practice)));
  const nav = el('nav', { class: 'bnav', 'aria-label': 'Main' }, tabs.map((t) => el('button', { class: 'bn' + (t[0] === active ? ' on' : ''), 'data-tab': t[0], 'aria-current': t[0] === active ? 'page' : null, onclick: () => tabTo(t[0]) },
    icon(t[2]), t[0] === 'due' && dueN ? el('i', { class: 'badge' }, String(dueN)) : t[0] === 'queries' && qN ? el('i', { class: 'badge' }, String(qN)) : t[0] === 'register' && pend ? el('i', { class: 'badge' }, String(pend)) : null, el('span', { class: 'lbl' }, t[1]))));
  navDrag(nav);
  // The top indicator slides from the tab that was selected to the new one (the bar is rebuilt on every screen, so its last place is remembered).
  const slide = el('i', { class: 'slide', 'aria-hidden': 'true' }); nav.append(slide);
  const place = (b) => { const w = b.offsetWidth; return { x: Math.round(b.offsetLeft + w * 0.22), w: Math.round(w * 0.56) }; };
  queueMicrotask(() => {
    const on = nav.querySelector('.bn.on'); if (!on) { slide.style.display = 'none'; return; }
    const to = place(on), prev = T.navPos && T.navPos.id !== active ? T.navPos : null, from = prev && nav.querySelector('[data-tab="' + prev.id + '"]');
    if (T.navScroll) nav.scrollLeft = T.navScroll;
    const set = (q) => { slide.style.width = q.w + 'px'; slide.style.transform = 'translateX(' + q.x + 'px)'; };
    const calm = !(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches);
    if (from && calm) { set(place(from)); void slide.offsetWidth; slide.classList.add('go'); }
    set(to); T.navPos = { id: active };
    if (on.scrollIntoView) on.scrollIntoView({ block: 'nearest', inline: 'center', behavior: calm && from ? 'smooth' : 'auto' });
    nav.addEventListener('scroll', () => { T.navScroll = nav.scrollLeft; }, { passive: true });
  });          // the selected tab is always in view
  return nav;
}
function feedCard(cls, title, count, rows, onAll, none) {
  return el('div', { class: 'feed ' + cls },
    el('button', { class: 'feedhead', onclick: onAll }, el('b', null, title), el('span', { class: 'fcount' }, String(count)), el('span', { class: 'chev' })),
    rows.length ? rows.slice(0, 3).map((r) => el('button', { class: 'feedrow', onclick: r.go }, el('span', { class: 'fmain' }, r.main, r.sub ? el('small', null, r.sub) : null), r.chip ? el('span', { class: 'chip ' + (r.chipCls || '') }, r.chip) : null)) : el('div', { class: 'feednone' }, none),
    count > 3 ? el('button', { class: 'feedmore', onclick: onAll }, 'See all ' + count) : null);
}
// One home for every role: the same layout (sync warnings, number box and quick buttons, then lists of what needs attention, then recent
// activity). The roles differ only in which blocks appear, each block built from data that role already holds on the phone.
function homeWarn(bad, waiting, oldest) {
  return bad.length ? el('button', { class: 'card alert row', onclick: () => go('attention') }, el('div', { class: 'main' }, el('div', null, bad.length + ' entr' + (bad.length > 1 ? 'ies need' : 'y needs') + ' fixing'), el('div', { class: 'sub' }, 'The workbook did not accept them. Tap to see why.')), el('span', { class: 'chev' })) :
    waiting.length && Date.now() - oldest > 864e5 ? el('div', { class: 'card warn' }, el('b', null, 'Entries have waited more than a day.'), el('div', { class: 'small' }, 'Connect to the internet and press Sync. Until then they exist only on this phone.')) : null;
}
function recentBlock(sent) {
  return [el('h2', null, 'Recent activity'),
    el('div', { class: 'card feedcard' },
      T.recent.length ? [el('div', { class: 'small muted' }, 'Opened on this phone'), el('div', { class: 'chips' }, T.recent.map((sid) => el('button', { class: 'rchip', onclick: () => findPatient(sid) }, sid)))] : el('div', { class: 'small muted' }, 'Nothing opened yet in this session.'),
      el('div', { class: 'small muted fsent' }, sent))];
}
// Measurements the nurse can take now: the baseline if missing, and any open nurse visit not yet entered.
function measuresDue() {
  const out = [];
  view('S1_ENROL').filter((r) => r.study_id).sort((a, b) => (a.study_id < b.study_id ? -1 : 1)).forEach((r) => {
    const sid = r.study_id, need = [];
    if (!find('S2_BASELINE', { study_id: sid }) && !visitOpens(sid, 'V1')) need.push('V1 baseline');
    NURSE_VISITS.forEach((v) => { if (!visitOpens(sid, v) && !find('VISITS', { study_id: sid, visit: v })) need.push(v); });
    if (need.length) out.push({ sid, need });
  });
  return out;
}
function piHome(out, bad, waiting, oldest, dueN) {
  const nurse = isNurse(), due = out.schedule.filter((r) => r[5] !== 'upcoming'), w = canData() ? waitingEnrol() : [], idp = confRole() && !T.practice ? identifiersPending((T.reg && T.reg.list) || confAsList()) : [];
  const group = {}; out.queries.forEach((q) => { const g = q[0] || 'Screening log'; (group[g] = group[g] || []).push(q); });
  const qkeys = Object.keys(group).sort(), md = nurse ? measuresDue() : [];
  const main = el('main', { class: 'pihome' },
    homeWarn(bad, waiting, oldest),
    el('div', { class: 'homerow' + (canData() ? '' : ' solo') },
      findBox(true),
      canData() ? el('button', { class: 'tile primary', onclick: () => go('form', { tab: 'S0_SCREEN', key: {} }) }, el('b', null, 'Screen a patient'), el('span', null, screenedToday())) : null,
      canData() ? enrolTile() : null),
    can('numbers') && !canData() ? el('div', { class: 'homerow solo' }, assignTile()) : null,
    nurse ? feedCard('due ' + (md.length ? 'hot' : 'calm'), 'Measurements to take', md.length,
      md.map((m) => ({ main: m.sid, sub: m.need.join(', '), chip: String(m.need.length), chipCls: 'warn', go: () => go('measurefor', { sid: m.sid }) })), () => go('measure'), 'Nothing to measure') : null,
    !can('due') ? null : feedCard('due ' + (dueN ? 'hot' : 'calm'), 'Due and overdue', due.length,
      due.map((r) => ({ main: dueLabel(r), sub: winTxt(r), chip: r[5], chipCls: r[5] === 'overdue' ? 'bad' : 'warn', go: () => go('participant', { sid: r[0] }) })), () => go('due'), 'Nothing due'),
    !can('queries') ? null : feedCard('queries ' + (out.queries.length ? 'hot' : 'calm'), 'Open queries', out.queries.length,
      qkeys.map((g) => ({ main: g, sub: group[g][0][4] + (group[g].length > 1 ? ' and ' + (group[g].length - 1) + ' more' : ''), chip: String(group[g].length), chipCls: 'bad', go: () => openQuery(group[g][0]) })), () => go('queries'), 'No queries'),
    w.length ? feedCard('wait', 'Waiting to enrol', w.length, w.map((id) => ({ main: id, sub: 'Screened, eligible, agreed', go: () => findPatient(id) })), () => go('form', { tab: 'S1_ENROL', key: {} }), '') : null,
    confQueue(),
    idp.length ? feedCard('conf', 'Identifiers pending', idp.length, idp.map((r) => ({ main: r.study_id || r.id || 'Enrolled', sub: 'Name, record number and telephone not recorded', go: () => { if (T.reg) T.reg.list = null; go('register'); } })), () => { if (T.reg) T.reg.list = null; go('register'); }, '') : null,
    recentBlock(waiting.length ? waiting.length + ' waiting to send' : 'All entries sent'));
  return topBar('TBDM Field').concat([main]);
}
function toRegister() { if (T.reg) T.reg.list = null; go('register'); }
function assignTile() {
  const spare = ownFree().length;
  return el('button', { class: 'tile primary', onclick: toRegister }, el('b', null, 'Assign a study number'), el('span', null, spare ? spare + ' spare number' + (spare === 1 ? '' : 's') + ' on this phone' : 'Online: next number from the register'));
}
function confQueue() {
  const q = confRole() ? S.confOut || [] : [];
  return q.length ? feedCard('due hot', 'Waiting to send', q.length, q.map((c) => ({ main: s_(c.body.study_id) || 'New number', sub: c.err ? 'Not accepted: ' + c.err : 'Saved on this phone, sent at the next sync', chip: c.err ? 'fix' : 'unsent', chipCls: c.err ? 'bad' : 'warn', go: toRegister })), toRegister, '') : null;
}
// A role with no study data on this phone (by default the DOTS incharge): the home lists the register work, if it has any.
function dotsHome() {
  if (!confRole()) return topBar('TBDM Field').concat([el('main', { class: 'pihome' }, el('div', { class: 'card' }, el('b', null, 'Nothing to do on this phone yet.'), el('div', { class: 'small' }, 'Your role has no tasks switched on. The PI sets them in the Role manager.')))]);
  const L = T.reg && T.reg.list && !T.reg.list.cached && linkUp() ? T.reg.list : confAsList(), idp = identifiersPending(L), q = S.confOut || [];
  const main = el('main', { class: 'pihome' },
    can('numbers') ? el('div', { class: 'homerow solo' }, assignTile()) : null,
    feedCard('conf', 'Identifiers pending', idp.length, idp.map((r) => ({ main: r.study_id, sub: 'Name, record number and telephone not recorded', go: toRegister })), toRegister, L ? 'All enrolled numbers have identifiers' : 'Open the Link register once while online'),
    confQueue(),
    el('h2', null, 'Recent activity'),
    el('div', { class: 'card feedcard' }, el('div', { class: 'small muted' }, L && L.at ? 'Register copy saved ' + new Date(L.at).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : L ? 'Register up to date' : 'No copy of the register on this phone yet'),
      el('div', { class: 'small muted fsent' }, q.length ? q.length + ' waiting to send' : 'All entries sent')));
  return topBar('TBDM Field').concat([main]);
}
// Radiograph readers: films to score first, then what they have scored. Nothing clinical is held on this phone.
function filmLists() {
  const fl = (S.server && S.server.films) || [], mine = view('R_SCORES');
  const has = (sid, n) => mine.some((r) => r.study_id === sid && r.read_no === n);
  const todo = fl.filter((f) => !has(f.study_id, '1') || (f.repeat && !has(f.study_id, '2')));
  return { fl, mine, has, todo, done: fl.filter((f) => todo.indexOf(f) < 0) };
}
function readerHome(bad, waiting, oldest) {
  const { has, todo, done } = filmLists();
  const open = (f, n) => go('form', { tab: 'R_SCORES', key: { study_id: f.study_id, read_no: n } });
  const main = el('main', { class: 'pihome' },
    homeWarn(bad, waiting, oldest),
    feedCard('due ' + (todo.length ? 'hot' : 'calm'), 'Films to score', todo.length, todo.map((f) => { const n = !has(f.study_id, '1') ? '1' : '2'; return { main: f.study_id, sub: 'film of ' + (f.cxr_date || '?') + (n === '2' ? ' · repeat read requested' : ''), chip: n === '2' ? 'repeat' : 'new', chipCls: 'warn', go: () => open(f, n) }; }), () => go('films'), 'Nothing to score'),
    feedCard('calm', 'Scored', done.length, done.map((f) => ({ main: f.study_id, sub: 'film of ' + (f.cxr_date || '?'), go: () => open(f, '1') })), () => go('films'), 'None yet'),
    el('h2', null, 'Recent activity'),
    el('div', { class: 'card feedcard' }, el('div', { class: 'small muted' }, 'Score each film from the image alone. You see no clinical or group information, and nobody but you and the PI sees your scores.'),
      el('div', { class: 'small muted fsent' }, waiting.length ? waiting.length + ' waiting to send' : 'All entries sent')));
  return topBar('TBDM Field').concat([main]);
}
function toolRow(title, sub, fn) { return el('button', { class: 'row', onclick: fn }, el('div', { class: 'main' }, el('div', null, title), el('div', { class: 'sub' }, sub)), el('span', { class: 'chev' })); }
function tools() {
  return topBar('Logs and tools').concat([el('main', null,
    el('div', { class: 'list' },
      toolRow('Screening log', view('S0_SCREEN').length + ' screened', () => go('screening')),
      toolRow('Verification log', view('QC_LOG').length + ' checks', () => go('qclog'))),
    T.practice ? null : [el('h2', null, 'Training'), el('div', { class: 'list' }, toolRow('Practice', 'Learn with made-up patients', () => modal('Start practice mode?', [el('p', null, 'You will work on made-up participants. Nothing is saved or sent to the study. Your real entries are kept safe and come back when you leave practice.')], [['Cancel', null], ['Start practice', practiceStart, 'primary']])))])]);
}
function home() {
  if (!isReader() && !can('view') && !can('screen') && !can('measure')) return dotsHome();      // a role with no study data on this phone (the register only, or nothing)
  if (!S.server) return topBar('TBDM Field').concat([el('main', null, el('div', { class: 'card' }, navigator.onLine ? 'Fetching the study data…' : 'Connect to the internet once to fetch the study data.'))]);
  const out = !can('view') ? { schedule: [], queries: [] } : derived(), bad = S.outbox.filter((c) => c.status !== 'pending'), waiting = S.outbox.filter((c) => c.status === 'pending');
  const oldest = waiting.reduce((m, c) => Math.min(m, c.at), Infinity);
  if (role() === 'reader1' || role() === 'reader2') return readerHome(bad, waiting, oldest);
  return piHome(out, bad, waiting, oldest, out.schedule.filter((r) => r[5] !== 'upcoming').length);
}
// ---- Role manager (PI only): one tick per task and role. The PI and reader columns are fixed (full access; blinded film scoring).
// A tick that needs the full clinical data switches 'view' on with it, and switching 'view' off clears those ticks. Saved to the
// workbook, which enforces it; each phone gets the change at its next sync.
function rolesDraft() {
  if (!T.roles) { const st = (S.server && S.server.accessStored) || {}, d = {}; ACCESS_ROLES.forEach((r) => { d[r] = accessFor_(r, st); }); T.roles = { d, dirty: false, busy: false, msg: '' }; }
  return T.roles;
}
function rolesToggle(r, k) {
  const R = rolesDraft(), row = R.d[r], on = !row[k], key = ACCESS_KEYS.filter((x) => x.key === k)[0];
  const apply = () => {
    row[k] = on;
    if (on && key.need) row[key.need] = true;                                                          // a tick that needs 'view' (or 'ident') brings it
    if (!on) ACCESS_KEYS.forEach((x) => { if (x.need === k) row[x.key] = false; });                   // and switching that off clears what depends on it
    R.dirty = true; R.msg = ''; render();
  };
  if (on && key.confidential && r !== 'dots') {
    modal('Give ' + ACCESS_ROLE_NAMES[r] + ' access to identifiers?', [el('p', null, 'Names, record numbers and telephone numbers are covered by your ethics approval. They reach a phone only while the confidential register switch is on, and every download is written to the audit log.')], [['Cancel', null], ['Give access', apply, 'primary']]);
    return;
  }
  apply();
}
async function rolesSave() {
  const R = rolesDraft();
  if (R.busy) return;
  if (!navigator.onLine) { R.msg = 'Connect to the internet to save. Your ticks are kept until you leave this page.'; render(); return; }
  R.busy = true; R.msg = ''; render();
  try {
    const res = await api({ op: 'access_set', token: S.cfg.token, access: R.d });
    if (!res.ok) throw new Error(res.error || 'not saved');
    S.server.accessStored = res.accessStored; await saveState();
    ACCESS_ROLES.forEach((r) => { R.d[r] = accessFor_(r, res.accessStored); });
    R.dirty = false; R.msg = res.changed ? 'Saved. Each phone gets the change at its next sync.' : 'Saved. Nothing had changed.';
  } catch (e) { R.msg = 'Not saved. ' + (e.message || e); }
  R.busy = false; render();
}
function rolesScreen() {
  if (role() !== 'pi' || T.practice) return topBar('Role manager').concat([el('main', null, el('div', { class: 'card' }, 'The Role manager is for the PI only.'))]);
  if (!S.server || !S.server.accessStored) return topBar('Role manager').concat([el('main', null, el('div', { class: 'card warn' }, el('b', null, 'Update the workbook script first.'), el('div', { class: 'small' }, 'The workbook is still on a version without role access. Run PI: update script from GitHub in the workbook, then sync this phone. Until then every role keeps its usual access.')))]);
  const R = rolesDraft(), cols = ['pi'].concat(ACCESS_ROLES).concat(['reader']);
  const short = { pi: 'PI', data: 'Data', qc: 'Verif.', nurse: 'Nurse', dots: 'DOTS', reader: 'Reader' };
  const cell = (r, k) => {
    if (r === 'pi') return el('td', { class: 'acc fixed' }, el('span', { class: 'tick on', 'aria-label': 'on, fixed' }));
    if (r === 'reader') return el('td', { class: 'acc fixed' }, el('span', { class: 'tick', 'aria-label': 'off, fixed' }));
    const on = R.d[r][k];
    return el('td', { class: 'acc' }, el('button', { type: 'button', class: 'tick' + (on ? ' on' : ''), 'data-r': r, 'data-k': k, 'aria-pressed': on ? 'true' : 'false', 'aria-label': ACCESS_ROLE_NAMES[r] + ': ' + ACCESS_KEYS.filter((x) => x.key === k)[0].label, onclick: () => rolesToggle(r, k) }));
  };
  const table = el('table', { class: 'accgrid' },
    el('thead', null, el('tr', null, el('th', { class: 'task' }, 'Task'), cols.map((r) => el('th', { title: ACCESS_ROLE_NAMES[r] }, short[r])))),
    el('tbody', null,
      ACCESS_KEYS.map((k) => el('tr', { class: k.confidential ? 'conf' : '' }, el('th', { class: 'task', scope: 'row' }, k.label, k.need ? el('small', null, k.need === 'view' ? 'needs full clinical data' : 'needs names, MRN, telephone') : null), cols.map((r) => cell(r, k.key)))),
      el('tr', { class: 'fixedrow' }, el('th', { class: 'task', scope: 'row' }, 'Score chest films', el('small', null, 'readers only, blinded')), cols.map((r) => el('td', { class: 'acc fixed' }, el('span', { class: 'tick' + (r === 'reader' ? ' on' : '') }))))));
  return topBar('Role manager').concat([el('main', null,
    el('div', { class: 'card small' }, 'Tap a box to switch a task on or off for everyone in that role. The PI and reader columns are fixed. The workbook enforces these ticks; phones pick them up at their next sync.'),
    el('div', { class: 'accwrap' }, table),
    el('div', { class: 'card small muted' }, 'Names, MRN and telephone reach a phone only while the confidential register switch is on, whatever the ticks say. Document photos only while the photo switch is on.'),
    R.msg ? el('div', { class: 'card ' + (/^Saved/.test(R.msg) ? 'ok' : 'warn'), id: 'rolesmsg' }, R.msg) : null,
    el('div', { class: 'row2' },
      el('button', { class: 'btn block', type: 'button', disabled: R.busy, onclick: () => { ACCESS_ROLES.forEach((r) => { R.d[r] = accessFor_(r, null); }); R.dirty = true; R.msg = ''; render(); } }, 'Back to defaults'),
      el('button', { class: 'btn primary block', type: 'button', id: 'rolesave', disabled: R.busy || !R.dirty, onclick: rolesSave }, R.busy ? 'Saving…' : 'Save')))]);
}
// ---- study numbers register (PI and DOTS incharge). Online only. Nothing about it is kept on the phone.
const REG_STATUS_OPTS = [['E', 'Enrolled'], ['D', 'Declined'], ['S', 'Spoiled']];
// ---- the PI phone keeps an encrypted copy of the confidential register, so Link and Link register work with no signal.
// It lives in the PIN-protected vault with the other study data, is refreshed at every sync, and is wiped when the confidential link is
// switched off or this phone loses access. New numbers and changes made offline wait in S.confOut and are sent at the next sync.
// A phone with one bar of signal reports "online" yet cannot finish a request. For the confidential screens a saved copy exists, so a request
// that fails or takes longer than FAST_MS switches them to that copy (T.weak) instead of making the user wait, until the next request that succeeds.
const FAST_MS = 3000;
const linkUp = () => navigator.onLine && !(T.weak && Date.now() - T.weakAt < 60000 && confCopy());       // after a minute it tries the network again
const netFail = (e) => !!e && (e.name === 'AbortError' || e.name === 'TypeError');
async function confApi(body) {
  if (!confCopy()) return api(body);                    // no saved copy to fall back on: wait as long as it takes
  try { const r = await api(body, FAST_MS); T.weak = false; return r; }
  catch (e) { if (netFail(e)) { T.weak = true; T.weakAt = Date.now(); } throw e; }
}
function confCopy() { return confRole() && !T.practice && S.conf && S.conf.rows ? S.conf : null; }
async function confSave(res) {
  if (!confRole() || T.practice || !res || !res.ok) return;
  S.conf = res.link ? { at: Date.now(), next: res.next, rows: res.rows.map((r) => Object.assign({}, r)) } : null;
  await saveState();
}
// the list as this phone knows it: the saved copy with the changes still waiting to be sent laid over it
function overlay(L) {
  const out = (S.confOut || []).filter((c) => c.kind === 'add' || c.kind === 'set');
  if (!L || !out.length) return L;
  const rows = L.rows.map((r) => Object.assign({}, r)), by = {}; rows.forEach((r) => { by[s_(r.study_id).toUpperCase()] = r; });
  out.forEach((c) => {
    const id = s_(c.body.study_id).toUpperCase(), r = by[id];
    if (c.kind === 'add' && !r) { const n = { study_id: id, assigned_date: todayIso(), status: c.body.status, reason: c.body.reason || '', mrn: c.body.mrn || '', phone: c.body.phone || '', name: c.body.name || '', guardian: c.body.guardian || '', address: c.body.address || '', note: '', pending: true }; rows.push(n); by[id] = n; }
    else if (r && c.kind === 'set') Object.assign(r, { name: c.body.name, mrn: c.body.mrn, phone: c.body.phone, guardian: c.body.guardian, address: c.body.address, note: c.body.note, pending: true });
  });
  rows.sort((a, b) => (a.study_id < b.study_id ? -1 : 1));
  return Object.assign({}, L, { rows });
}
function confAsList() { const C = confCopy(); return C ? overlay({ ok: true, rows: C.rows, next: C.next, link: true, cached: true, at: C.at }) : null; }
// sent at each sync, after the study entries; a rejected item stays listed with the reason until it is fixed or discarded
async function pushConf(still) {
  if (!confRole() || !(S.confOut || []).length) return;
  for (const c of S.confOut.slice()) {
    const body = c.kind === 'add' ? Object.assign({ op: 'register_add', token: S.cfg.token, rid: c.id }, c.body) : Object.assign({ op: 'link_set', token: S.cfg.token }, c.body);
    const res = await api(body); still();
    if (res.ok) { const i = S.confOut.indexOf(c); if (i >= 0) S.confOut.splice(i, 1); c.err = ''; }
    else if (res.code === 401) throw Object.assign(new Error(res.error || 'not authorised'), { code: 401 });
    else c.err = res.error || 'not accepted';
    await saveState();
  }
}
async function confRefresh(still) {
  if (!confRole() || T.practice) return;
  const res = await api({ op: 'register_list', token: S.cfg.token }); still();
  if (res.ok) { await confSave(res); const st = T.reg; if (st && st.list) st.list = overlay(res); }
}
function regState() { return T.reg || (T.reg = { list: null, loading: false, err: '', done: '', busy: false, status: 'E', name: '', mrn: '', phone: '', reason: '', guardian: '', address: '', sid: '', pendingRid: null, q: '' }); }
async function regLoad() {
  const st = regState();
  st.err = '';
  if (!linkUp()) { if (!confCopy()) st.err = 'No internet connection, and no copy of the register is saved on this phone yet. Open it once while online.'; render(); return; }
  st.loading = true; render();
  try {
    const res = await confApi({ op: 'register_list', token: S.cfg.token });
    if (!res.ok) throw new Error(res.error || 'could not load');
    st.list = overlay(res); await confSave(res);
  } catch (e) {
    if (T.weak && confCopy()) { st.list = confAsList(); st.loading = false; render(); return; } st.err = 'Could not load the register. ' + e.message; }
  st.loading = false; render();
}
async function regAssign() {
  const st = regState();
  if (st.busy) return;
  if (!linkUp() && !confCopy()) { st.err = 'No internet connection. Nothing was assigned.'; render(); return; }
  if (st.list && st.list.link && st.status !== 'S' && (!s_(st.name).trim() || !s_(st.mrn).trim() || !s_(st.phone).trim())) { st.err = 'Not assigned. The participant name, the record number and the telephone number are all required.'; render(); return; }
  st.pendingRid = st.pendingRid || rid();              // the same id on a retry, so a number is never assigned twice
  if (!linkUp()) {                              // offline: kept on this phone, encrypted, and sent at the next sync
    const first = ownFree()[0], sid = normId(st.sid) || (first ? idOf_(first) : '');
    if (!sid || !idOk_(sid)) { st.err = 'No spare number on this phone. Type the number from the patient card.'; render(); return; }
    if ((S.confOut || []).some((c) => c.kind === 'add' && s_(c.body.study_id).toUpperCase() === sid) || ((S.conf && S.conf.rows) || []).some((r) => s_(r.study_id).toUpperCase() === sid)) { st.err = sid + ' is already in the register.'; render(); return; }
    (S.confOut = S.confOut || []).push({ id: st.pendingRid, kind: 'add', at: Date.now(), err: '', body: { status: st.status, reason: st.reason, name: st.name, mrn: st.mrn, phone: st.phone, guardian: st.guardian, address: st.address, study_id: sid } });
    await saveState();
    st.done = 'Saved on this phone: ' + sid + '. It is sent when you are back online.';
    st.pendingRid = null; st.name = ''; st.mrn = ''; st.phone = ''; st.guardian = ''; st.address = ''; st.sid = ''; st.reason = ''; st.status = 'E';
    st.list = confAsList(); render(); return;
  }
  const body = { op: 'register_add', token: S.cfg.token, rid: st.pendingRid, status: st.status, reason: st.reason, name: st.name, mrn: st.mrn, phone: st.phone, guardian: st.guardian, address: st.address, study_id: normId(st.sid) };
  st.busy = true; st.err = ''; st.done = ''; render();
  try {
    const res = await confApi(body);
    if (!res.ok) throw new Error(res.error || 'not assigned');
    st.done = (res.again ? 'Already assigned: ' : 'Assigned: ') + res.study_id;
    st.pendingRid = null; st.name = ''; st.mrn = ''; st.phone = ''; st.guardian = ''; st.address = ''; st.sid = ''; st.reason = ''; st.status = 'E';
  } catch (e) {
    if (T.weak && confCopy()) { st.busy = false; return regAssign(); }           // same request id, so a request that did get through is not repeated
    st.err = 'Not assigned. ' + e.message + ' Check the connection and press Assign again.';
  }
  st.busy = false;
  await regLoad();
}
function regList(L) {
  const st = regState(), q = st.q.trim().toUpperCase(), rows = L ? L.rows : [];
  const dig = (v) => s_(v).replace(/\D/g, '').replace(/^(92|0)/, ''), qd = /^[\d\s+\-()]+$/.test(q) ? dig(q) : '';      // only a search made of digits is compared with telephones, so TBDM-001 does not match every number containing 01      // 0300 123, +92 300 123 and 300123 all find the same telephone
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
  if (!linkUp() && (st.list === null || st.list.cached) && confCopy()) st.list = confAsList();
  else if (linkUp() && st.list && st.list.cached) st.list = null;
  if (st.list === null && !st.loading && !st.err && linkUp()) { st.loading = true; setTimeout(() => regLoad(), 0); }   // never load inside a render
  const L = st.list, queued = S.confOut || [];
  const seg = (opts, cur, set) => el('div', { class: 'seg' }, opts.map((o) => el('button', { type: 'button', class: cur === o[0] ? 'on' : '', onclick: () => { set(o[0]); render(); } }, o[1])));
  const spoiled = st.status === 'S', pend = identifiersPending(L);
  const off = !linkUp();
  const msg = st.err || st.done || '';          // a new result is brought into view: it sits under the button, and the form is long
  if (msg && msg !== st.shown) setTimeout(() => { const m = $('#regmsg'); if (m && m.scrollIntoView) m.scrollIntoView({ block: 'center', behavior: 'smooth' }); }, 60);
  st.shown = msg;
  const nextTxt = L && L.cached ? (ownFree()[0] ? idOf_(ownFree()[0]) : '') : L ? s_(L.next) : '';   // the one number the register would give next
  return topBar('Link register').concat([el('main', null,
    // One status line (not several cards): is the register live or a saved copy, and a Refresh.
    off ? (L && L.cached ? el('div', { class: 'regstat solo' }, el('button', { class: 'btn', type: 'button', disabled: !navigator.onLine || st.loading, onclick: () => { T.weak = false; regLoad(); } }, 'Refresh'))
      : el('div', { class: 'card warn' }, el('b', null, 'No internet connection.'), el('div', { class: 'small' }, 'No copy of the register is saved on this phone yet. Open this page once while online.')))
    : el('div', { class: 'regstat' }, el('i', { class: 'dot' }), el('span', null, st.loading ? 'Online · loading the register…' : 'Online · register up to date'),
        el('button', { class: 'btn', type: 'button', disabled: !navigator.onLine || st.loading, onclick: () => { T.weak = false; regLoad(); } }, 'Refresh')),
    L && L.link ? null : el('div', { class: 'card small muted' }, 'Study numbers only. No names, addresses, telephone numbers or record numbers are entered or shown here. Those stay on paper in the locked cabinet.'),
    // One list of things to do: entries waiting to be sent, and enrolled people whose identifiers are still to be recorded.
    queued.length || pend.length ? el('div', { class: 'card warn todo' },
      queued.length ? [el('b', null, queued.length + ' waiting to send'), el('div', { class: 'list' }, queued.map((c) => el('div', { class: 'row' }, el('div', { class: 'main' }, el('div', null, c.body.study_id + (c.kind === 'add' ? ' · new number' : ' · details changed')), c.err ? el('div', { class: 'sub' }, 'Not accepted: ' + c.err) : null),
        c.err ? el('button', { class: 'btn', type: 'button', onclick: () => { S.confOut.splice(S.confOut.indexOf(c), 1); saveState().then(render); } }, 'Discard') : null)))] : null,
      pend.length ? [el('b', null, 'Enrolled, identifiers still to record (' + pend.length + ')'),
        el('div', { class: 'small' }, 'Tap a number to add the name, record number and telephone. Do this when you are back online.'),
        el('div', { class: 'list' }, pend.map((r) => el('button', { class: 'row', type: 'button', onclick: () => go('link', { sid: r.study_id }) }, el('div', { class: 'main' }, el('div', null, r.study_id)), el('span', { class: 'chev' }))))] : null) : null,
    el('div', { class: 'field' }, el('label', { class: 'lab', for: 'reg-sid' }, 'Assign a study number'),
      L && L.link ? el('div', { class: 'hint' }, 'Only for a patient who has agreed and is not enrolled yet.') : null,
      el('div', { class: 'hint' }, 'Leave blank to use the next free number' + (nextTxt ? ': ' + nextTxt : '') + '. If the patient\'s card shows a different number, type that one.'),
      el('input', { id: 'reg-sid', type: 'tel', inputmode: 'numeric', maxlength: '8', autocapitalize: 'characters', placeholder: nextTxt || 'e.g. 7 or ' + idOf_(7), value: st.sid, oninput: (ev) => { st.sid = ev.target.value.toUpperCase(); }, onblur: (ev) => { st.sid = normId(ev.target.value); ev.target.value = st.sid; } })),
    spoiled || !(L && L.link) ? null : el('div', { class: 'field' }, el('label', { class: 'lab' }, 'Participant name, required'),
      el('input', { id: 'reg-name', type: 'text', maxlength: '60', value: st.name, oninput: (ev) => { st.name = ev.target.value; } })),
    spoiled || !(L && L.link) ? null : el('div', { class: 'field' }, el('label', { class: 'lab' }, 'Record number (MRN), required'),
      el('input', { id: 'reg-mrn', type: 'text', maxlength: '30', value: st.mrn, oninput: (ev) => { st.mrn = ev.target.value; } })),
    spoiled || !(L && L.link) ? null : el('div', { class: 'field' }, el('label', { class: 'lab' }, 'Telephone, required, e.g. 03001234567'),
      el('input', { id: 'reg-phone', type: 'text', inputmode: 'tel', maxlength: '16', value: st.phone, oninput: (ev) => { st.phone = ev.target.value; } })),
    spoiled || !(L && L.link) ? null : el('div', { class: 'field' }, el('label', { class: 'lab' }, 'Father or husband name'),
      el('input', { id: 'reg-guardian', type: 'text', maxlength: '60', value: st.guardian, oninput: (ev) => { st.guardian = ev.target.value; } })),
    spoiled || !(L && L.link) ? null : el('div', { class: 'field' }, el('label', { class: 'lab' }, 'Address'),
      el('input', { id: 'reg-address', type: 'text', maxlength: '200', value: st.address, oninput: (ev) => { st.address = ev.target.value; } })),
    el('div', { class: 'field' }, el('label', { class: 'lab' }, 'Outcome'), seg(REG_STATUS_OPTS, st.status, (v) => { st.status = v; })),
    spoiled ? el('div', { class: 'field' }, el('label', { class: 'lab' }, 'Reason the number is spoiled'),
      el('input', { type: 'text', maxlength: '80', value: st.reason, oninput: (ev) => { st.reason = ev.target.value; } })) : null,
    el('button', { class: 'btn primary block', type: 'button', disabled: st.busy || !L, onclick: () => regAssign() }, st.busy ? 'Assigning…' : (off ? 'Save on this phone' : 'Assign number')),
    st.err ? el('div', { class: 'card alert', id: 'regmsg' }, st.err) : null,
    st.done ? el('div', { class: 'card done', id: 'regmsg' }, el('b', null, st.done)) : null,
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
  const fromCopy = () => {
    const L = confAsList(), r = L && L.rows.filter((x) => s_(x.study_id).toUpperCase() === s_(sid).toUpperCase())[0];
    if (r) { st.data = { name: r.name || '', mrn: r.mrn || '', phone: r.phone || '', guardian: r.guardian || '', address: r.address || '', note: r.note || '', updated: r.updated || '' }; st.form = Object.assign({}, st.data); st.edit = !(r.name || r.mrn || r.phone); st.offline = true; st.err = ''; }
    else st.err = 'No signal, and no saved copy of this participant on this phone.';
    st.busy = false; render();
  };
  if (!linkUp()) { fromCopy(); return; }
  try {
    const res = await confApi({ op: 'link_get', token: S.cfg.token, study_id: sid });
    if (!res.ok) throw new Error(res.error || 'could not load');
    st.data = res; st.form = { name: res.name || '', mrn: res.mrn, phone: res.phone, guardian: res.guardian || '', address: res.address, note: res.note };
    st.edit = !(res.name || res.mrn || res.phone || res.guardian || res.address || res.note);
  } catch (e) { if (T.weak && confCopy()) { fromCopy(); return; } st.err = e.message; }
  st.busy = false; render();
}
async function linkSave() {
  const st = T.link;
  if (!linkUp() && !confCopy()) { st.err = 'No internet connection. Nothing was saved.'; render(); return; }
  if (!s_((st.form || {}).mrn).trim() || !s_((st.form || {}).phone).trim()) { st.err = 'Not saved. The record number and the telephone number are both required.'; render(); return; }
  if (!linkUp()) {
    S.confOut = (S.confOut || []).filter((c) => !(c.kind === 'set' && c.body.study_id === st.sid));
    S.confOut.push({ id: rid(), kind: 'set', at: Date.now(), err: '', body: Object.assign({ study_id: st.sid }, st.form) });
    await saveState(); st.msg = 'Saved on this phone. It is sent when you are back online.'; st.edit = false; st.data = Object.assign({}, st.data, st.form); render(); return;
  }
  st.busy = true; st.err = ''; st.msg = ''; render();
  try {
    const res = await confApi(Object.assign({ op: 'link_set', token: S.cfg.token, study_id: st.sid }, st.form));
    if (!res.ok) throw new Error(res.error || 'not saved');
    st.msg = 'Saved.'; st.busy = false; st.edit = false;
    st.data = Object.assign({}, st.data, st.form); render(); return;
  } catch (e) {
    if (T.weak && confCopy()) { st.busy = false; return linkSave(); }           // the signal failed: keep it on the phone instead, to be sent later
    st.err = 'Not saved. ' + e.message;
  }
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
  const st = T.link || { busy: true }, off = !linkUp(), d = st.data, f = st.form || {};
  const field = (k, lab, ml) => el('div', { class: 'field' }, el('label', { class: 'lab' }, lab),
    el('input', { type: 'text', maxlength: String(ml), value: f[k] || '', inputmode: k === 'phone' ? 'tel' : 'text', oninput: (ev) => { f[k] = ev.target.value; } }));
  const show = (lab, v) => el('div', { class: 'card' }, el('div', { class: 'muted small' }, lab), el('div', null, v || '–'));
  const ph = d && d.phone;
  return topBar(sid + ' · Contact').concat([el('main', null,
    el('div', { class: 'card small muted' }, confRole() ? 'Confidential. Only the PI and the DOTS incharge. This phone keeps an encrypted copy (locked with your PIN) so it works with no signal; every opening while online is logged.' : 'Confidential. Only the PI and the DOTS incharge, online only. Nothing here is saved on this phone, and every opening is logged.'),
    off && st.offline ? null : off ? el('div', { class: 'card warn' }, el('b', null, 'No internet connection.')) : null,
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
      el('button', { class: 'btn block', type: 'button', disabled: off && !st.offline, onclick: () => { st.edit = true; st.msg = ''; render(); } }, 'Edit'),
      !can('view') && can('photoView') ? photoViewCard(sid) : null] : null,
    d && st.edit ? [field('name', 'Participant name', 60), field('mrn', 'Record number (MRN), required', 30), field('phone', 'Telephone, required, e.g. 03001234567', 16), field('guardian', 'Father or husband name', 60), field('address', 'Address', 200), field('note', 'Note', 200),
      el('button', { class: 'btn primary block', type: 'button', disabled: (off && !st.offline) || st.busy, onclick: () => linkSave() }, st.busy ? 'Saving…' : (off ? 'Save on this phone' : 'Save'))] : null
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
// "TBDM-001 | Visit 1 | Baseline": the study number and the visit as the checklist names it
function dmy(d) { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s_(d)); return m ? m[3] + '-' + m[2] + '-' + m[1].slice(2) : s_(d); }   // 2026-10-25 -> 25-10-26
function winTxt(r) { return 'window ' + dmy(r[3]) + ' to ' + dmy(r[4]); }
function dueLabel(r) { const g = VISIT_GUIDE[r[1]]; return r[0] + ' | ' + (g ? g.name.replace(' · ', ' | ') : r[1]); }
const VISIT_GUIDE = {
  V1: { name: 'Visit 1 · Baseline', when: 'Day 0 to 7 after ATT started', measure: M_V1, examine: E_ALL, symptoms: [S_TB, 'How many weeks the symptoms have lasted', S_HEP],
    order: [['Fasting bloods, 08:00 to 10:00. Write the draw time on the slip', BLOOD_FULL], ['Chest radiograph', 'The routine film. Tell the PI when it is ready']],
    do: ['Consent, then assign the next study number', 'Copy the diagnostic sputum smear grade from the NTP card', 'History: smoking, alcohol, diabetes, hypertension', 'Questionnaires PHQ-9 and GAD-7, unless declined'],
    enter: ['Enrolment first', 'Baseline form', 'Laboratory results when they return', 'Chest radiograph date', 'Questionnaires (V1)'] },
  V2: { name: 'Visit 2 · Month 1', when: 'Day 21 to 35', measure: [], examine: [], symptoms: [S_HEP],
    order: [['Liver tests (ALT, AST, ALP, total bilirubin)', 'If any symptom is present, draw them the same day']],
    do: ['Ask about each liver symptom directly', 'Treatment status and adherence'],
    enter: ['Visit form (V2)', 'Laboratory results when they return', 'Check the liver injury definition as soon as the result is back'] },
  V3: { name: 'Visit 3 · Month 2', when: 'Day 49 to 70 · end of intensive phase', measure: M_ALL, examine: E_ALL, symptoms: [S_TB, S_HEP],
    order: [['Blood count (CBC) and liver tests (ALT, AST, ALP, total bilirubin)', ''], ['Sputum smear', 'Record the date and result']],
    do: ['Treatment status and adherence', 'Sputum conversion: Y, N or U. Never leave it blank'],
    enter: ['Visit form (V3), with the sputum smear date and result', 'Laboratory results when they return', 'Check the liver injury definition'] },
  V4: { name: 'Visit 4 · Month 3', when: 'Day 77 to 98', measure: [], examine: [], symptoms: [S_HEP],
    order: [['HbA1c, blood count (CBC) and liver tests (ALT, AST, ALP, total bilirubin)', 'Enter the HbA1c with its unit'], ['Sputum smear, only if the V3 smear was not negative', 'Repeat the smear at each visit until a negative smear is documented']],
    do: ['Treatment status and adherence', 'New diabetes found: refer for diabetes care and record it'],
    enter: ['Visit form (V4)', 'Laboratory results when they return'] },
  V5: { name: 'Visit 5 · Month 6', when: 'Day 154 to 182 · treatment completion', measure: M_ALL, examine: E_ALL, symptoms: [S_TB, S_HEP],
    order: [['Blood count (CBC) and liver tests (ALT, AST, ALP, total bilirubin)', ''], ['Sputum smear', 'Record the date and result'], ['Spirometry', 'Only if smear negative and not declined']],
    do: ['Treatment status and adherence', 'Treatment outcome', 'Questionnaires PHQ-9 and GAD-7, unless declined'],
    enter: ['Visit form (V5), with the sputum smear date and result', 'Laboratory results when they return', 'Spirometry', 'Questionnaires (V5)', 'End of study: status C and the date'] }
};
function visitsScreen() {
  const due = !can('view') || !S.server ? [] : derived().schedule.filter((r) => r[5] !== 'upcoming');
  return topBar('Visit checklist').concat([el('main', null,
    el('div', { class: 'card small muted' }, 'Tap a visit to see what to order and do. Every visit is counted from the day ATT started.'),
    el('div', { class: 'list' }, Object.keys(VISIT_GUIDE).map((v) => el('button', { class: 'row', onclick: () => go('visitguide', { v: v }) },
      el('div', { class: 'main' }, el('div', null, VISIT_GUIDE[v].name), el('div', { class: 'sub' }, VISIT_GUIDE[v].when)),
      due.filter((r) => r[1] === v).length ? el('span', { class: 'chip warn' }, due.filter((r) => r[1] === v).length + ' due') : null, el('span', { class: 'chev' })))))
  ]);
}
// The source documents to photograph at a visit, from the same rules the forms use (shown only when photos are switched on)
function guideDocs(v) {
  if (!photosOn()) return [];
  const out = v === 'V1' ? ['Consent form', 'Diagnostic sputum smear report or NTP card'] : [];
  (VISIT_FORMS[v] || []).forEach((f) => {
    if (f[0] === 'END_STUDY') return;
    const docs = requiredDocs(f[0], f[1]);
    if (f[0] === 'LABS' && docs.length) out.push('Lab report pages: ' + docs.map((d) => LAB_PAGES[d.slice(4)].replace(/ \(.*\)$/, '')).join(', '));
    else docs.forEach((d) => out.push(PHOTO_DOC_NAMES[d] + (f[0] === 'SPIRO' ? ' (if done)' : '')));
  });
  if (v === 'V4') out.push('Sputum smear report, only if the V3 smear was not negative');
  if (v === 'V5') out.push('Withdrawal Deletion Record, only for a participant who withdrew');
  return out;
}
function visitGuideScreen(p) {
  const g = VISIT_GUIDE[p.v], due = !can('view') || !S.server ? [] : derived().schedule.filter((r) => r[1] === p.v && r[5] !== 'upcoming');
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
    (() => { const d = guideDocs(p.v); return d.length ? [el('h2', null, 'Documents to photograph'), el('div', { class: 'card' }, list(d))] : null; })(),
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
// Spirometry is done only at Visit 5 and only once the Visit 5 smear is recorded as negative: it is not done on a smear-positive patient.
function spiroOk(sid) { const v5 = find('VISITS', { study_id: sid, visit: 'V5' }); return !!v5 && s_(v5.smear_result) === 'N'; }
const SPIRO_WHY = 'opens when the Visit 5 smear is recorded as negative (not done on a smear-positive patient)';
function lockedRow(name, opens) { return el('div', { class: 'row locked', 'aria-disabled': 'true' }, el('div', { class: 'main' }, el('div', null, name), el('div', { class: 'sub' }, 'opens ' + opens)), el('span', { class: 'chip' }, 'not yet')); }
function participant(p) {
  const sid = p.sid, out = derived(), e = find('S1_ENROL', { study_id: sid }); recordRecent(sid);
  photoFetch(sid, () => { if (cur().name === 'participant' && cur().p.sid === sid) render(); });
  if (!e) return topBar(sid).concat([el('main', null, el('div', { class: 'card' }, 'This study number is not in the workbook (it may have been withdrawn).'))]);
  const dp = out.participant.filter((r) => r[0] === sid)[0] || [];
  const dpk = DERIVED.DERIVED_PARTICIPANT.map((x) => x[0]), D = {}; dpk.forEach((k, i) => { D[k] = dp[i]; });
  const d0 = dayNo_(e.att_start_date), today = dayNo_(todayIso()), sched = {};
  out.schedule.filter((r) => r[0] === sid).forEach((r) => { sched[r[1]] = r[5]; });
  const optQ = e.optout_questionnaires === 'D', optS = e.optout_spirometry === 'D';
  let curV = 'V1';
  const formRow = (tab, visit) => {
    if ((tab === 'PHQ_GAD' && optQ) || (tab === 'SPIRO' && optS)) return el('div', { class: 'row' }, el('div', { class: 'main' }, el('div', null, NAMES[tab]), el('div', { class: 'sub' }, 'declined on the consent form')));
    const key = visit ? { study_id: sid, visit } : { study_id: sid };
    const opens = visitOpens(sid, curV);
    if (opens && tab !== 'END_STUDY' && !find(tab, key)) return lockedRow(NAMES[tab], opens);
    if (tab === 'SPIRO' && !find(tab, key) && !spiroOk(sid)) return lockedRow(NAMES[tab], SPIRO_WHY.replace(/^opens /, ''));
    return el('button', { class: 'row', onclick: () => go('form', { tab, key }) }, el('div', { class: 'main' }, el('div', null, NAMES[tab])), docPill(sid, tab, visit, find(tab, key)), statusChip(find(tab, key)), el('span', { class: 'chev' }));
  };
  const visits = ['V1', 'V2', 'V3', 'V4', 'V5'].map((v) => {
    const w = CFG.WINDOWS[v], range = d0 !== null ? dmy(isoOf_(d0 + w[1])) + ' to ' + dmy(isoOf_(d0 + w[2])) : 'set the date ATT started';
    const st = sched[v];
    return [el('h2', { class: 'vhead' }, v + ' · ' + (v === 'V1' ? 'baseline' : 'month ' + ({ V2: 1, V3: 2, V4: 3, V5: 6 })[v]) + ' ', st ? el('span', { class: 'chip ' + (st === 'overdue' ? 'bad' : st === 'due now' ? 'warn' : '') }, st) : null,
        hasGuide() && VISIT_GUIDE[v] ? el('button', { class: 'vguide', type: 'button', 'aria-label': 'Checklist for ' + v, title: 'What to order and do at ' + v, onclick: () => go('visitguide', { v: v }) }, icon('list')) : null),
      el('div', { class: 'list' }, el('div', { class: 'row' }, el('div', { class: 'main sub' }, 'Window ' + range)), (curV = v, VISIT_FORMS[v].map((f) => formRow(f[0], f[1]))))];
  });
  const usedU = view('LABS').filter((r) => r.study_id === sid && /^U/.test(r.visit)).map((r) => r.visit);
  const nextU = ['U1', 'U2', 'U3', 'U4', 'U5'].filter((u) => usedU.indexOf(u) < 0)[0];
  const evs = view('EVENTS').filter((r) => r.study_id === sid);
  // Key variables of the five studies, four to a row: what each study measures, as soon as the values exist
  const lk = DERIVED.DERIVED_LABS.map((x) => x[0]), L = (r, k) => r[lk.indexOf(k)], mine = out.labs.filter((r) => r[0] === sid), v1 = mine.filter((r) => r[1] === 'V1')[0] || [];
  const altMax = mine.map((r) => Number(L(r, 'alt_x_uln'))).filter((x) => x > 0), dili = mine.some((r) => /^MET/.test(s_(L(r, 'dili'))));
  const word = (v, m) => (v === '' || v === undefined ? '' : (m[v] || v));
  const facts = [['Day', d0 !== null ? today - d0 : '?'], ['Diabetes', word(e.dm_status, { K: 'known', N: 'new', 0: 'no' }) || 'not set'], ['BMI V1', D.bmi_v1], ['VAI V1', D.vai_v1],
    ['NLR V1', L(v1, 'nlr')], ['PLR V1', L(v1, 'plr')], ['SII V1', L(v1, 'sii') === '' || L(v1, 'sii') === undefined ? '' : Math.round(Number(L(v1, 'sii')))], ['TBscore', D.tbscore_v1_p90],
    ['Timika', D.timika_final], ['Cavity', word(D.cavity_final, { Y: 'yes', N: 'no' })], ['ALT max', altMax.length ? Math.max.apply(null, altMax) + '×' : ''], ['DILI', mine.length ? (dili ? 'met' : 'no') : ''],
    ['PHQ-9', D.phq9_v1], ['GAD-7', D.gad7_v1], ['Item 9', D.item9_positive === 'Y' ? 'yes' : 'no'], ['DM M3', word(D.dm_class_v4, { P: 'persistent', T: 'transient', K: 'known', X: 'new', 0: 'no' })]];
  const hot = (f) => (f[0] === 'Item 9' && f[1] === 'yes') || (f[0] === 'DILI' && f[1] === 'met');
  const main = el('main', null,
    el('div', { class: 'list' }, el('button', { class: 'row', onclick: () => go('form', { tab: 'S1_ENROL', key: { study_id: sid } }) },
      el('div', { class: 'main' }, el('div', null, 'Enrolment details'), el('div', { class: 'sub' }, 'ATT started ' + (e.att_start_date || '?'))), docPill(sid, 'S1_ENROL', '', e), statusChip(e), el('span', { class: 'chev' }))),
    el('div', { class: 'facts4' }, facts.map((f) => el('div', { class: hot(f) ? 'bad' : '' }, el('span', null, f[0]), el('b', null, f[1] === '' || f[1] === undefined ? '–' : f[1])))),
    (() => {                                                   // confidential blocks side by side: Contact (PI) and Photos (PI, verifier)
      const t = [
        can('contacts') && !T.practice ? contactTile(sid) : null,
        can('photoView') && photosOn() ? photosTile(sid) : null].filter(Boolean);
      return t.length ? el('div', { class: 'ctiles' + (t.length === 1 ? ' solo' : '') }, t) : null;
    })(),
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
function regMatch(rows, qq) {                              // search by study number, name, MRN or telephone (any way of writing it)
  const q = s_(qq).trim().toUpperCase();
  if (!q) return rows;
  const dig = (v) => s_(v).replace(/\D/g, '').replace(/^(92|0)/, ''), qd = /^[\d\s+\-()]+$/.test(q) ? dig(q) : '';
  return rows.filter((r) => [r.study_id, r.name, r.mrn].some((v) => s_(v).toUpperCase().indexOf(q) >= 0) || (qd.length >= 3 && dig(r.phone).indexOf(qd) >= 0) || s_(r.phone).replace(/\s/g, '').indexOf(q.replace(/\s/g, '')) >= 0
    || (/^\d{1,3}$/.test(q) && s_(r.study_id).toUpperCase().replace(/\D/g, '').replace(/^0+/, '') === q.replace(/^0+/, '')));
}
// Tap a telephone number: choose Call or WhatsApp.
function contactAct(sid, c) {
  const ph = s_(c.phone), done = () => setTimeout(() => { const m = $('#modal'); m.hidden = true; m.replaceChildren(); }, 400);
  modal(sid + (c.name ? ' · ' + c.name : ''), el('div', { class: 'card' }, el('div', { class: 'muted small' }, 'Telephone'), el('div', { class: 'tel big' }, ph),
    el('div', { class: 'row2' },
      el('a', { class: 'btn block', id: 'act-call', href: 'tel:' + ph.replace(/[^\d+]/g, ''), onclick: done }, 'Call'),
      el('a', { class: 'btn block', id: 'act-wa', href: 'https://wa.me/' + waDigits(ph), target: '_blank', rel: 'noopener noreferrer', onclick: done }, 'WhatsApp'))), [['Contact details', () => go('link', { sid: sid })], ['Cancel', null]]);
}
// Contacts opened from the Contact page, newest first (study numbers only; names are read from the register copy when shown).
function cRecent() { try { return JSON.parse(localStorage.getItem('tbdm_crecent') || '[]').filter((x) => typeof x === 'string').slice(0, 5); } catch (e) { return []; } }
function cRemember(sid) { T.cq = ''; try { localStorage.setItem('tbdm_crecent', JSON.stringify([sid].concat(cRecent().filter((x) => x !== sid)).slice(0, 5))); } catch (e) { /* no storage: skip */ } }
function linkPick() {
  if (!can('contacts') || T.practice) return topBar('Contact').concat([el('main', null, el('div', { class: 'card' }, 'Contact is not part of your role, and is not available in practice mode.'))]);
  const q = el('input', { class: 'search', type: 'search', placeholder: 'Study Number, MRN, Name or Telephone', autocomplete: 'off', value: T.cq || '' });
  const list = el('div', { class: 'list conf' });
  const note = el('div', { class: 'card small muted', hidden: true });
  // Who is due or overdue now, each with the telephone number on the register copy; tapping the number asks Call or WhatsApp.
  const dueBox = el('div', { class: 'duebox' });
  const paintDue = () => {
    const L = confAsList(), byId = {}; (L ? L.rows : []).forEach((r) => { byId[s_(r.study_id).toUpperCase()] = r; });
    const rows = derived().schedule.filter((r) => r[5] !== 'upcoming');
    dueBox.hidden = !rows.length || !!s_(q.value);
    dueBox.replaceChildren(el('h2', null, 'Due and overdue'), el('div', { class: 'list duec' }, rows.map((r) => {
      const c = byId[s_(r[0]).toUpperCase()] || {}, ph = s_(c.phone);
      return el('div', { class: 'row' },
        el('button', { class: 'main', type: 'button', onclick: () => { cRemember(r[0]); go('link', { sid: r[0] }); } }, el('div', null, dueLabel(r)), c.name ? el('div', { class: 'sub' }, c.name) : null,
          el('div', { class: 'sub winline' }, winTxt(r))),
        el('div', { class: 'side' },
          ph ? el('button', { class: 'tel', type: 'button', onclick: () => contactAct(r[0], c) }, ph) : el('span', { class: 'sub notel' }, L ? 'no number yet' : 'not loaded'),
          el('span', { class: 'chip ' + (r[5] === 'overdue' ? 'bad' : r[5] === 'due now' ? 'warn' : '') }, r[5])));
    })));
  };
  const recentBox = el('div', { class: 'recentbox' });
  const paintRecent = () => {
    const L = confAsList(), byId = {}; (L ? L.rows : []).forEach((r) => { byId[s_(r.study_id).toUpperCase()] = r; });
    const ids = cRecent();
    recentBox.hidden = !ids.length || !!s_(q.value).trim();
    recentBox.replaceChildren(el('h2', null, 'Recent searches'), el('div', { class: 'list conf' }, ids.map((id) => {
      const c = byId[id.toUpperCase()] || {};
      return el('button', { class: 'row', type: 'button', onclick: () => { cRemember(id); go('link', { sid: id }); } },
        el('div', { class: 'main' }, el('div', null, id), el('div', { class: 'sub' }, [c.name, c.phone].filter(Boolean).join(' · ') || 'telephone, call, WhatsApp')), el('span', { class: 'chev' }));
    })));
  };
  const fill = () => {
    T.cq = q.value; paintDue(); paintRecent();
    const L = confAsList(), have = {};
    const rows = L ? L.rows.slice() : [];
    rows.forEach((r) => { have[s_(r.study_id).toUpperCase()] = true; });
    view('S1_ENROL').forEach((r) => { const id = s_(r.study_id).toUpperCase(); if (id && !have[id]) { have[id] = true; rows.push({ study_id: r.study_id }); } });
    rows.sort((a, b) => (a.study_id < b.study_id ? -1 : 1));
    const typed = !!s_(q.value).trim(), shown = typed ? regMatch(rows, q.value) : [];
    list.hidden = !typed;
    list.hidden = !typed;
    note.hidden = !!L; note.textContent = L ? '' : 'Names and telephones are not on this phone yet. Open this page once with a signal to load them. Only study numbers can be searched until then.';
    list.replaceChildren(...(shown.length ? shown.slice(0, 100).map((r) => el('button', { class: 'row', onclick: () => { cRemember(r.study_id); go('link', { sid: r.study_id }); } },
      el('div', { class: 'main' }, el('div', null, r.study_id), el('div', { class: 'sub' }, [r.name, r.mrn ? 'MRN ' + r.mrn : '', r.phone].filter(Boolean).join(' · ') || 'telephone, call, WhatsApp')), el('span', { class: 'chev' }))) : (typed ? [el('div', { class: 'empty' }, 'No contact matches.')] : [])));
  };
  q.addEventListener('input', fill); fill();
  if (!confCopy() && navigator.onLine && !T.cqLoading && !T.cqTried) { T.cqLoading = true; T.cqTried = true; confRefresh(() => {}).catch(() => {}).then(() => { T.cqLoading = false; if (KEY && cur().name === 'linkpick') { const old = $('.search'); T.cq = old ? old.value : T.cq; render(); } }); }
  return topBar('Contact').concat([el('main', null, q, note, dueBox, recentBox, list)]);
}
// The nurse's participant page: the same layout as everyone else's (enrolment on top, then one block per visit with its window),
// listing only the measurements she takes.
function measureFor(p) {
  const sid = p.sid; recordRecent(sid);
  const e = find('S1_ENROL', { study_id: sid }), d0 = e ? dayNo_(e.att_start_date) : null;
  const row = (tab, key, name) => {
    const opens = visitOpens(sid, key.visit || 'V1');
    if (opens && !find(tab, key)) return lockedRow(name, opens);
    return el('button', { class: 'row', onclick: () => go('form', { tab, key }) }, el('div', { class: 'main' }, el('div', null, name)), statusChip(find(tab, key)), el('span', { class: 'chev' }));
  };
  const block = (v, rows) => {
    const w = CFG.WINDOWS[v], range = d0 !== null ? dmy(isoOf_(d0 + w[1])) + ' to ' + dmy(isoOf_(d0 + w[2])) : 'set the date ATT started';
    return [el('h2', { class: 'vhead' }, v + ' · ' + (v === 'V1' ? 'baseline' : 'month ' + ({ V2: 1, V3: 2, V4: 3, V5: 6 })[v])),
      el('div', { class: 'list' }, el('div', { class: 'row' }, el('div', { class: 'main sub' }, 'Window ' + range)), rows)];
  };
  return topBar(sid).concat([el('main', null,
    el('div', { class: 'list' }, el('button', { class: 'row', onclick: () => go('form', { tab: 'S1_ENROL', key: { study_id: sid } }) },
      el('div', { class: 'main' }, el('div', null, 'Enrolment details'), el('div', { class: 'sub' }, e && e.att_start_date ? 'ATT started ' + e.att_start_date : 'ATT start date not recorded')), statusChip(e), el('span', { class: 'chev' }))),
    block('V1', row('S2_BASELINE', { study_id: sid }, 'Height, weight, waist, arm')),
    NURSE_VISITS.map((v) => block(v, row('VISITS', { study_id: sid, visit: v }, 'Weight, waist, arm'))))]);
}
function due() {
  const out = derived();
  const rows = out.schedule.filter((r) => r[5] !== 'upcoming').concat(out.schedule.filter((r) => r[5] === 'upcoming'));
  return topBar('Due and overdue').concat([el('main', null, el('div', { class: 'list' }, rows.length ? rows.map((r) => el('button', { class: 'row', onclick: () => go('participant', { sid: r[0] }) },
    el('div', { class: 'main' }, el('div', null, dueLabel(r)), el('div', { class: 'sub' }, winTxt(r))),
    el('span', { class: 'chip ' + (r[5] === 'overdue' ? 'bad' : r[5] === 'due now' ? 'warn' : '') }, r[5]), el('span', { class: 'chev' }))) : el('div', { class: 'empty' }, 'Nothing due')))]);
}
// ---- query navigation: open the exact form, scroll to the field and flash it, with the query shown on top
function fieldName(tab, k) { const d = defOf(tab), c = d && d.cols.filter((x) => x.key === k)[0]; return c ? c.label.split(' (')[0] : k; }
// The enrolment has no screening line carrying its number: the fix is on the screening line, not on the enrolment.
const SPIRO_V5_Q = /Spirometry done but the Visit 5 smear/;   // opens the Visit 5 smear result
const SKIPPED_Q = /^Study number skipped/;   // the gap is explained in the paper linking log, which the PI keeps in the Link register
const NO_SCREEN_Q = /^No screening line/, WAIT_ENROL_Q = /not yet enrolled|not yet in S1_ENROL/;   // the second wording is the older one, still on the workbook until its script is updated
function openQuery(q) {
  const tab = q[1], keys = APP_KEYS[tab], query = q[4] + (q[5] ? ': ' + q[5] : '');
  if (SKIPPED_Q.test(q[4])) {
    if (can('numbers') && !T.practice) { if (T.reg) T.reg.list = null; go('register'); toast((q[0] || 'This number') + ' was skipped. Record what happened to it in the Link register.'); return; }
    modal((q[0] || 'This number') + ' was skipped', [el('p', null, 'No screening line or enrolment uses this number. The PI explains the gap in the paper linking log.')], [['Close', null]]); return;
  }
  if (NO_SCREEN_Q.test(q[4])) { go('screening'); toast('Open ' + (q[0] || 'the patient') + "'s screening line and enter " + (q[0] || 'the study number') + ' as its study number'); return; }
  if (SPIRO_V5_Q.test(q[4]) && q[0]) { go('form', { tab: 'VISITS', key: { study_id: q[0], visit: 'V5' }, focus: 'smear_result', query: query }); return; }   // the fix is the Visit 5 smear, not the spirometry form
  if (WAIT_ENROL_Q.test(q[4]) && q[0]) { findPatient(q[0]); return; }   // screened and waiting: straight to the enrolment prompt
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
      WAIT_ENROL_Q.test(q[4]) ? el('div', { class: 'sub qfield' }, 'Opens at: Enrolment')
        : SKIPPED_Q.test(q[4]) ? el('div', { class: 'sub qfield' }, can('numbers') ? 'Opens at: Link register, to record what happened to the number' : 'The PI explains this in the paper linking log')
        : NO_SCREEN_Q.test(q[4]) ? el('div', { class: 'sub qfield' }, "Opens at: Screening log, to add the number to the patient's line")
        : q[6] ? el('div', { class: 'sub qfield' }, 'Opens at: ' + fieldName(q[1], q[6])) : null), el('span', { class: 'chev' }));
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
  const { mine, has, todo, done } = filmLists();
  const item = (f) => {
    const n = !has(f.study_id, '1') ? '1' : '2';
    return el('button', { class: 'row', onclick: () => go('form', { tab: 'R_SCORES', key: { study_id: f.study_id, read_no: todo.indexOf(f) >= 0 ? n : '1' } }) },
      el('div', { class: 'main' }, el('div', null, f.study_id), el('div', { class: 'sub' }, 'film of ' + (f.cxr_date || '?') + (todo.indexOf(f) >= 0 && n === '2' ? ' · repeat read requested' : ''))),
      statusChip(mine.filter((r) => r.study_id === f.study_id && r.read_no === (todo.indexOf(f) >= 0 ? n : '1'))[0] || null), el('span', { class: 'chev' }));
  };
  return topBar('Radiograph scoring').concat([el('main', null, el('div', { class: 'card small' }, 'Score each film from the image alone. You see no clinical or group information, and nobody but you and the PI sees your scores.'),
    el('h2', null, 'To score (' + todo.length + ')'), el('div', { class: 'list' }, todo.length ? todo.map(item) : el('div', { class: 'empty' }, 'Nothing to score')),
    el('h2', null, 'Scored'), el('div', { class: 'list' }, done.length ? done.map(item) : el('div', { class: 'empty' }, 'None yet')))]);
}
// Manual update: asks the server for a newer version, then reloads once the new one is in place.
// Update now: the background updater may already have fetched the new version and be waiting for the lock screen, so first
// ask the server which build is current (sw.js names it), then switch straight away instead of saying "newest" while old code runs.
function checkUpdate() {
  if (!('serviceWorker' in navigator)) { toast('This phone cannot update the app from here. Reopen it from the internet once.'); return; }
  if (!navigator.onLine) { toast('Connect to the internet first, then try again.'); return; }
  if (updateReady) { location.reload(); return; }                    // already downloaded: switch now
  toast('Checking for an update…');
  const reloadSoon = () => { navigator.serviceWorker.addEventListener('controllerchange', () => location.reload(), { once: true }); setTimeout(() => location.reload(), 8000); };
  fetch('sw.js?u=' + Date.now(), { cache: 'no-store' }).then((r) => r.text()).then((txt) => {
    const m = /tbdm(?:test)?-([0-9a-f]{12})/.exec(txt), latest = m ? m[1] : '';
    if (latest && latest === BUILD_ID) { toast('Already the newest version (build ' + BUILD_ID + ').'); return; }
    toast('Updating to build ' + (latest || 'newest') + '…');
    return navigator.serviceWorker.getRegistration().then((reg) => {
      if (!reg) { location.reload(); return; }
      reloadSoon();
      return reg.update();
    });
  }).catch(() => toast('Could not check for an update. Try again when connected.'));
}
function practiceAsk() { modal('Start practice mode?', [el('p', null, 'You will work on made-up participants. Nothing is saved or sent to the study. Your real entries are kept safe and come back when you leave practice.')], [['Cancel', null], ['Start practice', practiceStart, 'primary']]); }
function toolTile(ic, title, sub, fn, id, off) {
  return el('button', { class: 'tool' + (off ? ' off' : ''), id: id || null, onclick: fn, disabled: off ? true : null }, icon(ic), el('b', null, title), sub ? el('small', null, sub) : null);
}
function settings() {
  if (T.practice) return topBar('Settings').concat([el('main', null, practiceCard())]);
  const pending = S.outbox.length, pi = role() === 'pi';
  // Which tools appear follows what the role holds: a log only where this phone has that tab, Export for the PI, no Practice for the DOTS incharge.
  const holds = (t) => !!(S.server && S.server.tabs && S.server.tabs[t]);
  const tiles = [
    holds('S0_SCREEN') ? toolTile('logs', 'Screening log', view('S0_SCREEN').length + ' screened', () => go('screening')) : null,
    can('verify') && holds('QC_LOG') ? toolTile('check', 'Verification log', view('QC_LOG').length + ' checks', () => go('qclog')) : null,
    can('screen') || can('view') || can('measure') || isReader() ? toolTile('practice', 'Practice mode', 'Made-up patients', practiceAsk) : null,
    pi ? toolTile('roles', 'Role manager', 'Who can do what', () => { T.roles = null; go('roles'); }, 'role-manager') : null,
    can('export') && !T.practice ? toolTile('export', 'Export data', 'Excel, CSV, SPSS', exportAsk, 'export-data') : null,
    toolTile('update', 'Update app', 'Get newest', () => confirmLeave(checkUpdate), 'update-now'),
    bioTile()];
  return topBar('Settings').concat([el('main', null,
    el('h2', null, 'Tools'), el('div', { class: 'tools' }, tiles),
    el('h2', null, 'Account'),
    el('div', { class: 'list' }, [['Account', S.cfg.email], ['Role', S.cfg.role], ['Initials', S.cfg.initials], ['Server', (S.cfg.api || '').replace(/^https:\/\/([^/]+).*$/, '$1')],
      ['App version', APP_VERSION + ' · build ' + (BUILD_ID.indexOf('__') === 0 ? 'dev' : BUILD_ID) + ' (rules v' + CFG.VERSION + ')'], ['Last update', S.lastSync ? new Date(S.lastSync).toLocaleString('en-GB') : 'never'], ['Entries on this phone not yet in the workbook', String(pending)]]
      .map((r) => el('div', { class: 'row' }, el('div', { class: 'main' }, el('div', { class: 'sub' }, r[0]), el('div', null, r[1] || '–'))))),
    el('p'),
    el('button', { class: 'btn danger block', onclick: resetPhone }, 'Reset this phone'),
    el('p', { class: 'small muted' }, 'Reset removes the study data and your access from this phone. Use it before passing the phone to someone else.'))]);
}
// The Face ID / fingerprint tile shows its state; tapping it turns it on or off.
function bioTile() {
  if (T.bioOk === undefined) { T.bioOk = null; bioAvailable().then((v) => { T.bioOk = v; if (KEY && cur().name === 'settings') render(); }); }
  if (T.hasBio) return toolTile('face', 'Biometric', 'On · tap to turn off', () => modal('Turn off Face ID and fingerprint?', [el('p', null, 'The app will open with the PIN only.')], [['Cancel', null], ['Turn off', async () => { await bioOff(); toast('Face ID and fingerprint unlock is off'); render(); }, 'primary']]), 'bio-off');
  if (T.bioOk === null) return toolTile('face', 'Biometric', 'Checking…', null, null, true);
  if (!T.bioOk) return toolTile('face', 'Biometric', 'Not available', () => modal('Face ID / fingerprint', [el('p', { id: 'bio-none' }, 'The phone does not report a built-in biometric for this app. (' + (T.bioWhy || '') + (window.navigator.standalone ? '; opened from the home screen' : '; opened in the browser') + '.) The PIN works as normal.')],
    window.PublicKeyCredential ? [['Close', null], ['Try to set it up anyway', () => { T.bioOk = true; bioTurnOn(); }, 'primary']] : [['Close', null]]), 'bio-na');
  return toolTile('face', 'Biometric', 'Off · tap to turn on', bioTurnOn, 'bio-on');
}
function resetPhone() {
  const n = S.outbox.length;
  const doIt = async () => { await kvDel('vault'); await kvDel('bio'); T.hasBio = false; localStorage.removeItem('tbdm-fails'); localStorage.removeItem('tbdm-wait'); T.hasVault = false; lock(); };
  modal('Reset this phone?', [el('p', null, n ? n + ' entries on this phone have NOT reached the workbook and will be lost. Sync first if you can.' : 'All entries have reached the workbook. The phone will forget the study and your access.')],
    [['Cancel', null], [n ? 'Reset and lose ' + n : 'Reset', doIt, 'danger']]);
}

// ------------------------------------------------------------------ the generic form
// Fields that do not apply to this participant stay on the form, faded and not typeable:
// years since diabetes diagnosis only when the diagnosis is known (K); pack-years never for a never-smoker.
function notApplicable(tab, c, vals) {
  if (tab === 'S0_SCREEN') return c.key === 'not_enrolled_reason' && s_(vals.eligible) === 'N';   // no reason is needed for someone who is not eligible
  if (tab !== 'S1_ENROL') return false;
  if (c.key === 'dm_years') return s_(vals.dm_status) !== 'K';
  if (c.key === 'dm_drugs') return s_(vals.dm_status) === '0';           // not diabetic: no diabetes drugs, so the choice is closed (saved as 0, none)
  if (c.key === 'pack_years') return s_(vals.smoking) === '0';
  return false;
}
// The screening outcome follows the answers. The workbook applies the same rule (TBDM_DataSystem.gs screenDerive_).
function screenDerive(v) {
  if (s_(v.smear_grade) === 'N' && !s_(v.excl_code)) v.excl_code = '8';   // sputum smear negative = exclusion 8
  if (s_(v.excl_code)) { v.eligible = 'N'; v.enrolled = 'N'; v.not_enrolled_reason = ''; }
}
// Screening answers the rules decide: shown as text, not chosen. Age and sex copied from screening into enrolment are shown the same way.
function screenLocked(F, c) {
  if (F.tab !== 'S0_SCREEN') return false;
  if (c.key === 'eligible') return s_(F.vals.excl_code) !== '';
  if (c.key === 'enrolled') return s_(F.vals.eligible) === 'N';
  if (c.key === 'excl_code') return !!F.autoExcl;
  return false;
}
function visible(tab, c, v, vals) {
  if (c.pi && role() !== 'pi') return false;
  if (accessLimited_(role(), acc()) && (tab === 'S1_ENROL' || tab === 'S2_BASELINE' || tab === 'VISITS') && !readOnly(tab) && !nurseCol_(tab, c.key)) return false;   // writing without 'forms': the measurement columns only
  const visit = s_(vals.visit);
  if (tab === 'VISITS') {
    if (c.key === 'smear_date' || c.key === 'smear_result') return smearDue_(visit, (find('VISITS', { study_id: s_(vals.study_id), visit: 'V3' }) || {}).smear_result);   // V4 too while the V3 smear is not negative
    if (/\(V3, V5\)$/.test(c.label)) return visit === 'V3' || visit === 'V5';
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
function readOnly(tab) { return !accessWriteTab_(role(), acc(), tab); }
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
    T.form = { tab, def, existing, vals, dirty: false, errs: {}, ro: readOnly(tab), fixedKeys: existing ? keys : keys.filter((k) => s_(p.key[k])),
      carried: existing ? [] : (p.carried || []), numberGiven: !existing && !!(p.preset && s_(p.preset.study_id)), autoExcl: tab === 'S0_SCREEN' && s_(vals.smear_grade) === 'N' && s_(vals.excl_code) === '8', autoNo: tab === 'S0_SCREEN' && s_(vals.excl_code) !== '' };
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
  { const pc = photoCard(T.form); if (pc) main.append(pc); const pv = tab === 'R_SCORES' ? photoViewCard(s_(T.form.vals.study_id).toUpperCase()) : null; if (pv) main.prepend(pv); }
  const bar = F.ro ? null : el('div', { class: 'savebar' }, el('button', { class: 'btn', onclick: () => confirmLeave(back) }, 'Cancel'), el('button', { class: 'btn primary', id: 'savebtn', onclick: saveForm }, 'Save'));
  if (p.focus && !p._focused) { p._focused = true; setTimeout(() => focusField(p.focus), 120); }
  if (p.docFocus && !p._docFocused) { p._docFocused = true; setTimeout(() => { const c = $('#photocard'); if (!c) return; c.scrollIntoView({ block: 'center', behavior: 'smooth' }); c.classList.remove('flash'); void c.offsetWidth; c.classList.add('flash'); setTimeout(() => c.classList.remove('flash'), 2600); }, 150); }
  return topBar(title).concat([main, bar]);
}
function ctx() { return { enrolled: enrolledMap(), today: dayNo_(todayIso()) }; }
function fieldMsg(c) {
  const F = T.form, v = F.vals[c.key];
  let m = validateValue_(c, v, F.vals, ctx());
  if (!m && c.type === 'sidnew' && F.tab === 'S1_ENROL' && !F.existing && s_(v) && enrolledMap()[s_(v).toUpperCase()]) m = 'is already enrolled';
  if (!m && c.type === 'sidnew' && F.tab === 'S1_ENROL' && !F.existing && s_(v)) {         // screened out or not enrolled: stop here, so nothing is queued for the workbook to refuse
    const sc = view('S0_SCREEN').filter((r) => code_(r.study_id) === code_(v))[0];
    if (sc && sc.eligible === 'N') { const x = EXCL.filter((e) => e[0] === s_(sc.excl_code))[0]; m = 'was screened as not eligible' + (x ? ' (' + x[1] + ')' : '') + ', so it cannot be enrolled'; }
    else if (sc && sc.enrolled === 'N') m = 'was screened but not enrolled, so it cannot be enrolled';
  }
  return m;
}
function fieldEl(c) {
  const F = T.form, fixed = F.fixedKeys.indexOf(c.key) >= 0 || F.ro;
  const na = notApplicable(F.tab, c, F.vals);
  const box = el('div', { class: 'field' + (na ? ' na' : ''), id: 'f-' + c.key, 'aria-disabled': na ? 'true' : null });
  const msg = el('div', { class: 'msg', role: 'alert' });
  const carryFromScreening = () => { // number settled in the box: age and sex come from the screening line, however the form was opened
    if (F.tab !== 'S1_ENROL' || c.key !== 'study_id' || F.existing) return;
    const v = s_(F.vals.study_id), sc = idOk_(v) ? view('S0_SCREEN').filter((r) => code_(r.study_id) === v)[0] : null;
    F.carried = F.carried || [];
    if (sc) { F.vals.age_years = sc.age; F.vals.sex = sc.sex; ['age_years', 'sex'].forEach((k) => { if (F.carried.indexOf(k) < 0) F.carried.push(k); }); T.refill(); }
    else if (F.carried.length) { F.carried = []; F.vals.age_years = ''; F.vals.sex = ''; T.refill(); }
  };
  const set = (v, rerender) => {
    F.vals[c.key] = v; F.dirty = true;
    if (F.tab === 'R_SCORES' && c.key === 'cavity') F.vals.n_cavities = v === 'N' ? '0' : (v === 'Y' && F.vals.n_cavities === '0' ? '' : F.vals.n_cavities);
    if (F.tab === 'S1_ENROL' && c.key === 'dm_status') {          // not diabetic: the drugs answer is 0 (none) and closed; it opens again if the status changes
      if (v === '0') { F.vals.dm_drugs = '0'; F.autoDrugs = true; }
      else if (F.autoDrugs) { F.vals.dm_drugs = ''; F.autoDrugs = false; }
    }
    if (F.tab === 'S0_SCREEN') {                                  // smear negative fills the exclusion; any exclusion makes the candidate not eligible
      if (c.key === 'smear_grade') {
        if (v === 'N' && !s_(F.vals.excl_code)) { F.vals.excl_code = '8'; F.autoExcl = true; }
        else if (v !== 'N' && F.autoExcl) { F.vals.excl_code = ''; F.autoExcl = false; }
      }
      screenDerive(F.vals);
      if (s_(F.vals.excl_code)) F.autoNo = true;
      else if (F.autoNo) { F.vals.eligible = ''; F.vals.enrolled = ''; F.autoNo = false; }   // the exclusion was removed: the outcome is open again
    }
    const m = fieldMsg(c); msg.textContent = m ? c.label.split(',')[0] + ' ' + m : ''; box.classList.toggle('err', !!m);
    if (rerender) { const y = window.scrollY; T.refill(); window.scrollTo(0, y); }
    paintCalc();
  };
  // Enrolment and screening: the study number box reads the same as in the Link register ("Assign a study number", blank = the next free number).
  const nidBox = c.type === 'sidnew' && (F.tab === 'S1_ENROL' || F.tab === 'S0_SCREEN') && !F.ro && !fixed && !F.numberGiven, nid0 = nidBox ? nextId(F.tab) : '';
  box.append(el('label', { class: 'lab', for: 'i-' + c.key }, nidBox ? 'Assign a study number' : c.label), ...[itemWording(c.key)].filter(Boolean),
    el('div', { class: 'hint' }, nidBox ? (nid0 ? 'Leave blank to use the next free number: ' + nid0 + (F.tab === 'S0_SCREEN' ? ' (only if the patient is enrolled)' : '') + '. If the patient\'s card shows a different number, type that one.' : 'Type the number from the patient\'s card. There are no spare numbers on this phone: to get more, connect to the internet and press Sync.') : helpText_(c)), ...[infoBtn(c.key)].filter(Boolean));
  const val = s_(F.vals[c.key]);
  const carried = (F.carried || []).indexOf(c.key) >= 0, locked = carried || screenLocked(F, c);
  if (locked || (fixed && (APP_KEYS[F.tab].indexOf(c.key) >= 0 || F.ro))) {
    box.append(el('div', null, el('b', null, val || '–')), ...(locked ? [el('div', { class: 'hint' }, carried ? 'copied from the screening line' : 'decided by the screening answers')] : []));
    return box;
  }
  const relayout = ['visit', 'declined', 'event_type', 'phq9', 'hba1c_unit', 'glucose_unit', 'lipid_unit', 'smear_result', 'eligible', 'enrolled', 'e2_rucam_type', 'dm_status', 'smoking', 'smear_grade', 'excl_code'].indexOf(c.key) >= 0 || (F.tab === 'R_SCORES' && c.key === 'cavity');
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
    letters.concat([['0', 'none']]).forEach((l) => seg.append(el('button', { type: 'button', 'data-k': l[0], disabled: na, onclick: () => {
      let v = cur(); if (l[0] === '0') v = v === '0' ? '' : '0';
      else { v = v.replace('0', ''); v = v.indexOf(l[0]) >= 0 ? v.replace(l[0], '') : v + l[0]; v = letters.map((x) => x[0]).filter((x) => v.indexOf(x) >= 0).join(''); }
      set(v); paint(); } }, l[0], el('small', null, l[1]))));
    box.append(seg); paint();
  } else {
    const isNum = ['num', 'int', 'uniqueint', 'unitnum'].indexOf(c.type) >= 0;
    const type = c.type === 'date' ? 'date' : c.type === 'time' ? 'time' : ['sidnew', 'sid', 'sidl', 'rid'].indexOf(c.type) >= 0 ? 'tel' : 'text';   // study numbers open the number pad: a plain 7 is enough
    const unitMissing = c.type === 'unitnum' && !s_(F.vals[c.unit]);
    const inp = el('input', { id: 'i-' + c.key, type, value: val, autocomplete: 'off', inputmode: isNum ? (c.type === 'int' || c.type === 'uniqueint' ? 'numeric' : 'decimal') : null,
      autocapitalize: ['sidnew', 'sid', 'sidl', 'rid'].indexOf(c.type) >= 0 || BY_FIELDS.indexOf(c.key) >= 0 ? 'characters' : 'off',
      maxlength: c.type === 'text' ? String(c.max) : null, disabled: unitMissing || na, placeholder: unitMissing ? 'choose the unit first' : na ? 'does not apply' : ['sidnew', 'sid', 'sidl', 'rid'].indexOf(c.type) >= 0 ? 'e.g. 7 or ' + idOf_(7) : null,
      oninput: (ev) => set(['sidnew', 'sid', 'sidl', 'rid'].indexOf(c.type) >= 0 ? normId(ev.target.value) : ev.target.value),   // checked as the full number while typing; the box itself is tidied when you leave it
      onchange: (ev) => { const v = ['sidnew', 'sid', 'sidl', 'rid'].indexOf(c.type) >= 0 ? normId(ev.target.value) : ev.target.value; ev.target.value = v; set(v); carryFromScreening(); },
      onblur: (ev) => { if (['sidnew', 'sid', 'sidl', 'rid'].indexOf(c.type) >= 0) { const v = normId(ev.target.value); if (v !== ev.target.value) { ev.target.value = v; set(v); } carryFromScreening(); } } });
    if (F.tab === 'S1_ENROL' && c.key === 'regimen' && !F.ro) {      // one tap for the regimens the PI named; typing any other regimen still works
      const row = el('div', { class: 'seg quick', role: 'group', 'aria-label': c.label + ', quick choices' });
      const paint = () => row.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.v === s_(F.vals[c.key])));
      ['4HRZE/2HR'].forEach((x) => row.append(el('button', { type: 'button', 'data-v': x, onclick: () => { inp.value = x; set(x); paint(); } }, x)));
      inp.addEventListener('input', paint); paint();
      box.append(row);
    }
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
    if (c.type === 'sidnew' && !F.ro && !fixed && !F.numberGiven && (F.tab === 'S1_ENROL' || F.tab === 'S0_SCREEN')) {      // no suggestion once the number has come from the card
      const nid = nextId(F.tab);
      inp.readOnly = false; inp.placeholder = nidBox ? (nid0 || "type the number on the patient's card") : "type the number on the patient's card";      // the card is the source of the number; the suggestion below is only for a patient with no card yet
      if (!nidBox) box.append(el('button', { type: 'button', id: 'nextid', class: 'btn block', disabled: !nid, onclick: () => { inp.value = nid; set(nid); } }, nid ? 'No card yet? Next unused number: ' + nid : 'No spare numbers on this phone'));
      if (!nidBox && !nid && !(S.nums && S.nums.old)) box.append(el('div', { class: 'small muted' }, 'Type the number from the card. To get more spare numbers, connect to the internet and press Sync.' + (S.nums && S.nums.err ? ' (' + S.nums.err + ')' : '')));
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
  if ((F.tab === 'S1_ENROL' || (F.tab === 'S0_SCREEN' && F.vals.enrolled === 'Y')) && !F.existing && !F.ro && !F.numberGiven && !s_(F.vals.study_id)) {          // a blank study number takes the next free one, as in the Link register (a screening line only when the patient is enrolled)
    const nid = nextId(F.tab); if (nid) { F.vals.study_id = nid; const bx = $('#i-study_id'); if (bx) bx.value = nid; }
  }
  def.cols.forEach((c) => {
    if (['sidnew', 'sid', 'sidl', 'rid'].indexOf(c.type) >= 0 && s_(F.vals[c.key])) {        // a study number typed as 7 is saved as TBDM-007, even if the box was never left
      F.vals[c.key] = normId(F.vals[c.key]); const box = $('#i-' + c.key); if (box) box.value = F.vals[c.key];
    }
    const na = notApplicable(F.tab, c, F.vals);
    if (na) { F.vals[c.key] = c.key === 'dm_drugs' ? '0' : ''; return; }                 // faded fields that do not apply are blank when saved; the drugs of someone not diabetic are 0 (none)
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
  if (F.tab === 'SPIRO' && !F.existing && !spiroOk(s_(F.vals.study_id))) { toast('Spirometry is not done yet: the Visit 5 smear must be recorded as negative first.'); return; }
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
    return modal('Enrol now?', [el('p', null, F.vals.study_id + ' is not enrolled yet. Enter the enrolment record next.')], [['Later', after], ['Enrol', () => { T.nav.pop(); go('form', { tab: 'S1_ENROL', key: {}, preset: { study_id: F.vals.study_id, age_years: F.vals.age, sex: F.vals.sex }, carried: ['age_years', 'sex'] }); if (navigator.onLine) sync(); }, 'primary']]);
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
  const lim = limited(), keep = (tab) => (lim ? defOf(tab).cols.map((c) => c.key).filter((k) => nurseCol_(tab, k)) : defOf(tab).cols.map((c) => c.key));
  const data = {
    S0_SCREEN: [
      { screen_no: 1, screen_date: iso(42), age: 46, sex: 'M', smear_grade: '2', eligible: 'Y', enrolled: 'Y', study_id: PRAC_A, screened_by: 'PRAC' },
      { screen_no: 2, screen_date: iso(6), age: 39, sex: 'F', smear_grade: '1', eligible: 'Y', enrolled: 'Y', study_id: PRAC_B, screened_by: 'PRAC' },
      { screen_no: 3, screen_date: iso(5), age: 52, sex: 'M', smear_grade: '3', eligible: 'N', excl_code: EXCL[0][0], enrolled: 'N', screened_by: 'PRAC' }],
    S1_ENROL: [
      { study_id: PRAC_A, enrol_date: iso(40), att_start_date: iso(42), age_years: 46, sex: 'M', residence: 'U', education: '2', smoking: '0', alcohol: '0', dm_status: 'K', dm_years: 3, dm_drugs: 'M', htn: 'N', regimen: 'HRZE', smear_grade: '2', genexpert: 'D', rif_res: 'N', optout_questionnaires: 'A', optout_spirometry: 'A', entered_by: 'PRAC' },
      { study_id: PRAC_B, enrol_date: iso(4), att_start_date: iso(5), age_years: 39, sex: 'F', residence: 'R', education: '1', smoking: '0', alcohol: '0', dm_status: '0', htn: 'N', regimen: 'HRZE', smear_grade: '1', genexpert: 'D', rif_res: 'N', optout_questionnaires: 'A', optout_spirometry: 'A', entered_by: 'PRAC' }],
    S2_BASELINE: [{ study_id: PRAC_A, exam_date: iso(41), height_cm: 168, weight_kg: 52, waist_cm: 80, muac_mm: 230, examined_by: 'PRAC' }],
    VISITS: today >= attA + 21 ? [{ study_id: PRAC_A, visit: 'V2', attended: 'Y', visit_date: isoOf_(Math.min(today, v2)), treatment: 'C', adherence: 'G', entered_by: 'PRAC' }] : []
  };
  const tabs = {};
  SCHEMA.forEach((t) => { if (lim && NURSE_SCOPE[t.tab] === undefined) return; const cols = keep(t.tab); tabs[t.tab] = { cols, rows: (data[t.tab] || []).map((o) => { const full = row(t.tab, o), all = t.cols.map((c) => c.key); return cols.map((k) => full[all.indexOf(k)]); }) }; });
  if (role_ === 'reader1' || role_ === 'reader2') { tabs.R_SCORES = { cols: READER.cols.map((c) => c.key), rows: [] }; }
  return tabs;
}
function practiceStart() {
  if (T.practice) return;
  if (T.syncing) { toast('The phone is sending entries. Try again in a moment.'); return; }
  T.real = S;
  S = { cfg: Object.assign({}, S.cfg, { token: '', api: '', email: 'practice' }), outbox: [], lastSync: Date.now(), server: null };
  S.server = { access: T.real.server && T.real.server.access, tabs: practiceTabs(), at: Date.now(), films: /^reader/.test(T.real.cfg.role) ? [{ study_id: PRAC_A, cxr_date: isoOf_(dayNo_(todayIso()) - 41), repeat: false }, { study_id: PRAC_B, cxr_date: isoOf_(dayNo_(todayIso()) - 4), repeat: false }] : [] };
  T.practice = true; resetNav(); T.form = null; render();
}
function practiceStop() { if (!T.practice) return; S = T.real; T.real = null; T.practice = false; resetNav(); T.form = null; render(); }
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
// ------------------------------------------------------------------ data export (PI only): Excel, CSV, SPSS
// Study data only. The names, record numbers and telephone numbers of the confidential register are never part of it.
// Everything is built on the phone: no server, no library. A zip of stored (uncompressed) files is enough for all three formats.
const CRC_T = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(b) { let c = 0xFFFFFFFF; for (let i = 0; i < b.length; i++) c = CRC_T[(c ^ b[i]) & 255] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }
const utf8 = (s) => new TextEncoder().encode(s);
function zipStore(files) {                                          // files: [{ name, data: Uint8Array | string }]
  const parts = [], central = []; let off = 0;
  const u16 = (n) => [n & 255, (n >> 8) & 255], u32 = (n) => [n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >>> 24) & 255];
  const d = new Date(), dt = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(), tm = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  files.forEach((f) => {
    const name = utf8(f.name), data = typeof f.data === 'string' ? utf8(f.data) : f.data, crc = crc32(data);
    const head = Uint8Array.from([0x50, 0x4b, 3, 4, 20, 0, 0, 8, 0, 0].concat(u16(tm), u16(dt), u32(crc), u32(data.length), u32(data.length), u16(name.length), [0, 0]));      // bit 11 set: names are UTF-8
    parts.push(head, name, data);
    central.push(Uint8Array.from([0x50, 0x4b, 1, 2, 20, 0, 20, 0, 0, 8, 0, 0].concat(u16(tm), u16(dt), u32(crc), u32(data.length), u32(data.length), u16(name.length), [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], u32(off))), name);
    off += head.length + name.length + data.length;
  });
  const cdLen = central.reduce((a, b) => a + b.length, 0);
  const end = Uint8Array.from([0x50, 0x4b, 5, 6, 0, 0, 0, 0].concat(u16(files.length), u16(files.length), u32(cdLen), u32(off), [0, 0]));
  const all = parts.concat(central, [end]), out = new Uint8Array(all.reduce((a, b) => a + b.length, 0)); let p = 0;
  all.forEach((b) => { out.set(b, p); p += b.length; });
  return out;
}
// The tables: every data tab as entered, then the calculated tabs. Each is { name, cols: [{ key, label, type, codes }], rows: [[...]] }.
function exportTables() {
  const tables = [];
  defs().forEach((def) => {
    const rows = view(def.tab).filter((r) => def.cols.some((c) => s_(r[c.key]) !== ''));
    const cols = def.cols.map((c) => ({ key: c.key, label: c.label, type: c.type, codes: c.codes || null }));
    tables.push({ name: def.tab, title: def.title || NAMES[def.tab] || def.tab, cols, rows: rows.map((r) => cols.map((c) => s_(r[c.key]))) });
  });
  const out = derived(), map = { DERIVED_PARTICIPANT: out.participant, DERIVED_LABS: out.labs, DERIVED_VISITS: out.visits };
  Object.keys(map).forEach((name) => {
    const spec = DERIVED[name], rows = map[name] || [];
    tables.push({ name, title: 'Calculated by the app', cols: spec.map((c) => ({ key: c[0], label: c[1], type: c[2] === 'd' ? 'date' : c[2] === 'n' ? 'num' : 'text', codes: null })), rows: rows.map((r) => spec.map((c, i) => s_(r[i]))) });
  });
  return tables;
}
const NUMRE = /^-?\d+(\.\d+)?$/;
// Is the column numeric? A coded list is numeric only when every code is a number (so value labels never mix types); an empty column
// takes the type its form gives it; otherwise it is decided from what is in it, so one odd entry makes the column text, never a wrong number.
function exportIsNum(t, j) {
  const c = t.cols[j]; if (c.type === 'date' || c.type === 'time') return false;
  if (c.codes && c.codes.length) return c.codes.every((x) => NUMRE.test(s_(x[0])));
  if (['sid', 'sidnew', 'sidl', 'rid', 'text', 'regex', 'pairlist', 'list'].indexOf(c.type) >= 0) return false;
  return t.rows.map((r) => r[j]).filter((v) => v !== '').every((v) => NUMRE.test(v));
}
const isoSerial = (v) => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v); return m ? Math.round((Date.UTC(+m[1], +m[2] - 1, +m[3]) - Date.UTC(1899, 11, 30)) / 864e5) : null; };
function csvText(t, flat) {          // flat: line breaks inside a value become a space (SPSS reads one case per line)
  if (flat) t = { cols: t.cols, rows: t.rows.map((r) => r.map((v) => v.replace(/[\r\n]+/g, ' '))) };
  const q = (v) => (/[",\r\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v);
  // free text that starts with = + @ (or - and then a letter) would be run as a formula by Excel: a leading apostrophe stops that
  const safe = (v, c) => (c && (c.type === 'text' || c.type === 'regex') && /^([=+@]|-(?![\d.]))/.test(v) ? "'" + v : v);
  return '\ufeff' + [t.cols.map((c) => q(c.key)).join(',')].concat(t.rows.map((r) => r.map((v, j) => q(safe(v, t.cols[j]))).join(','))).join('\r\n') + '\r\n';
}
const xmlEsc = (v) => String(v).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').replace(/\r/g, '&#13;');
function colLetter(n) { let s = ''; for (n++; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s; return s; }
function codebookRows(tables) { return [].concat.apply([], tables.map((t) => t.cols.map((c) => [t.name, c.key, c.label, c.type, c.codes ? c.codes.map((x) => x[0] + ' = ' + x[1]).join('; ') : '']))); }
const CODEBOOK_COLS = ['table', 'variable', 'label', 'type', 'codes'].map((k) => ({ key: k, label: k, type: 'text', codes: null }));
function xlsxBytes(tables) {
  const all = [{ name: 'Codebook', t: { cols: CODEBOOK_COLS, rows: codebookRows(tables) } }].concat(tables.map((t) => ({ name: t.name, t })));
  const cell = (ref, v, kind, style) => kind === 'n' ? '<c r="' + ref + '"' + (style ? ' s="' + style + '"' : '') + '><v>' + v + '</v></c>' : '<c r="' + ref + '" t="inlineStr"' + (style ? ' s="' + style + '"' : '') + '><is><t xml:space="preserve">' + xmlEsc(v) + '</t></is></c>';
  const files = [
    { name: '[Content_Types].xml', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' + all.map((s, i) => '<Override PartName="/xl/worksheets/sheet' + (i + 1) + '.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>').join('') + '</Types>' },
    { name: '_rels/.rels', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>' },
    { name: 'xl/workbook.xml', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>' + all.map((s, i) => '<sheet name="' + xmlEsc(s.name) + '" sheetId="' + (i + 1) + '" r:id="rId' + (i + 1) + '"/>').join('') + '</sheets></workbook>' },
    { name: 'xl/_rels/workbook.xml.rels', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' + all.map((s, i) => '<Relationship Id="rId' + (i + 1) + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet' + (i + 1) + '.xml"/>').join('') + '<Relationship Id="rId' + (all.length + 1) + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>' },
    { name: 'xl/styles.xml', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="1"><numFmt numFmtId="164" formatCode="yyyy\\-mm\\-dd"/></numFmts><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>' }];
  all.forEach((s, si) => {
    const t = s.t, num = t.cols.map((c, j) => (s.name === 'Codebook' ? false : exportIsNum(t, j))), isDate = t.cols.map((c) => c.type === 'date');
    let xml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><sheetData>';
    xml += '<row r="1">' + t.cols.map((c, j) => cell(colLetter(j) + '1', c.key, 's', 2)).join('') + '</row>';
    t.rows.forEach((r, i) => {
      xml += '<row r="' + (i + 2) + '">' + r.map((v, j) => {
        if (v === '') return '';
        const ref = colLetter(j) + (i + 2);
        if (num[j]) return cell(ref, v, 'n');
        if (isDate[j]) { const n = isoSerial(v); if (n !== null) return cell(ref, n, 'n', 1); }
        return cell(ref, v, 's');
      }).join('') + '</row>';
    });
    files.push({ name: 'xl/worksheets/sheet' + (si + 1) + '.xml', data: xml + '</sheetData></worksheet>' });
  });
  return zipStore(files);
}
// SPSS: one CSV per table and one syntax file that reads them all, with variable labels and value labels, and saves a .sav for each.
function spsText(tables, stamp) {
  const lit = (v) => "'" + String(v).replace(/'/g, "''").replace(/[\r\n]+/g, ' ') + "'";
  let s = '* TBDM study data. Exported ' + stamp + ' from the TBDM Field app.\r\n* 1. Put this file and all the .csv files in one folder.  2. Change the folder in the next line.  3. Run all (Run > All).\r\nCD ' + lit('C:\\TBDM') + '.\r\n\r\n';
  tables.forEach((t) => {
    const nums = t.cols.map((c, j) => exportIsNum(t, j));
    const fmt = t.cols.map((c, j) => {
      if (c.type === 'date' && t.rows.every((r) => r[j] === '' || isoSerial(r[j]) !== null)) return 'SDATE10';
      if (nums[j]) { let w = 1, d = 0; t.rows.forEach((r) => { const v = r[j]; if (v !== '') { w = Math.max(w, v.length); const p = v.indexOf('.'); if (p >= 0) d = Math.max(d, v.length - p - 1); } }); return 'F' + (w + 1) + '.' + d; }
      let w = 1; (c.codes || []).forEach((x) => { w = Math.max(w, utf8(s_(x[0])).length); }); t.rows.forEach((r) => { w = Math.max(w, utf8(r[j]).length); }); return 'A' + Math.min(Math.max(w, 1), 32767);
    });
    s += '* ---- ' + t.name + ' (' + t.rows.length + ' rows)\r\nGET DATA /TYPE=TXT /FILE=' + lit(t.name + '.csv') + " /ENCODING='UTF8' /DELCASE=LINE /DELIMITERS=\",\" /QUALIFIER='\"' /ARRANGEMENT=DELIMITED /FIRSTCASE=2 /VARIABLES=\r\n";
    s += t.cols.map((c, j) => '  ' + c.key + ' ' + fmt[j]).join('\r\n') + '.\r\n';
    s += 'VARIABLE LABELS\r\n' + t.cols.map((c) => '  ' + c.key + ' ' + lit(String(c.label).slice(0, 250))).join('\r\n') + '.\r\n';
    const vl = t.cols.map((c, j) => c.codes && c.codes.length ? '  ' + c.key + '\r\n' + c.codes.map((x) => '    ' + (nums[j] ? x[0] : lit(x[0])) + ' ' + lit(String(x[1] || x[0]).slice(0, 120))).join('\r\n') : null).filter(Boolean);
    if (vl.length) s += 'VALUE LABELS\r\n' + vl.join(' /\r\n') + '.\r\n';
    s += 'EXECUTE.\r\nSAVE OUTFILE=' + lit(t.name + '.sav') + '.\r\n\r\n';
  });
  return s;
}
async function exportBuild(kind) {
  const tables = exportTables(), stamp = todayIso(), base = 'TBDM_data_' + stamp;
  if (kind === 'xlsx') return { name: base + '.xlsx', type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', data: xlsxBytes(tables) };
  const csvOf = (flat) => tables.map((t) => ({ name: t.name + '.csv', data: csvText(t, flat) })).concat([{ name: 'codebook.csv', data: csvText({ cols: CODEBOOK_COLS, rows: codebookRows(tables) }, flat) }]);
  if (kind === 'csv') return { name: base + '_csv.zip', type: 'application/zip', data: zipStore(csvOf(false)) };
  return { name: base + '_spss.zip', type: 'application/zip', data: zipStore(csvOf(true).concat([{ name: 'TBDM_import.sps', data: '\ufeff' + spsText(tables, stamp) }])) };
}
async function exportDeliver(file) {
  if (T.exportHook) { T.exportHook(file); return; }
  const blob = new Blob([file.data], { type: file.type }), f = new File([blob], file.name, { type: file.type });
  const phone = /iPhone|iPad|Android/i.test(navigator.userAgent || '');
  if (phone && navigator.canShare && navigator.canShare({ files: [f] })) {           // the share sheet is how a home-screen app hands a file to Files, Mail or Drive
    try { await navigator.share({ files: [f], title: file.name }); return; } catch (e) { if (e && e.name === 'AbortError') return; }
  }
  const a = el('a', { href: URL.createObjectURL(blob), download: file.name }); document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 60000);
}
function exportAsk() {
  let kind = 'xlsx';
  const pending = S.outbox.length;
  const opts = [['xlsx', 'Excel', '.xlsx, one sheet per form'], ['csv', 'CSV', 'one file per form, in a zip'], ['spss', 'SPSS', 'CSV files and a syntax file that adds the labels']];
  const body = el('div', null,
    el('p', null, 'Study data from all forms, plus the values the app calculates, with a codebook of every variable. Names, record numbers and telephone numbers are never included.'),
    el('div', { class: 'seg', id: 'export-kind' }, opts.map((o) => el('button', { type: 'button', 'data-k': o[0], class: o[0] === kind ? 'on' : '', onclick: (ev) => { kind = o[0]; ev.currentTarget.parentNode.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.k === kind)); } }, o[1], el('small', null, o[2])))),
    el('p', { class: 'small muted' }, 'The file is not encrypted. Keep it on a protected device and delete it when you are done.' + (pending ? ' ' + pending + ' entr' + (pending === 1 ? 'y' : 'ies') + ' on this phone not yet sent are included.' : '')));
  modal('Export data', body, [['Cancel', null], ['Export', async () => { try { const f = await exportBuild(kind); await exportDeliver(f); toast('Exported ' + f.name); } catch (e) { toast('Could not export: ' + (e && e.message || e)); } }, 'primary']]);
}

// ------------------------------------------------------------------ photos of source documents (switched on by the PI)
// A photo is shrunk, encrypted with the PIN key and kept on this phone until the next sync, then sent and deleted here.
// Phones that take photos cannot view them; the PI, the verifier and the DOTS incharge can; radiograph readers see only
// radiographs whose name label was covered on the phone. Nothing is written to the phone's gallery.
const PHOTO_DOC_NAMES = { CONSENT: 'Consent form', CORE: 'Core Per-Patient File', EXAM: 'Examination sheet', SMEAR: 'Sputum smear report', WITHDRAW: 'Withdrawal Deletion Record', ALERT: 'PHQ-9 item 9 alert slip', LAB: 'Lab report', SPIRO: 'Spirometry printout', CXR: 'Chest radiograph' };
const PHOTO_DOCS_FOR = { S1_ENROL: ['CONSENT', 'SMEAR', 'CORE'], S2_BASELINE: ['EXAM'], END_STUDY: ['WITHDRAW'], EVENTS: ['ALERT'], LABS: ['LAB'], SPIRO: ['SPIRO'], S3_CXR: ['CXR'] };
const PHOTO_MAX_PX = 2000;
// A lab report comes as separate pages; each visit needs the pages of the tests ordered at it (visit checklist).
const LAB_PAGES = { CBC: 'Blood count (CBC)', LFT: 'Liver tests (LFT)', HBA1C: 'HbA1c', LIPID: 'Lipid profile', FPG: 'Fasting glucose', HEP: 'Viral serology (HBsAg, anti-HCV)', HIV: 'HIV' };
const LAB_PAGES_FOR = { V1: ['CBC', 'LFT', 'HBA1C', 'LIPID', 'FPG', 'HEP', 'HIV'], V2: ['LFT'], V3: ['CBC', 'LFT'], V4: ['HBA1C', 'CBC', 'LFT'], V5: ['CBC', 'LFT'], U: ['LFT'] };
Object.keys(LAB_PAGES).forEach((k) => { PHOTO_DOC_NAMES['LAB_' + k] = LAB_PAGES[k]; });
function labDocs(visit) { const v = s_(visit).toUpperCase(); return (LAB_PAGES_FOR[/^U/.test(v) ? 'U' : v] || []).map((k) => 'LAB_' + k); }
function smearVisit(visit, sid) { const v = s_(visit).toUpperCase(); return smearDue_(v, sid ? (find('VISITS', { study_id: sid, visit: 'V3' }) || {}).smear_result : 'N'); }   // V3 and V5; V4 while the V3 smear is not negative
function docsFor(tab, visit, sid) {                           // the documents a form offers to photograph
  if (tab === 'LABS') return labDocs(visit);
  if (tab === 'VISITS') return smearVisit(visit, sid) ? ['SMEAR'] : [];
  return PHOTO_DOCS_FOR[tab] || [];
}
function requiredDocs(tab, visit, sid) {                           // the documents a form must have before it shows as complete (the Core File stays optional)
  if (tab === 'S1_ENROL') return ['CONSENT', 'SMEAR'];         // consent and the diagnostic smear report (or NTP card)
  if (tab === 'END_STUDY') return ['WITHDRAW'];
  return docsFor(tab, visit, sid);
}
// Where each document stands for one participant and visit: on the server (from the cached list or this phone's sent log), waiting on this phone, or missing.
function docState(sid, doc, visit) {
  const same = (x) => x.doc === doc && (x.visit || '') === (visit || '');
  if ((S.photoOut || []).some((x) => x.sid === sid && same(x))) return 'waiting';
  const c = T.phc && T.phc[sid];
  if ((c && c.list.some(same)) || (S.photoSent || []).some((x) => x.sid === sid && same(x))) return 'sent';
  return 'missing';
}
function photosOn() { return !T.practice && !!(S && S.server && S.server.photos); }
function photoTaker() { return can('photoTake'); }
function photoViewer() { return can('photoView'); }
function hex(buf) { return Array.from(new Uint8Array(buf)).map((b) => ('0' + b.toString(16)).slice(-2)).join(''); }
function rndHex(n) { return hex(crypto.getRandomValues(new Uint8Array(n))); }
async function fileToCanvas(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('This file is not a picture the phone can read.')); i.src = url; });
    const k = Math.min(1, PHOTO_MAX_PX / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement('canvas'); c.width = Math.round(img.naturalWidth * k); c.height = Math.round(img.naturalHeight * k);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    return c;
  } finally { URL.revokeObjectURL(url); }
}
const canvasJpeg = (c) => new Promise((res) => c.toBlob((b) => res(b), 'image/jpeg', 0.85));
async function photoQueue(canvas, meta) {                  // encrypt and keep until the next sync
  const blob = await canvasJpeg(canvas), bytes = new Uint8Array(await blob.arrayBuffer());
  const sha = hex(await crypto.subtle.digest('SHA-256', bytes)), id = rndHex(16), iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, KEY, bytes);
  await kvSet('ph_' + id, { iv, ct });
  S.photoOut = S.photoOut || [];
  S.photoOut.push(Object.assign({ id, sha, mime: 'image/jpeg', at: new Date().toISOString().slice(0, 16), status: 'pending' }, meta));
  await saveState();
}
async function pushPhotos(still) {
  const list = (S.photoOut || []).slice();
  for (const ph of list) {
    const box = await kvGet('ph_' + ph.id);
    if (!box) { S.photoOut = S.photoOut.filter((x) => x.id !== ph.id); continue; }
    const bytes = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: box.iv }, KEY, box.ct));
    const res = await api({ op: 'photo_put', token: S.cfg.token, photo_id: ph.id, study_id: ph.sid, doc: ph.doc, visit: ph.visit || '', covered: ph.covered || 'N', mime: ph.mime, data: b64(bytes), sha256: ph.sha, taken_at: ph.at, note: ph.note || '' }, 90000); still();
    if (res.code === 401) throw Object.assign(new Error(res.error || 'not authorised'), { code: 401 });
    const cur = (S.photoOut || []).filter((x) => x.id === ph.id)[0];
    if (res.ok) {
      await kvDel('ph_' + ph.id);
      S.photoOut = S.photoOut.filter((x) => x.id !== ph.id);
      S.photoSent = [{ sid: ph.sid, doc: ph.doc, visit: ph.visit || '', at: ph.at }].concat(S.photoSent || []).slice(0, 300);
    } else if (cur) { cur.status = 'error'; cur.err = res.error || 'not accepted'; }
    await saveState();
  }
}
// The radiograph's name label is covered before anything leaves the phone: drag black boxes over it.
function coverTool(canvas, done) {
  const rects = [], ov = el('div', { class: 'cover', role: 'dialog', 'aria-label': 'Cover the name label' });
  const view = document.createElement('canvas'), ctxv = view.getContext('2d');
  const fit = () => { const w = Math.min(innerWidth - 24, 900), h = innerHeight - 190, k = Math.min(w / canvas.width, h / canvas.height); view.width = Math.round(canvas.width * k); view.height = Math.round(canvas.height * k); view._k = k; draw(); };
  const draw = (tmp) => { ctxv.drawImage(canvas, 0, 0, view.width, view.height); ctxv.fillStyle = '#000'; rects.concat(tmp ? [tmp] : []).forEach((r) => ctxv.fillRect(r.x * view._k, r.y * view._k, r.w * view._k, r.h * view._k)); };
  let start = null;
  const pt = (e) => { const b = view.getBoundingClientRect(); return { x: (e.clientX - b.left) / view._k, y: (e.clientY - b.top) / view._k }; };
  const box = (a, b) => ({ x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) });
  view.addEventListener('pointerdown', (e) => { start = pt(e); view.setPointerCapture(e.pointerId); e.preventDefault(); });
  view.addEventListener('pointermove', (e) => { if (start) draw(box(start, pt(e))); });
  view.addEventListener('pointerup', (e) => { if (!start) return; const r = box(start, pt(e)); start = null; if (r.w > 4 && r.h > 4) rects.push(r); draw(); count.textContent = rects.length ? rects.length + ' area' + (rects.length > 1 ? 's' : '') + ' covered' : 'Nothing covered yet'; });
  const count = el('div', { class: 'small', id: 'cover-count' }, 'Nothing covered yet');
  const close = () => ov.remove();
  ov.append(el('div', { class: 'cover-head' }, el('b', null, 'Cover the name and record number'), el('div', { class: 'small' }, 'Drag a box over every label that shows who the patient is. Readers see only the covered copy.')),
    view, count,
    el('div', { class: 'cover-acts' },
      el('button', { class: 'btn', onclick: close }, 'Cancel'),
      el('button', { class: 'btn', onclick: () => { rects.pop(); draw(); count.textContent = rects.length ? rects.length + ' covered' : 'Nothing covered yet'; } }, 'Undo'),
      el('button', { class: 'btn primary', id: 'cover-save', onclick: () => {
        if (!rects.length) { toast('Cover the name label first.'); return; }
        const c = document.createElement('canvas'); c.width = canvas.width; c.height = canvas.height; const g = c.getContext('2d');
        g.drawImage(canvas, 0, 0); g.fillStyle = '#000'; rects.forEach((r) => g.fillRect(r.x, r.y, r.w, r.h));
        close(); done(c);
      } }, 'Save')));
  document.body.append(ov); fit();
  T.coverRects = rects;                                    // for the tests
}
async function photoTake(file, F, doc) {
  const sid = s_(F.vals.study_id).toUpperCase(), visit = s_(F.vals.visit).toUpperCase();
  let canvas;
  try { canvas = await fileToCanvas(file); } catch (e) { toast(e.message); return; }
  const base = { sid, doc, visit: /^(V[1-5]|U[1-5])$/.test(visit) ? visit : '', by: S.cfg.initials };
  const finish = async () => { toast('Photo kept on this phone, locked with your PIN. It is sent at the next sync.'); paintPhotoCard(); if (navigator.onLine) sync(); };
  if (doc === 'CXR') {
    coverTool(canvas, async (covered) => {
      await photoQueue(covered, Object.assign({}, base, { covered: 'Y' }));
      await photoQueue(canvas, Object.assign({}, base, { covered: 'N' }));          // the uncovered original, for the PI, the verifier and the DOTS incharge only
      finish();
    });
    return;
  }
  await photoQueue(canvas, Object.assign({}, base, { covered: 'N' }));
  finish();
}
function photoCard(F) {
  const docs = docsFor(F.tab, F.vals.visit, s_(F.vals.study_id).toUpperCase());
  if (!docs.length || !photosOn() || !photoTaker() || F.ro) return null;
  const box = el('div', { class: 'card photocard', id: 'photocard' });
  T.photoF = F;
  paintPhotoCard(box);
  return box;
}
function paintPhotoCard(target) {
  const box = target || $('#photocard'), F = T.photoF;
  if (!box || !F) return;
  const sid = s_(F.vals.study_id).toUpperCase(), visit = s_(F.vals.visit).toUpperCase();
  const mine = (x) => x.sid === sid && (x.visit || '') === (/^(V|U)\d$/.test(visit) ? visit : '');
  const queued = (S.photoOut || []).filter(mine), sent = (S.photoSent || []).filter(mine);
  const pick = (doc, capture) => {
    const inp = el('input', { type: 'file', accept: 'image/*', capture: capture ? 'environment' : null, hidden: true, 'data-doc': doc, class: 'photoinput' + (capture ? ' cam' : ' file') });
    inp.addEventListener('change', () => { const f = inp.files && inp.files[0]; inp.value = ''; if (f) photoTake(f, F, doc); });
    return inp;
  };
  const v = /^(V|U)\d$/.test(visit) ? visit : '', docs = docsFor(F.tab, F.vals.visit, sid), states = docs.map((d) => docState(sid, d, v));
  const done = states.filter((x) => x !== 'missing').length;
  const mark = (st) => el('span', { class: 'dmark ' + st, 'aria-label': st === 'sent' ? 'sent' : st === 'waiting' ? 'waiting to send' : 'not attached yet' }, st === 'missing' ? '' : '✓');
  box.replaceChildren(el('b', null, 'Source documents'),
    el('div', { class: 'small muted' }, sid ? (docs.length > 1 ? done + ' of ' + docs.length + ' attached for ' + sid + (visit ? ' ' + visit : '') + '. ' : 'Attached to ' + sid + (visit ? ' ' + visit : '') + '. ') + 'Once sent, this phone cannot show them again.' : 'Enter the study number first.'),
    ...docs.map((doc, i) => {
      const cam = pick(doc, true), file = pick(doc, false), st = states[i], err = queued.filter((x) => x.doc === doc && x.status === 'error' && x.err)[0];
      return el('div', { class: 'photorow' }, mark(st), el('div', { class: 'grow' }, PHOTO_DOC_NAMES[doc], el('small', null, err ? 'not accepted: ' + err.err : st === 'sent' ? 'sent' : st === 'waiting' ? 'waiting to send' : 'not attached yet')),
        cam, file,
        el('div', { class: 'pbtns' },
          el('button', { class: 'pbtn', type: 'button', disabled: !sid, 'aria-label': st === 'missing' ? 'Take photo' : 'Add page', title: 'Take photo', onclick: () => cam.click() }, icon('camera')),
          el('button', { class: 'pbtn', type: 'button', disabled: !sid, 'aria-label': 'Choose file', title: 'Choose file (screenshot)', onclick: () => file.click() }, icon('export'))));
    }))
}
// Viewing: online only, nothing is kept on the phone.
function photoViewCard(sid) {
  if (!photosOn() || !(photoViewer() || /^reader/.test(role())) || !sid) return null;
  const box = el('div', { class: 'card photoview', id: 'photoview' });
  const load = async () => {
    box.replaceChildren(el('b', null, /^reader/.test(role()) ? 'Radiograph photo' : 'Source documents'), el('div', { class: 'small muted' }, 'Loading…'));
    try {
      const r = await api({ op: 'photo_list', token: S.cfg.token, study_id: sid }, 20000);
      if (!r.ok) throw new Error(r.error || 'not available');
      box.replaceChildren(el('b', null, /^reader/.test(role()) ? 'Radiograph photo' : 'Source documents'),
        r.photos.length ? el('div', { class: 'list' }, r.photos.map((ph) => el('button', { class: 'row', type: 'button', onclick: () => photoOpen(ph) },
          el('div', { class: 'main' }, el('div', null, PHOTO_DOC_NAMES[ph.doc] + (ph.visit ? ' ' + ph.visit : '') + (ph.covered === 'Y' ? ' (label covered)' : '')), el('div', { class: 'sub' }, [s_(ph.taken_at).replace('T', ' '), ph.taken_by].filter(Boolean).join(' · '))),
          ph.flag ? el('span', { class: 'chip bad' }, 'too poor') : null, el('span', { class: 'chev' })))) : el('div', { class: 'small muted' }, 'No photos yet.'));
    } catch (e) { box.replaceChildren(el('b', null, 'Source documents'), el('div', { class: 'small muted' }, navigator.onLine ? 'Could not load: ' + e.message : 'Photos open only with a signal.')); }
  };
  box.append(el('b', null, /^reader/.test(role()) ? 'Radiograph photo' : 'Source documents'), el('button', { class: 'btn block', type: 'button', id: 'photo-show', onclick: load }, 'Show photos'));
  return box;
}
// ---- participant page blocks: what is worth knowing before tapping
function contactTile(sid) {                                // the block opens the contact details; the number inside it is its own button: Call or WhatsApp
  const L = confAsList(), r = L ? L.rows.filter((x) => s_(x.study_id).toUpperCase() === sid)[0] : null;
  const name = r && s_(r.name), ph = r && s_(r.phone);
  const open = () => go('link', { sid: sid });
  return el('div', { class: 'ctile', id: 'tile-contact', role: 'button', tabindex: '0', 'aria-label': 'Contact details of ' + sid, onclick: open, onkeydown: (e) => { if (e.key === 'Enter') open(); } }, icon('phone'),
    el('span', { class: 'ctx' }, el('b', null, name || 'Contact'), !ph && L ? el('small', null, 'No number yet') : null),
    ph ? el('button', { class: 'telpill', type: 'button', id: 'tile-tel', 'aria-label': 'Call or WhatsApp ' + ph, onclick: (e) => { e.stopPropagation(); contactAct(sid, r); } }, ph) : null);
}
// The documents this participant's records call for, against the photos received: shows what is still missing.
function photoNeeds(sid) {                                 // every required document: enrolment, then each visit's forms once the visit window has opened
  const lab = (d) => (/^LAB_/.test(d) ? LAB_PAGES[d.slice(4)].replace(/ \(.*\)$/, '') : PHOTO_DOC_NAMES[d].toLowerCase());
  const need = requiredDocs('S1_ENROL').map((d) => [d, '', d === 'CONSENT' ? 'consent' : 'diagnostic smear']);
  Object.keys(VISIT_FORMS).forEach((v) => {
    if (visitOpens(sid, v)) return;
    VISIT_FORMS[v].forEach((f) => {
      if (f[0] === 'END_STUDY' || (f[0] === 'SPIRO' && !find('SPIRO', { study_id: sid }) && !spiroOk(sid))) return;
      requiredDocs(f[0], f[1], sid).forEach((d) => need.push([d, f[1] || '', /^LAB_/.test(d) ? 'lab ' + f[1] + ' ' + lab(d) : d === 'SMEAR' ? 'smear ' + f[1] : lab(d) + (f[1] ? ' ' + f[1] : '')]));
    });
  });
  if (view('END_STUDY').some((r) => r.study_id === sid && r.status === 'W')) need.push(['WITHDRAW', '', 'withdrawal record']);
  return need;
}
function photoSummary(sid, list) {
  const miss = photoNeeds(sid).filter((n) => docState(sid, n[0], n[1]) === 'missing' && !list.some((ph) => ph.doc === n[0] && (!n[1] || ph.visit === n[1])));
  const labs = {}, missing = [];
  miss.forEach((n) => { if (/^LAB_/.test(n[0])) { if (!labs[n[1]]) { labs[n[1]] = 0; missing.push('lab ' + n[1]); } labs[n[1]]++; } else missing.push(n[2]); });
  missing.forEach((m, i) => { const v = /^lab (V\d|U\d)$/.exec(m); if (v && labs[v[1]] > 1) missing[i] = m + ' (' + labs[v[1]] + ' pages)'; });
  const poor = list.filter((ph) => ph.flag).length;
  const head = (list.length ? list.length + ' attached' : 'None attached') + (poor ? ' · ' + poor + ' too poor' : '');
  const tail = missing.length ? 'Missing: ' + missing.slice(0, 2).join(', ') + (missing.length > 2 ? ' and ' + (missing.length - 2) + ' more' : '') : (list.length ? 'All documents attached' : '');
  return [head, tail];
}
// Which documents of this participant have reached the server (cached for a minute; online only). Viewers get the full list,
// phones that only take photos get document and visit only.
function photoFetch(sid, after) {
  T.phc = T.phc || {};
  const c = T.phc[sid];
  if (!photosOn() || !navigator.onLine || (c && Date.now() - c.at < 60000) || T.phcBusy === sid) return;
  T.phcBusy = sid;
  setTimeout(async () => {                                          // never inside a render
    try { const r = await api({ op: 'photo_list', token: S.cfg.token, study_id: sid }, 15000); if (r.ok) { T.phc[sid] = { at: Date.now(), list: r.photos }; if (after) after(); } } catch (e) { /* stays as it is */ }
    T.phcBusy = '';
  }, 0);
}
// "No document" pill beside a form's status pill on the participant page, for every form whose visit is open: its source document has not reached the server.
const DOC_FOR = { S1_ENROL: 'CONSENT', S2_BASELINE: 'EXAM', LABS: 'LAB', S3_CXR: 'CXR', SPIRO: 'SPIRO', END_STUDY: 'WITHDRAW' };
function docPill(sid, tab, visit, row) {
  const c = T.phc && T.phc[sid];
  const docs = requiredDocs(tab, visit, sid);
  if (!docs.length || !c || !photosOn() || !photoTaker()) return null;          // shown for every open form, entered or not
  if (tab === 'END_STUDY' && !(row && row.status === 'W')) return null;
  const have = docs.filter((d) => docState(sid, d, visit || '') !== 'missing').length;
  const key = visit ? { study_id: sid, visit } : { study_id: sid };
  const open = (e) => { e.stopPropagation(); go('form', { tab, key, docFocus: true }); };
  if (have === docs.length) return el('span', { class: 'chip docok', title: 'All documents attached' }, docs.length > 1 ? docs.length + '/' + docs.length + ' ✓' : 'doc ✓');
  return el('button', { class: 'chip docmiss', type: 'button', onclick: open }, have ? have + '/' + docs.length + ' docs' : 'no doc');
}
function photosTile(sid) {
  T.phc = T.phc || {};
  const c = T.phc[sid], b = el('button', { class: 'ctile', id: 'tile-photos', 'aria-label': 'Source documents of ' + sid, onclick: () => go('photos', { sid: sid }) }, icon('records'), el('span', { class: 'ctx' }));
  const paint = (lines) => { const x = b.querySelector('.ctx'); x.replaceChildren(el('b', null, 'Documents'), ...lines.filter(Boolean).map((t) => el('small', null, t))); };
  paint(c ? photoSummary(sid, c.list) : [navigator.onLine ? 'Checking…' : 'Opens with a signal']);
  photoFetch(sid, () => { if (cur().name === 'participant' && !(T.form && T.form.dirty)) render(); });
  return b;
}
function photosScreen(p) {                                  // the participant's photos, loaded straight away (online only)
  const card = photoViewCard(p.sid);
  if (card) setTimeout(() => { const b = $('#photo-show'); if (b) b.click(); }, 0);
  return topBar('Source documents · ' + p.sid).concat([el('main', null, card || el('div', { class: 'card' }, 'Source documents are not available on this phone.'))]);
}
async function photoOpen(ph) {
  const ov = el('div', { class: 'photo-full', role: 'dialog', 'aria-label': 'Photo' }, el('div', { class: 'small' }, 'Loading…'));
  const close = () => ov.remove();
  document.body.append(ov);
  try {
    const r = await api({ op: 'photo_get', token: S.cfg.token, photo_id: ph.photo_id }, 45000);
    if (!r.ok) throw new Error(r.error || 'not available');
    const img = el('img', { src: 'data:' + r.mime + ';base64,' + r.data, alt: PHOTO_DOC_NAMES[ph.doc] });
    ov.replaceChildren(el('div', { class: 'pf-bar' }, el('b', null, PHOTO_DOC_NAMES[ph.doc] + (ph.visit ? ' ' + ph.visit : '')),
      el('button', { class: 'btn small', type: 'button', id: 'photo-poor', onclick: async () => { const f = await api({ op: 'photo_flag', token: S.cfg.token, photo_id: ph.photo_id }, 20000).catch(() => ({})); toast(f.ok ? 'Marked too poor to read. The PI is told.' : 'Could not mark it.'); } }, 'Too poor to read'),
      el('button', { class: 'btn small', type: 'button', id: 'photo-close', onclick: close }, 'Close')), el('div', { class: 'pf-img' }, img));
  } catch (e) { ov.replaceChildren(el('div', { class: 'small' }, 'Could not open: ' + e.message), el('button', { class: 'btn', onclick: close }, 'Close')); }
}

(async function start() {
  readJoin();
  try { T.hasVault = !!(await kvGet('vault')); T.hasBio = T.hasVault && !!(await kvGet('bio')); } catch (e) { T.hasVault = false; T.hasBio = false; }
  bioAvailable().then((v) => { T.bioOk = v; if (!KEY && T.hasVault) render(); });
  if (T.hasVault) await sessRestore();
  if ('serviceWorker' in navigator) setupAutoUpdate();
  render();
})();

// ---- automatic updates: nothing is asked of the user. A new version is fetched in the background and
// switched in the next time the app is on its lock screen (after locking, the idle lock, or when reopened),
// so it never interrupts an entry and never needs the PIN to be typed because of the update.
let updateReady = false;
function applyUpdateIfSafe() {
  if (!updateReady || KEY || T.pin || T.join || T.bioBusy) return;           // never while the phone is asking for Face ID: reloading then makes it ask a second time                       // only when locked, no PIN half typed, not mid-setup
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
