import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.join(__dirname, 'data');

async function ensureDataDir() {
  await fs.mkdir(DATA_DIR, { recursive: true });
}

async function readJson(filename, defaultValue = []) {
  await ensureDataDir();
  try {
    const data = await fs.readFile(path.join(DATA_DIR, filename), 'utf8');
    return JSON.parse(data);
  } catch (err) {
    return defaultValue;
  }
}

// Per-file write queues: concurrent writes to the same file are serialized,
// and each write goes to a temp file first, then renamed into place — so a
// crash mid-write can never corrupt the real data file.
const writeQueues = new Map();

async function writeJson(filename, data) {
  const prev = writeQueues.get(filename) || Promise.resolve();
  const next = prev.catch(() => {}).then(async () => {
    await ensureDataDir();
    const finalPath = path.join(DATA_DIR, filename);
    const tmpPath = `${finalPath}.tmp`;
    await fs.writeFile(tmpPath, JSON.stringify(data, null, 2), 'utf8');
    await fs.rename(tmpPath, finalPath);
  });
  writeQueues.set(filename, next);
  return next;
}

function nextId(rows) {
  return rows.length > 0 ? Math.max(...rows.map(r => r.id)) + 1 : 1;
}

// Word-overlap similarity, used to dedupe near-identical tasks/FAQs that
// come from overlapping scan windows (e.g. the same request phrased
// slightly differently by the live listener vs. a later history scan).
function normalizeWords(text) {
  return (text || '').toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean);
}
function wordOverlapRatio(a, b) {
  const wa = new Set(normalizeWords(a));
  const wb = new Set(normalizeWords(b));
  if (wa.size === 0 || wb.size === 0) return 0;
  let common = 0;
  for (const w of wa) if (wb.has(w)) common++;
  return common / Math.min(wa.size, wb.size);
}
const DUPLICATE_THRESHOLD = 0.35;

// ---------- Settings ----------
export async function getSettings() {
  return readJson('settings.json', {});
}
export async function saveSettings(patch) {
  const current = await getSettings();
  const updated = { ...current, ...patch };
  await writeJson('settings.json', updated);
  return updated;
}

// ---------- Chats ----------
export async function getChats() {
  return readJson('chats.json', []);
}
export async function saveChats(chats) {
  const existing = await getChats();
  const byId = new Map(existing.map(c => [c.chat_id, c]));
  for (const c of chats) {
    const prev = byId.get(c.chat_id);
    byId.set(c.chat_id, {
      chat_id: c.chat_id,
      name: c.name,
      type: c.type,
      is_tracked: prev?.is_tracked ?? false,
      include_in_digest: prev?.include_in_digest ?? false,
      profile_type: prev?.profile_type ?? 'general',
      last_summary_at: prev?.last_summary_at ?? null
    });
  }
  const merged = Array.from(byId.values());
  await writeJson('chats.json', merged);
  return merged;
}
export async function updateChat(chatId, patch) {
  const chats = await getChats();
  const idx = chats.findIndex(c => c.chat_id === chatId);
  if (idx === -1) throw new Error('Chat not found');
  chats[idx] = { ...chats[idx], ...patch };
  await writeJson('chats.json', chats);
  return chats[idx];
}
export async function getTrackedChats() {
  const chats = await getChats();
  return chats.filter(c => c.is_tracked);
}

// ---------- Messages (short-lived buffer used for summarization) ----------
export async function saveMessages(chatId, messages) {
  const all = await readJson('messages.json', []);
  const existingIds = new Set(all.filter(m => m.chat_id === chatId).map(m => m.message_id));
  const fresh = messages.filter(m => !existingIds.has(m.message_id));
  const merged = [...all, ...fresh];
  await writeJson('messages.json', merged);
  return fresh.length;
}
export async function getMessagesForChat(chatId) {
  const all = await readJson('messages.json', []);
  return all.filter(m => m.chat_id === chatId).sort((a, b) => a.timestamp - b.timestamp);
}
export async function clearMessagesForChat(chatId) {
  const all = await readJson('messages.json', []);
  const kept = all.filter(m => m.chat_id !== chatId);
  await writeJson('messages.json', kept);
}

