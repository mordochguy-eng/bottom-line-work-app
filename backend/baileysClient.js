// WhatsApp client built on Baileys (@whiskeysockets/baileys): talks to WhatsApp
// directly from this Node process. No Docker, no browser, no third-party cloud.
// It is the app's only WhatsApp connection (Green API was removed).
//
// Things to know:
//  - The WhatsApp connection lives inside this process. If the computer is off
//    nothing can be sent; WhatsApp redelivers recent missed messages on reconnect.
//  - There is no "get chat history" call. Messages are collected as they arrive
//    (plus the history WhatsApp pushes once at pairing) into data/wa-store.json.
//
// Chat ids keep the format used everywhere else in the app:
//   individuals: <phone>@c.us    groups: <id>@g.us    (LID chats keep their @lid id)
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import axios from 'axios';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, 'data');
const AUTH_DIR = path.join(DATA_DIR, 'baileys-auth');
const STORE_FILE = path.join(DATA_DIR, 'wa-store.json');
export const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');

const MAX_PER_CHAT = 400;
const MAX_AGE_DAYS = 90;
const RAW_KEEP_DAYS = 21;
const QUEUE_MAX_AGE_SEC = 24 * 3600; // don't feed old catch-up messages to live insights

let B = null;          // baileys module (loaded lazily so the app still boots if it is missing)
let QR = null;         // qrcode module (optional)
let pinoLib = null;

const state = { status: 'idle', qr: null, qrDataUrl: null, user: null, lastError: null, updatedAt: Date.now(),
  lastIncomingAt: 0, lastSend: null, lastRead: null };
let sock = null;
let starting = false;
let stopped = false;
let reconnectTimer = null;
let reconnectAttempts = 0;

const contacts = new Map();   // jid -> { id, name, notify }
const messages = new Map();   // chatId -> [stored message, oldest first]
const seenIds = new Set();    // `${chatId}|${id}`
const queue = [];             // incoming messages waiting for messageListener
let groupsCache = { data: null, at: 0 };
let dirty = false;
let saveTimer = null;

const setState = (patch) => { Object.assign(state, patch, { updatedAt: Date.now() }); };
const log = (...a) => console.log('[baileys]', ...a);

// ---------- id helpers ----------
const toChatId = (jid) => (jid || '').replace(/@s\.whatsapp\.net$/, '@c.us');
const toJid = (id) => (id || '').replace(/@c\.us$/, '@s.whatsapp.net');
const isGroupId = (id) => (id || '').endsWith('@g.us');
const phoneOf = (id) => (id || '').split('@')[0].split(':')[0];

async function loadLibs() {
  if (B) return;
  try {
    B = await import('@whiskeysockets/baileys');
  } catch (e) {
    throw new Error('חבילת Baileys לא מותקנת. הרץ "npm install" בתיקיית backend (או "סנכרן גרסה" בהגדרות) ואז הפעל מחדש.');
  }
  try { pinoLib = (await import('pino')).default; } catch { pinoLib = null; }
  try { QR = (await import('qrcode')).default; } catch { QR = null; }
}

// ---------- store (messages + contacts), persisted to disk ----------
function loadStore() {
  try {
    const j = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
    for (const [chatId, arr] of Object.entries(j.messages || {})) {
      messages.set(chatId, arr);
      for (const m of arr) seenIds.add(`${chatId}|${m.id}`);
    }
    for (const [jid, c] of Object.entries(j.contacts || {})) contacts.set(jid, c);
    log(`store loaded: ${messages.size} chats, ${contacts.size} contacts`);
  } catch { /* first run */ }
}

function markDirty() {
  dirty = true;
  if (saveTimer) return;
  saveTimer = setTimeout(() => { saveTimer = null; saveStore(); }, 15000);
}