// ---------- Summaries ----------
export async function insertSummary(chatId, content) {
  const summaries = await readJson('summaries.json', []);
  const entry = {
    id: nextId(summaries),
    chat_id: chatId,
    content,
    is_sent: false,
    created_at: new Date().toISOString()
  };
  summaries.push(entry);
  await writeJson('summaries.json', summaries);
  return entry;
}
export async function markSummarySent(id) {
  const summaries = await readJson('summaries.json', []);
  const idx = summaries.findIndex(s => s.id === id);
  if (idx === -1) throw new Error('Summary not found');
  summaries[idx].is_sent = true;
  await writeJson('summaries.json', summaries);
  return summaries[idx];
}
export async function getSummariesForChat(chatId, limit = 30) {
  const all = await readJson('summaries.json', []);
  return all.filter(s => s.chat_id === chatId).sort((a, b) => new Date(b.created_at) - new Date(a.created_at)).slice(0, limit);
}
export async function getLatestSummaries() {
  const all = await readJson('summaries.json', []);
  const byChat = new Map();
  for (const s of all) {
    const prev = byChat.get(s.chat_id);
    if (!prev || new Date(s.created_at) > new Date(prev.created_at)) byChat.set(s.chat_id, s);
  }
  return Array.from(byChat.values());
}

// ---------- Action items ----------
// Dedupes against ALL existing items for the same chat (open or completed) —
// overlapping scan windows (live listener + history scan, or two history
// scans) commonly rediscover the same request worded slightly differently.
export async function insertActionItems(chatId, items) {
  const all = await readJson('action_items.json', []);
  const existingForChat = all.filter(a => a.chat_id === chatId);
  const fresh = items.filter(it =>
    !existingForChat.some(ex => wordOverlapRatio(ex.task, it.task) >= DUPLICATE_THRESHOLD)
  );
  if (fresh.length === 0) return [];

  let id = nextId(all);
  const created = fresh.map(it => ({
    id: id++,
    chat_id: chatId,
    task: it.task,
    assignee: it.assignee || '',
    category: it.category || null,
    deadline: it.deadline || null,
    completed: false,
    saved_for_later: false,
    snoozed_until: null,
    // The date the WhatsApp message was actually written, when the caller
    // knows it (Gemini extracts it from the transcript) — falls back to now
    // only when that's genuinely unavailable, so "נוצר" reflects reality
    // instead of whenever a scan happened to run.
    created_at: it.created_at || new Date().toISOString()
  }));
  const merged = [...all, ...created];
  await writeJson('action_items.json', merged);
  return created;
}
export async function getActionItems() {
  return readJson('action_items.json', []);
}
export async function setActionItemCompleted(id, completed) {
  const items = await getActionItems();
  const idx = items.findIndex(i => i.id === id);
  if (idx === -1) throw new Error('Action item not found');
  items[idx].completed = completed;
  await writeJson('action_items.json', items);
  return items[idx];
}
export async function setActionItemSavedForLater(id, saved, snoozedUntil = null) {
  const items = await getActionItems();
  const idx = items.findIndex(i => i.id === id);
  if (idx === -1) throw new Error('Action item not found');
  items[idx].saved_for_later = saved;
  items[idx].snoozed_until = saved ? snoozedUntil : null;
  await writeJson('action_items.json', items);
  return items[idx];
}

// ---------- Scheduled messages ----------
export async function getScheduledMessages() {
  return readJson('scheduled_messages.json', []);
}
export async function saveScheduledMessage(msg) {
  const all = await getScheduledMessages();
  const entry = {
    id: nextId(all),
    chat_id: msg.chat_id,
    display_name: msg.display_name || null,
    type: msg.type || 'text', // text | media | location | poll | contact
    content: msg.content || null,           // text body / media caption / poll question
    media_url: msg.media_url || null,
    media_filename: msg.media_filename || null,
    location: msg.location || null,         // { lat, lng, name, address }
    poll_options: msg.poll_options || null, // string[]
    poll_multiple: !!msg.poll_multiple,
    contact: msg.contact || null,           // { phone, firstName, lastName }
    scheduled_at: msg.scheduled_at,
    repeat: msg.repeat || null,
    status: 'pending',
    attempts: 0,
    max_attempts: 3,
    retry_after: null,
    created_at: new Date().toISOString()
  };
  all.push(entry);
  await writeJson('scheduled_messages.json', all);
  return entry;
}
export async function updateScheduledMessage(id, patch) {
  const all = await getScheduledMessages();
  const idx = all.findIndex(m => m.id === id);
  if (idx === -1) throw new Error('Scheduled message not found');
  all[idx] = { ...all[idx], ...patch };
  await writeJson('scheduled_messages.json', all);
  return all[idx];
}
export async function deleteScheduledMessage(id) {
  const all = await getScheduledMessages();
  const kept = all.filter(m => m.id !== id);
  await writeJson('scheduled_messages.json', kept);
}

// ---------- Auto-reply: contacts allow-list ----------
export async function getContacts() {
  return readJson('contacts.json', []);
}
export async function saveContact(contact) {
  const all = await getContacts();
  const entry = { id: nextId(all), name: contact.name, phone: contact.phone, chat_id: contact.chat_id };
  all.push(entry);
  await writeJson('contacts.json', all);
  return entry;
}
export async function deleteContact(id) {
  const all = await getContacts();
  await writeJson('contacts.json', all.filter(c => c.id !== id));
}

// ---------- Auto-reply: FAQ ----------
export async function getFaqs() {
  return readJson('faq.json', []);
}
export async function saveFaq(faq) {
  const all = await getFaqs();
  const entry = { id: nextId(all), question: faq.question, answer: faq.answer };
  all.push(entry);
  await writeJson('faq.json', all);
  return entry;
}
// Bulk insert with dedup against existing FAQs — used by the history scan's
// recurring-motif analysis, which can suggest the same theme repeatedly
// across chats/runs. Manual single-add (saveFaq) stays dedup-free since
// that's a deliberate user action.
export async function insertFaqSuggestions(suggestions) {
  const all = await getFaqs();
  const fresh = suggestions.filter(s =>
    !all.some(ex => wordOverlapRatio(ex.question, s.question) >= DUPLICATE_THRESHOLD)
  );
  if (fresh.length === 0) return [];
  let id = nextId(all);
  const created = fresh.map(s => ({ id: id++, question: s.question, answer: s.answer, category: s.category || null, count: s.count || null }));
  await writeJson('faq.json', [...all, ...created]);
  return created;
}

export async function updateFaq(id, patch) {
  const all = await getFaqs();
  const idx = all.findIndex(f => f.id === id);
  if (idx === -1) throw new Error('FAQ not found');
  all[idx] = { ...all[idx], ...patch };
  await writeJson('faq.json', all);
  return all[idx];
}
export async function deleteFaq(id) {
  const all = await getFaqs();
  await writeJson('faq.json', all.filter(f => f.id !== id));
}

// ---------- Auto-reply: approval queue ----------
export async function addToApprovalQueue(entry) {
  const all = await readJson('approval_queue.json', []);
  const item = {
    id: nextId(all),
    chat_id: entry.chat_id,
    sender_name: entry.sender_name,
    incoming_message: entry.incoming_message,
    draft_reply: entry.draft_reply,
    match_reason: entry.match_reason,
    status: 'pending',
    created_at: new Date().toISOString()
  };
  all.push(item);
  await writeJson('approval_queue.json', all);
  return item;
}
export async function getApprovalQueue() {
  return readJson('approval_queue.json', []);
}
export async function updateApprovalQueueItem(id, patch) {
  const all = await getApprovalQueue();
  const idx = all.findIndex(i => i.id === id);
  if (idx === -1) throw new Error('Queue item not found');
  all[idx] = { ...all[idx], ...patch };
  await writeJson('approval_queue.json', all);
  return all[idx];
}

// ---------- Auto-reply: last-seen message pointer (polling bookmark) ----------
export async function getAutoReplyState() {
  return readJson('auto_reply_state.json', { last_receipt_id: 0 });
}
export async function saveAutoReplyState(state) {
  await writeJson('auto_reply_state.json', state);
}

// ---------- Sync log ----------
export async function logSyncRun(entry) {
  const all = await readJson('sync_log.json', []);
  const item = { id: nextId(all), ...entry, at: new Date().toISOString() };
  all.push(item);
  await writeJson('sync_log.json', all.slice(-20));
  return item;
}
export async function getSyncLog() {
  return readJson('sync_log.json', []);
}

// ---------- Morning briefing helper ----------
export async function getMorningBriefingData() {
  const [actionItems, scheduled] = await Promise.all([getActionItems(), getScheduledMessages()]);
  const now = new Date();
  const soon = new Date(now.getTime() + 48 * 60 * 60 * 1000);
  const upcoming = actionItems.filter(i => !i.completed && i.deadline && new Date(i.deadline) <= soon);
  const overdue = actionItems.filter(i => !i.completed && i.deadline && new Date(i.deadline) < now);
  // "נודניק" nudge: snoozed ("שמור להמשך") tasks whose snooze just expired
  // resurface here instead of silently staying hidden forever.
  const resurfaced = actionItems.filter(i => !i.completed && i.saved_for_later && i.snoozed_until && new Date(i.snoozed_until) <= now);
  return { upcoming, overdue, resurfaced, pendingScheduled: scheduled.filter(s => s.status === 'pending').length };
}