function prune() {
  const cutoff = Math.floor(Date.now() / 1000) - MAX_AGE_DAYS * 86400;
  const rawCutoff = Math.floor(Date.now() / 1000) - RAW_KEEP_DAYS * 86400;
  for (const [chatId, arr] of messages) {
    let kept = arr.filter(m => m.ts >= cutoff);
    if (kept.length > MAX_PER_CHAT) kept = kept.slice(-MAX_PER_CHAT);
    for (const m of kept) if (m.raw && m.ts < rawCutoff) delete m.raw;
    if (kept.length === 0) messages.delete(chatId); else messages.set(chatId, kept);
  }
}

function saveStore() {
  if (!dirty) return;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    prune();
    const out = { version: 1, messages: Object.fromEntries(messages), contacts: Object.fromEntries(contacts) };
    const tmp = STORE_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(out));
    fs.renameSync(tmp, STORE_FILE);
    dirty = false;
  } catch (e) { log('store save failed:', e.message); }
}
process.on('exit', () => { try { saveStore(); } catch {} });

// ---------- message normalization ----------
function extract(content) {
  if (!content) return null;
  const t = B.getContentType(content);
  if (!t || ['protocolMessage', 'reactionMessage', 'senderKeyDistributionMessage', 'messageContextInfo', 'editedMessage'].includes(t)) return null;
  const c = content[t];
  switch (t) {
    case 'conversation': return { type: 'text', text: content.conversation || '' };
    case 'extendedTextMessage': return { type: 'text', text: c?.text || '' };
    case 'imageMessage': return { type: 'image', text: c?.caption || '[Image]', media: true };
    case 'videoMessage': return { type: 'video', text: c?.caption || '[Video]', media: true };
    case 'audioMessage': return { type: 'audio', text: '[Voice Message]', media: true };
    case 'documentMessage': return { type: 'document', text: c?.caption || `[Document: ${c?.fileName || ''}]`, media: true };
    case 'locationMessage': return { type: 'other', text: '[Location]' };
    case 'contactMessage': case 'contactsArrayMessage': return { type: 'other', text: '[Contact]' };
    case 'pollCreationMessage': case 'pollCreationMessageV2': case 'pollCreationMessageV3':
      return { type: 'other', text: `[Poll] ${c?.name || ''}` };
    case 'stickerMessage': return null;
    default: return { type: 'other', text: `[Message: ${t}]` };
  }
}

const tsOf = (m) => {
  const t = m.messageTimestamp;
  if (t == null) return Math.floor(Date.now() / 1000);
  return typeof t === 'number' ? t : Number(t.toString());
};

function nameOfJid(jid) {
  const c = contacts.get(jid);
  return (c && (c.name || c.notify)) || '';
}

function toStored(wam) {
  if (!wam || !wam.key || !wam.message) return null;
  const key = wam.key;
  let chatJid = key.remoteJid;
  if (!chatJid || chatJid === 'status@broadcast' || chatJid.endsWith('@broadcast') || chatJid.endsWith('@newsletter')) return null;
  if (chatJid.endsWith('@lid') && key.remoteJidAlt) chatJid = key.remoteJidAlt;
  const content = B.normalizeMessageContent(wam.message);
  const ex = extract(content);
  if (!ex) return null;
  const chatId = toChatId(chatJid);
  const isGroup = isGroupId(chatId);
  let senderJid = key.fromMe ? 'me' : (isGroup ? (key.participantAlt || key.participant || '') : chatJid);
  const senderName = key.fromMe ? 'אני' : (wam.pushName || nameOfJid(senderJid) || phoneOf(senderJid) || 'לא ידוע');
  const stored = {
    id: key.id,
    chatId,
    fromMe: !!key.fromMe,
    senderId: key.fromMe ? 'me' : toChatId(senderJid),
    senderName,
    type: ex.type,
    text: ex.text,
    ts: tsOf(wam),
  };
  if (ex.media) {
    try { stored.raw = JSON.stringify(wam, B.BufferJSON.replacer); } catch { /* ignore */ }
  }
  return stored;
}

function addMessage(stored) {
  const key = `${stored.chatId}|${stored.id}`;
  if (seenIds.has(key)) return false;
  seenIds.add(key);
  let arr = messages.get(stored.chatId);
  if (!arr) { arr = []; messages.set(stored.chatId, arr); }
  // keep chronological order cheaply: append, then bubble if out of order
  arr.push(stored);
  for (let i = arr.length - 1; i > 0 && arr[i].ts < arr[i - 1].ts; i--) [arr[i], arr[i - 1]] = [arr[i - 1], arr[i]];
  if (arr.length > MAX_PER_CHAT * 2) arr.splice(0, arr.length - MAX_PER_CHAT);
  markDirty();
  return true;
}

function upsertContact(c) {
  if (!c || !c.id) return;
  const prev = contacts.get(c.id) || { id: c.id };
  contacts.set(c.id, {
    id: c.id,
    name: c.name || prev.name || '',
    notify: c.notify || c.verifiedName || prev.notify || '',
  });
  markDirty();
}

// ---------- connection lifecycle ----------
function scheduleReconnect(delayMs) {
  if (stopped || reconnectTimer) return;
  reconnectTimer = setTimeout(() => { reconnectTimer = null; start().catch(e => log('restart failed:', e.message)); }, delayMs);
}

export async function start() {
  if (starting || (sock && state.status === 'open')) return getStatus();
  starting = true;
  stopped = false;
  try {
    await loadLibs();
    if (messages.size === 0 && contacts.size === 0) loadStore();
    fs.mkdirSync(AUTH_DIR, { recursive: true });
    const { state: auth, saveCreds } = await B.useMultiFileAuthState(AUTH_DIR);
    let version;
    try { ({ version } = await B.fetchLatestBaileysVersion()); } catch { /* use the library default */ }
    const makeWASocket = B.default || B.makeWASocket;
    setState({ status: 'starting', lastError: null });
    const s = makeWASocket({
      version,
      auth: auth,
      logger: pinoLib ? pinoLib({ level: 'silent' }) : undefined,
      browser: ['S-On', 'Chrome', '1.0'],
      syncFullHistory: false,
      markOnlineOnConnect: false,
    });
    sock = s;
    s.ev.on('creds.update', saveCreds);

    s.ev.on('connection.update', async (u) => {
      if (s !== sock) return; // stale socket
      const { connection, lastDisconnect, qr } = u;
      if (qr) {
        let dataUrl = null;
        if (QR) { try { dataUrl = await QR.toDataURL(qr, { margin: 1, width: 280 }); } catch {} }
        setState({ status: 'qr', qr, qrDataUrl: dataUrl });
      }
      if (connection === 'open') {
        reconnectAttempts = 0;
        setState({ status: 'open', qr: null, qrDataUrl: null, user: s.user ? { id: s.user.id, name: s.user.name || '' } : null, lastError: null });
        log('connected as', s.user && s.user.id);
        groupsCache = { data: null, at: 0 };
      }
      if (connection === 'close') {
        const code = lastDisconnect && lastDisconnect.error && lastDisconnect.error.output && lastDisconnect.error.output.statusCode;
        log('connection closed, code=', code);
        sock = null;
        if (code === B.DisconnectReason.loggedOut) {
          setState({ status: 'loggedOut', user: null, qr: null, qrDataUrl: null, lastError: 'התנתקת מהוואטסאפ (נמחק מהמכשירים המקושרים). צריך לסרוק QR מחדש.' });
          return;
        }
        if (code === B.DisconnectReason.connectionReplaced) {
          setState({ status: 'replaced', lastError: 'החיבור הוחלף על ידי תהליך אחר שמשתמש באותו חיבור.' });
          return;
        }
        setState({ status: 'reconnecting', lastError: `החיבור נותק (קוד ${code || '?'})` });
        reconnectAttempts++;
        const delay = code === B.DisconnectReason.restartRequired ? 500 : Math.min(30000, 2000 * reconnectAttempts);
        scheduleReconnect(delay);
      }
    });

    s.ev.on('messaging-history.set', ({ contacts: cs, messages: ms }) => {
      for (const c of cs || []) upsertContact(c);
      let n = 0;
      for (const wam of ms || []) { const st = toStored(wam); if (st && addMessage(st)) n++; }
      if (n) log(`history: +${n} messages`);
    });
    s.ev.on('contacts.upsert', (cs) => { for (const c of cs || []) upsertContact(c); });
    s.ev.on('contacts.update', (cs) => { for (const c of cs || []) upsertContact(c); });
    s.ev.on('groups.upsert', () => { groupsCache = { data: null, at: 0 }; });
    s.ev.on('groups.update', () => { groupsCache = { data: null, at: 0 }; });

    s.ev.on('messages.upsert', ({ messages: ms, type }) => {
      for (const wam of ms || []) {
        const st = toStored(wam);
        if (!st) continue;
        const isNew = addMessage(st);
        if (isNew && !st.fromMe && type === 'notify') state.lastIncomingAt = Date.now();
        if (!isNew || st.fromMe || !st.text) continue;
        if (type !== 'notify' && type !== 'append') continue;
        if (Math.floor(Date.now() / 1000) - st.ts > QUEUE_MAX_AGE_SEC) continue;
        queue.push({
          __baileys: true,
          receiptId: `${st.chatId}|${st.id}`,
          parsed: {
            chatId: st.chatId,
            isGroup: isGroupId(st.chatId),
            senderName: st.senderName,
            senderPhone: phoneOf(st.senderId),
            text: st.text,
            timestamp: st.ts,
          },
        });
        if (queue.length > 500) queue.splice(0, queue.length - 500);
      }
    });
  } catch (e) {
    setState({ status: 'error', lastError: e.message });
    throw e;
  } finally {
    starting = false;
  }
  return getStatus();
}

export function getStatus() {
  return {
    status: state.status,
    connected: state.status === 'open',
    user: state.user,
    qrDataUrl: state.status === 'qr' ? state.qrDataUrl : null,
    hasQr: state.status === 'qr',
    error: state.lastError,
    store: { chats: messages.size, contacts: contacts.size },
    lastIncomingAt: state.lastIncomingAt || null,
    lastSend: state.lastSend,
    lastRead: state.lastRead,
    updatedAt: state.updatedAt,
  };
}

/** Wipes the saved login and starts over, which shows a new QR code. */
export async function logout() {
  stopped = true;
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  try { if (sock) await sock.logout(); } catch { /* may already be logged out */ }
  try { if (sock) sock.end(undefined); } catch {}
  sock = null;
  try { fs.rmSync(AUTH_DIR, { recursive: true, force: true }); } catch {}
  setState({ status: 'idle', user: null, qr: null, qrDataUrl: null, lastError: null });
  return start();
}

/** Closes and reopens the connection (keeps the saved login). */
export async function restart() {
  stopped = true;
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  try { if (sock) sock.end(undefined); } catch {}
  sock = null;
  setState({ status: 'idle' });
  return start();
}

async function ensureReady(timeoutMs = 20000) {
  if (sock && state.status === 'open') return sock;
  if (state.status === 'loggedOut' || state.status === 'replaced') throw new Error(state.lastError || 'וואטסאפ לא מחובר');
  if (!sock && !starting) { await start(); }
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (sock && state.status === 'open') return sock;
    if (state.status === 'qr') throw new Error('וואטסאפ מחכה לסריקת QR (הגדרות ← חיבור וואטסאפ)');
    await new Promise(r => setTimeout(r, 500));
  }
  throw new Error('וואטסאפ לא מחובר כרגע (Baileys). נסה שוב בעוד רגע.');
}

// ---------- public surface ----------
export async function checkInstanceStatus() {
  if (!sock && !starting && state.status === 'idle') { try { await start(); } catch {} }
  const map = { open: 'authorized', qr: 'notAuthorized', loggedOut: 'notAuthorized', starting: 'starting', reconnecting: 'starting', replaced: 'blocked', error: 'blocked', idle: 'starting' };
  return { stateInstance: map[state.status] || 'starting', raw: getStatus() };
}


async function loadGroups(force = false) {
  if (!force && groupsCache.data && Date.now() - groupsCache.at < 5 * 60 * 1000) return groupsCache.data;
  const s = await ensureReady();
  const g = await s.groupFetchAllParticipating();
  const list = Object.values(g).map(x => ({ id: x.id, name: x.subject || '' }));
  groupsCache = { data: list, at: Date.now() };
  return list;
}

async function _fetchChats() {
  const groups = await loadGroups(true);
  return groups.map(g => ({ chat_id: g.id, name: g.name || g.id, type: 'general' }));
}

export async function fetchAllChatsRaw() {
  const groups = await loadGroups().catch(() => []);
  const out = groups.map(g => ({ chat_id: g.id, name: g.name || g.id, isGroup: true }));
  for (const chatId of messages.keys()) {
    if (isGroupId(chatId)) continue;
    out.push({ chat_id: chatId, name: nameOfJid(toJid(chatId)) || chatId, isGroup: false });
  }
  return out;
}

export async function fetchLastIncomingMessages(minutes = 10080) {
  const cutoff = Math.floor(Date.now() / 1000) - minutes * 60;
  const out = [];
  for (const [chatId, arr] of messages) {
    for (const m of arr) {
      if (m.fromMe || !m.text || m.ts < cutoff) continue;
      out.push({ chatId, isGroup: isGroupId(chatId), senderName: m.senderName, text: m.text, timestamp: m.ts });
    }
  }
  return out;
}

export async function fetchChatHistory(chatId, count = 100) {
  const arr = messages.get(chatId) || [];
  return arr.slice(-count).map(m => ({
    message_id: m.id,
    chat_id: chatId,
    sender_id: m.senderId,
    sender_name: m.senderName,
    type: m.type === 'video' || m.type === 'other' ? 'text' : m.type,
    body: m.text,
    timestamp: m.ts,
    file_url: m.raw && ['audio', 'image', 'document'].includes(m.type) ? `baileys-media://${encodeURIComponent(chatId)}/${encodeURIComponent(m.id)}` : null,
  }));
}

async function _downloadMediaAsBase64(url) {
  const m = /^baileys-media:\/\/([^/]+)\/(.+)$/.exec(url || '');
  if (!m) throw new Error('כתובת מדיה לא תקינה');
  const chatId = decodeURIComponent(m[1]);
  const id = decodeURIComponent(m[2]);
  const stored = (messages.get(chatId) || []).find(x => x.id === id);
  if (!stored || !stored.raw) throw new Error('הקובץ כבר לא זמין (המדיה נשמרת כ-3 שבועות)');
  const s = await ensureReady();
  const wam = JSON.parse(stored.raw, B.BufferJSON.reviver);
  const buf = await B.downloadMediaMessage(wam, 'buffer', {}, {
    logger: pinoLib ? pinoLib({ level: 'silent' }) : undefined,
    reuploadRequest: s.updateMediaMessage,
  });
  return Buffer.from(buf).toString('base64');
}

async function _sendWhatsAppMessage(chatId, message) {
  const s = await ensureReady();
  const res = await s.sendMessage(toJid(chatId), { text: message });
  return { idMessage: res && res.key && res.key.id };
}

const MIME = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp',
  mp4: 'video/mp4', mov: 'video/quicktime', mp3: 'audio/mpeg', m4a: 'audio/mp4', ogg: 'audio/ogg', wav: 'audio/wav',
  pdf: 'application/pdf', doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  txt: 'text/plain', csv: 'text/csv', zip: 'application/zip',
};
const mimeOf = (name) => MIME[(name || '').split('.').pop().toLowerCase()] || 'application/octet-stream';

async function mediaSource(url) {
  if ((url || '').startsWith('local-upload:')) {
    const file = path.join(UPLOAD_DIR, path.basename(url.slice('local-upload:'.length)));
    return fs.readFileSync(file);
  }
  const res = await axios.get(url, { responseType: 'arraybuffer', timeout: 60000 });
  return Buffer.from(res.data);
}

async function _sendFile(chatId, { url, filename, caption = '' }) {
  const s = await ensureReady();
  const buffer = await mediaSource(url);
  const fname = filename || path.basename(url || 'file');
  const mimetype = mimeOf(fname);
  let content;
  if (mimetype.startsWith('image/')) content = { image: buffer, caption: caption || undefined, mimetype };
  else if (mimetype.startsWith('video/')) content = { video: buffer, caption: caption || undefined, mimetype };
  else if (mimetype.startsWith('audio/')) content = { audio: buffer, mimetype };
  else content = { document: buffer, fileName: fname, mimetype, caption: caption || undefined };
  const res = await s.sendMessage(toJid(chatId), content);
  if (content.audio && caption) await s.sendMessage(toJid(chatId), { text: caption });
  return { idMessage: res && res.key && res.key.id };
}

async function _sendLocation(chatId, { lat, lng, name = '', address = '' }) {
  const s = await ensureReady();
  const res = await s.sendMessage(toJid(chatId), { location: { degreesLatitude: Number(lat), degreesLongitude: Number(lng), name, address } });
  return { idMessage: res && res.key && res.key.id };
}

async function _sendContact(chatId, { phone, firstName, lastName = '' }) {
  const s = await ensureReady();
  const digits = String(phone || '').replace(/\D/g, '');
  const full = `${firstName || ''} ${lastName || ''}`.trim();
  const vcard = ['BEGIN:VCARD', 'VERSION:3.0', `FN:${full}`, `TEL;type=CELL;type=VOICE;waid=${digits}:+${digits}`, 'END:VCARD'].join('\n');
  const res = await s.sendMessage(toJid(chatId), { contacts: { displayName: full, contacts: [{ vcard }] } });
  return { idMessage: res && res.key && res.key.id };
}

async function _sendPoll(chatId, { question, options, multipleAnswers = false }) {
  const s = await ensureReady();
  const values = (options || []).filter(Boolean);
  const res = await s.sendMessage(toJid(chatId), { poll: { name: question, values, selectableCount: multipleAnswers ? values.length : 1 } });
  return { idMessage: res && res.key && res.key.id };
}

export async function checkPhone(phone) {
  const s = await ensureReady();
  const digits = String(phone || '').replace(/\D/g, '');
  const r = await s.onWhatsApp(digits);
  return { existsWhatsapp: !!(r && r[0] && r[0].exists) };
}

export async function getContacts() {
  const out = [];
  for (const c of contacts.values()) {
    if (c.id.endsWith('@g.us')) continue;
    out.push({ id: toChatId(c.id), type: 'user', name: c.name || c.notify || '', contactName: c.name || '' });
  }
  const groups = await loadGroups().catch(() => []);
  for (const g of groups) out.push({ id: g.id, type: 'group', name: g.name, contactName: g.name });
  return out;
}

export async function getIndividualContacts() {
  const out = [];
  for (const c of contacts.values()) {
    if (!c.id.endsWith('@s.whatsapp.net')) continue;
    out.push({ chat_id: toChatId(c.id), name: (c.name || c.notify || toChatId(c.id)).trim(), isSaved: !!(c.name && c.name.trim()) });
  }
  return out;
}

// ---------- incoming notifications (in-memory queue read by messageListener) ----------
export async function receiveNotification() { return queue.shift() || null; }

// ---------- health tracking (feeds the in-app status banner) ----------
const trackSend = (fn) => async (...args) => {
  try { const r = await fn(...args); state.lastSend = { ok: true, at: Date.now() }; return r; }
  catch (e) { state.lastSend = { ok: false, at: Date.now(), error: e.message }; throw e; }
};
const trackRead = (fn) => async (...args) => {
  try { const r = await fn(...args); state.lastRead = { ok: true, at: Date.now() }; return r; }
  catch (e) { state.lastRead = { ok: false, at: Date.now(), error: e.message }; throw e; }
};
export const sendWhatsAppMessage = trackSend(_sendWhatsAppMessage);
export const sendFile = trackSend(_sendFile);
export const sendLocation = trackSend(_sendLocation);
export const sendContact = trackSend(_sendContact);
export const sendPoll = trackSend(_sendPoll);
export const fetchChats = trackRead(_fetchChats);
export const downloadMediaAsBase64 = trackRead(_downloadMediaAsBase64);
