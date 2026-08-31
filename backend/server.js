import express from 'express';
import cors from 'cors';
import cron from 'node-cron';

import * as db from './database.js';
import * as greenApi from './greenApi.js';
import * as gemini from './gemini.js';
import * as scheduler from './scheduler.js';
import * as sync from './sync.js';
import { startMessageListener, drainQueueNow } from './messageListener.js';
import { startHistoryScan, getScanStatus } from './historyScan.js';
import * as workerProxy from './workerProxy.js';

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

const PORT = process.env.PORT || 5101;

function handleError(res, error) {
  console.error(error);
  res.status(500).json({ error: error.message || 'שגיאה לא צפויה' });
}

// ---------- Settings ----------
app.get('/api/settings', async (req, res) => {
  try {
    const settings = await db.getSettings();
    res.json(settings);
  } catch (error) { handleError(res, error); }
});

app.post('/api/settings', async (req, res) => {
  try {
    const patch = { ...req.body };
    // recipientChatId feeds every WhatsApp send (digest/briefing/manual) as
    // a chatId directly - normalize here so a bare phone number typed in
    // the UI doesn't silently fail every send.
    if (patch.recipientChatId) patch.recipientChatId = scheduler.normaliseChatId(patch.recipientChatId);
    const updated = await db.saveSettings(patch);
    res.json(updated);
  } catch (error) { handleError(res, error); }
});

app.get('/api/instance-status', async (req, res) => {
  try {
    const settings = await db.getSettings();
    if (!settings.apiUrl || !settings.idInstance || !settings.apiTokenInstance) {
      return res.json({ connected: false, reason: 'לא הוגדרו פרטי Green API' });
    }
    const status = await greenApi.checkInstanceStatus(settings.apiUrl, settings.idInstance, settings.apiTokenInstance);
    res.json({ connected: status?.stateInstance === 'authorized', raw: status });
  } catch (error) { handleError(res, error); }
});

// ---------- Chats ----------
app.get('/api/chats', async (req, res) => {
  try { res.json(await db.getChats()); } catch (error) { handleError(res, error); }
});

app.post('/api/chats/sync', async (req, res) => {
  try {
    const settings = await db.getSettings();
    const fetched = await greenApi.fetchChats(settings.apiUrl, settings.idInstance, settings.apiTokenInstance);
    const merged = await db.saveChats(fetched);
    res.json(merged);
  } catch (error) { handleError(res, error); }
});

// Real WhatsApp individuals (not the small manual auto-reply contacts list
// under /api/contacts) — used by the scheduled-message recipient search so
// it can find people, not just tracked groups. Cached in memory: this list
// rarely changes minute to minute, and fetching it fresh on every page load
// hit Green API's rate limit (429) since the recipient picker calls it on
// every visit to the scheduled-messages page.
let whatsappContactsCache = { data: null, fetchedAt: 0 };
const WHATSAPP_CONTACTS_TTL_MS = 15 * 60 * 1000;

async function refreshWhatsappContactsCache() {
  const settings = await db.getSettings();
  if (!settings.idInstance) return;
  // One retry on 429 — Green API's rate limit is often a few-second window,
  // so a short wait usually clears it instead of surfacing to the user.
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const contacts = await greenApi.getIndividualContacts(settings.apiUrl, settings.idInstance, settings.apiTokenInstance);
      whatsappContactsCache = { data: contacts, fetchedAt: Date.now() };
      return whatsappContactsCache.data;
    } catch (error) {
      if (attempt === 2 || !error.message.includes('429')) throw error;
      await new Promise(r => setTimeout(r, 5000));
    }
  }
}

app.get('/api/whatsapp-contacts', async (req, res) => {
  try {
    if (whatsappContactsCache.data && Date.now() - whatsappContactsCache.fetchedAt < WHATSAPP_CONTACTS_TTL_MS) {
      return res.json(whatsappContactsCache.data);
    }
    res.json(await refreshWhatsappContactsCache());
  } catch (error) {
    // Green API rate-limited or unreachable — serve the last known-good
    // list instead of breaking the recipient search, if we have one.
    if (whatsappContactsCache.data) return res.json(whatsappContactsCache.data);
    handleError(res, error);
  }
});

// Warms the cache right when the server starts, so the first real page
// visit doesn't race an empty cache against a still-cooling-down Green API.
refreshWhatsappContactsCache().catch(err => console.error('[startup] whatsapp-contacts warm-up failed:', err.message));

app.post('/api/chats/toggle', async (req, res) => {
  try {
    const { chat_id, is_tracked } = req.body;
    const chats = await db.getChats();
    const chat = chats.find(c => c.chat_id === chat_id);
    const prevValue = !!chat?.is_tracked;
    const updated = await db.updateChat(chat_id, { is_tracked });
    if (chat && prevValue !== !!is_tracked) {
      await db.addActivityLog({
        type: 'chat_tracked',
        description: `${is_tracked ? 'התחלת מעקב אחרי קבוצה' : 'הפסקת מעקב אחרי קבוצה'}: "${chat.name}"`,
        action: 'update', file: 'chats.json', id_field: 'chat_id', entity_id: chat_id,
        field: 'is_tracked', prev_value: prevValue, new_value: !!is_tracked
      });
    }
    res.json(updated);
  } catch (error) { handleError(res, error); }
});

app.post('/api/chats/toggle-digest', async (req, res) => {
  try {
    const { chat_id, include_in_digest } = req.body;
    const chats = await db.getChats();
    const chat = chats.find(c => c.chat_id === chat_id);
    const prevValue = !!chat?.include_in_digest;
    const updated = await db.updateChat(chat_id, { include_in_digest });
    if (chat && prevValue !== !!include_in_digest) {
      await db.addActivityLog({
        type: 'chat_digest',
        description: `${include_in_digest ? 'הפעלת' : 'כיבוי'} שליחת סיכום יומי לקבוצה: "${chat.name}"`,
        action: 'update', file: 'chats.json', id_field: 'chat_id', entity_id: chat_id,
        field: 'include_in_digest', prev_value: prevValue, new_value: !!include_in_digest
      });
    }
    res.json(updated);
  } catch (error) { handleError(res, error); }
});

app.post('/api/chats/category', async (req, res) => {
  try {
    const { chat_id, category } = req.body;
    const chats = await db.getChats();
    const chat = chats.find(c => c.chat_id === chat_id);
    const prevValue = chat?.profile_type || null;
    const updated = await db.updateChat(chat_id, { profile_type: category });
    if (chat && prevValue !== category) {
      await db.addActivityLog({
        type: 'chat_category',
        description: `שינוי סוג קבוצה: "${chat.name}" ל-${category}`,
        action: 'update', file: 'chats.json', id_field: 'chat_id', entity_id: chat_id,
        field: 'profile_type', prev_value: prevValue, new_value: category
      });
    }
    res.json(updated);
  } catch (error) { handleError(res, error); }
});

app.post('/api/chats/summarize', async (req, res) => {
  try {
    const { chat_id } = req.body;
    const settings = await db.getSettings();
    if (!settings.geminiApiKey) throw new Error('לא הוגדר מפתח Gemini בהגדרות');

    const chats = await db.getChats();
    const chat = chats.find(c => c.chat_id === chat_id);
    if (!chat) throw new Error('קבוצה לא נמצאה');

    const history = await greenApi.fetchChatHistory(settings.apiUrl, settings.idInstance, settings.apiTokenInstance, chat_id, 150);
    await db.saveMessages(chat_id, history);
    const allMessages = await db.getMessagesForChat(chat_id);
    if (allMessages.length === 0) throw new Error('אין הודעות לסיכום בקבוצה זו');

    const messagesText = allMessages.map(m => `[${new Date(m.timestamp * 1000).toLocaleDateString('he-IL')} ${m.sender_name}]: ${m.body}`).join('\n');
    const summaryData = await gemini.summarizeMessages(settings.geminiApiKey, messagesText, chat.name);
    const summary = await db.insertSummary(chat_id, summaryData);

    // "לידיעה" groups are informational by nature and rarely need action -
    // skip task extraction there instead of hoping the prompt guesses right.
    if (summaryData.actionItems?.length && chat.profile_type !== 'info') {
      const lastTimestamp = allMessages[allMessages.length - 1]?.timestamp;
      await db.insertActionItems(chat_id, summaryData.actionItems.map(it => {
        const sourceMessage = db.findSourceMessage(it.task, allMessages);
        const created_at = sourceMessage
          ? new Date(sourceMessage.timestamp * 1000).toISOString()
          : scheduler.resolveMessageCreatedAt(it.messageDate, lastTimestamp);
        return { ...it, created_at };
      }));
    }

    await db.updateChat(chat_id, { last_summary_at: new Date().toISOString() });
    await db.clearMessagesForChat(chat_id);

    if (chat.include_in_digest && settings.recipientChatId) {
      const text = gemini.formatSummaryForWhatsApp(chat.name, summaryData);
      await greenApi.sendWhatsAppMessage(settings.apiUrl, settings.idInstance, settings.apiTokenInstance, settings.recipientChatId, text);
    }

    res.json(summary);
  } catch (error) { handleError(res, error); }
});

app.get('/api/chats/:chatId/summaries', async (req, res) => {
  try { res.json(await db.getSummariesForChat(req.params.chatId)); } catch (error) { handleError(res, error); }
});

app.get('/api/summaries/latest', async (req, res) => {
  try { res.json(await db.getLatestSummaries()); } catch (error) { handleError(res, error); }
});

// Sends the already-computed latest summary as-is — unlike /chats/summarize,
// this never re-summarizes, so it's safe to click right after "סכם עכשיו".
app.post('/api/chats/send-digest', async (req, res) => {
  try {
    const { chat_id } = req.body;
    const settings = await db.getSettings();
    if (!settings.recipientChatId) throw new Error('לא הוגדר יעד לשליחת סיכומים בהגדרות');
    const chats = await db.getChats();
    const chat = chats.find(c => c.chat_id === chat_id);
    if (!chat) throw new Error('קבוצה לא נמצאה');
    const summaries = await db.getSummariesForChat(chat_id, 1);
    if (!summaries.length) throw new Error('אין עדיין סיכום לקבוצה זו');
    const summary = summaries[0];
    const text = gemini.formatSummaryForWhatsApp(chat.name, summary.content);
    await greenApi.sendWhatsAppMessage(settings.apiUrl, settings.idInstance, settings.apiTokenInstance, settings.recipientChatId, text);
    res.json(await db.markSummarySent(summary.id));
  } catch (error) { handleError(res, error); }
});

app.post('/api/ai/ask-about-chat', async (req, res) => {
  try {
    const { chat_id, question, chatHistory } = req.body;
    const settings = await db.getSettings();
    if (!settings.geminiApiKey) throw new Error('לא הוגדר מפתח Gemini בהגדרות');
    const chats = await db.getChats();
    const chat = chats.find(c => c.chat_id === chat_id);
    if (!chat) throw new Error('קבוצה לא נמצאה');
    const history = await greenApi.fetchChatHistory(settings.apiUrl, settings.idInstance, settings.apiTokenInstance, chat_id, 150);
    const transcript = history.map(m => `[${new Date(m.timestamp * 1000).toLocaleDateString('he-IL')}] ${m.sender_name}: ${m.body}`).join('\n');
    const answer = await gemini.askGeminiAboutChat(settings.geminiApiKey, chat.name, transcript, question, chatHistory || []);
    res.json({ answer });
  } catch (error) { handleError(res, error); }
});

// ---------- Action items ----------
app.get('/api/action-items', async (req, res) => {
  try { res.json(await db.getActionItems()); } catch (error) { handleError(res, error); }
});

app.post('/api/action-items/:id/toggle', async (req, res) => {
  try { res.json(await db.setActionItemCompleted(Number(req.params.id), req.body.completed)); } catch (error) { handleError(res, error); }
});

app.post('/api/action-items/:id/deadline', async (req, res) => {
  try { res.json(await db.setActionItemDeadline(Number(req.params.id), req.body.deadline)); } catch (error) { handleError(res, error); }
});

app.post('/api/action-items/:id/toggle-save', async (req, res) => {
  try {
    const { saved_for_later, snooze_days } = req.body;
    let snoozedUntil = null;
    if (saved_for_later && snooze_days) {
      const d = new Date();
      d.setDate(d.getDate() + Number(snooze_days));
      snoozedUntil = d.toISOString();
    }
    res.json(await db.setActionItemSavedForLater(Number(req.params.id), saved_for_later, snoozedUntil));
  } catch (error) { handleError(res, error); }
});

// ---------- Scheduled messages ----------
// Once a Cloudflare Worker is configured, scheduled messages live entirely
// in its KV store (so they keep sending while this computer is off) — the
// local JSON file is only the source of truth when no Worker is set up.
app.get('/api/scheduled-messages', async (req, res) => {
  try {
    const settings = await db.getSettings();
    if (workerProxy.isWorkerConfigured(settings)) return res.json(await workerProxy.getMessages(settings));
    res.json(await db.getScheduledMessages());
  } catch (error) { handleError(res, error); }
});

app.post('/api/scheduled-messages', async (req, res) => {
  try {
    const settings = await db.getSettings();
    const body = { ...req.body, chat_id: scheduler.normaliseChatId(req.body.chat_id) };
    if (workerProxy.isWorkerConfigured(settings)) return res.json(await workerProxy.createMessage(settings, body));
    res.json(await db.saveScheduledMessage(body));
  } catch (error) { handleError(res, error); }
});

app.put('/api/scheduled-messages/:id', async (req, res) => {
  try {
    const settings = await db.getSettings();
    if (workerProxy.isWorkerConfigured(settings)) return res.json(await workerProxy.updateMessage(settings, Number(req.params.id), req.body));
    const id = Number(req.params.id);
    // Undo support only exists for the local (non-Worker) store, since only
    // there can a previous value actually be read back and restored.
    const before = (await db.getScheduledMessages()).find(m => m.id === id);
    const updated = await db.updateScheduledMessage(id, req.body);
    if (before) {
      const keys = Object.keys(req.body);
      const prevValues = Object.fromEntries(keys.map(k => [k, before[k]]));
      const changed = keys.some(k => before[k] !== updated[k]);
      if (changed) {
        await db.addActivityLog({
          type: 'scheduled_message_edited',
          description: `עריכת הודעה מתוזמנת: "${(before.content || before.display_name || before.chat_id || '').toString().slice(0, 60)}"`,
          action: 'update_multi', file: 'scheduled_messages.json', entity_id: id, prev_values: prevValues
        });
      }
    }
    res.json(updated);
  } catch (error) { handleError(res, error); }
});

app.delete('/api/scheduled-messages/:id', async (req, res) => {
  try {
    const settings = await db.getSettings();
    if (workerProxy.isWorkerConfigured(settings)) { await workerProxy.deleteMessage(settings, Number(req.params.id)); return res.json({ ok: true }); }
    const id = Number(req.params.id);
    const record = (await db.getScheduledMessages()).find(m => m.id === id);
    await db.deleteScheduledMessage(id);
    if (record) {
      await db.addActivityLog({
        type: 'scheduled_message_deleted',
        description: `מחיקת הודעה מתוזמנת: "${(record.content || record.display_name || record.chat_id || '').toString().slice(0, 60)}"`,
        action: 'delete', file: 'scheduled_messages.json', entity_id: id, record
      });
    }
    res.json({ ok: true });
  } catch (error) { handleError(res, error); }
});

app.post('/api/worker/sync-config', async (req, res) => {
  try {
    const settings = await db.getSettings();
    if (!workerProxy.isWorkerConfigured(settings)) throw new Error('לא הוגדרו כתובת ה-Worker והטוקן בהגדרות');
    await workerProxy.pushConfig(settings);
    res.json({ ok: true });
  } catch (error) { handleError(res, error); }
});

app.get('/api/worker/status', async (req, res) => {
  try {
    const settings = await db.getSettings();
    if (!workerProxy.isWorkerConfigured(settings)) return res.json({ configured: false, connected: false });
    const status = await workerProxy.getWorkerStatus(settings);
    res.json({ configured: true, connected: true, greenApiConfigured: !!status.configured });
  } catch (error) {
    res.json({ configured: true, connected: false, error: error.message });
  }
});

app.post('/api/check-phone', async (req, res) => {
  try {
    const settings = await db.getSettings();
    res.json(await greenApi.checkPhone(settings.apiUrl, settings.idInstance, settings.apiTokenInstance, req.body.phone));
  } catch (error) { handleError(res, error); }
});

// ---------- Auto-reply: contacts, FAQ, approval queue ----------
app.get('/api/contacts', async (req, res) => {
  try { res.json(await db.getContacts()); } catch (error) { handleError(res, error); }
});

app.post('/api/contacts', async (req, res) => {
  try {
    const chat_id = scheduler.normaliseChatId(req.body.phone);
    res.json(await db.saveContact({ ...req.body, chat_id }));
  } catch (error) { handleError(res, error); }
});

app.delete('/api/contacts/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const record = (await db.getContacts()).find(c => c.id === id);
    await db.deleteContact(id);
    if (record) {
      await db.addActivityLog({
        type: 'contact_deleted',
        description: `הסרת איש קשר מאושר למענה אוטומטי: "${record.name}"`,
        action: 'delete', file: 'contacts.json', entity_id: id, record
      });
    }
    res.json({ ok: true });
  } catch (error) { handleError(res, error); }
});

app.get('/api/faq', async (req, res) => {
  try { res.json(await db.getFaqs()); } catch (error) { handleError(res, error); }
});

app.post('/api/faq', async (req, res) => {
  try { res.json(await db.saveFaq(req.body)); } catch (error) { handleError(res, error); }
});

app.put('/api/faq/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const before = (await db.getFaqs()).find(f => f.id === id);
    const updated = await db.updateFaq(id, req.body);
    if (before) {
      const keys = Object.keys(req.body);
      const prevValues = Object.fromEntries(keys.map(k => [k, before[k]]));
      if (keys.some(k => before[k] !== updated[k])) {
        await db.addActivityLog({
          type: 'faq_edited',
          description: `עריכת שאלה נפוצה: "${(before.question || '').slice(0, 60)}"`,
          action: 'update_multi', file: 'faq.json', entity_id: id, prev_values: prevValues
        });
      }
    }
    res.json(updated);
  } catch (error) { handleError(res, error); }
});

app.delete('/api/faq/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const record = (await db.getFaqs()).find(f => f.id === id);
    await db.deleteFaq(id);
    if (record) {
      await db.addActivityLog({
        type: 'faq_deleted',
        description: `מחיקת שאלה נפוצה: "${(record.question || '').slice(0, 60)}"`,
        action: 'delete', file: 'faq.json', entity_id: id, record
      });
    }
    res.json({ ok: true });
  } catch (error) { handleError(res, error); }
});

app.get('/api/approval-queue', async (req, res) => {
  try { res.json(await db.getApprovalQueue()); } catch (error) { handleError(res, error); }
});

app.post('/api/approval-queue/:id/approve', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const queue = await db.getApprovalQueue();
    const item = queue.find(q => q.id === id);
    if (!item) throw new Error('פריט לא נמצא בתור');
    const settings = await db.getSettings();
    const textToSend = req.body.editedText || item.draft_reply;
    await greenApi.sendWhatsAppMessage(settings.apiUrl, settings.idInstance, settings.apiTokenInstance, item.chat_id, textToSend);
    res.json(await db.updateApprovalQueueItem(id, { status: 'approved', sent_text: textToSend, resolved_at: new Date().toISOString() }));
  } catch (error) { handleError(res, error); }
});

app.post('/api/approval-queue/:id/reject', async (req, res) => {
  try {
    res.json(await db.updateApprovalQueueItem(Number(req.params.id), { status: 'rejected', resolved_at: new Date().toISOString() }));
  } catch (error) { handleError(res, error); }
});

// receiveNotification only ever returns anything if this instance setting is
// on — it's off by default on a fresh Green API instance, so both toggles
// below fix it up front instead of silently listening to an empty queue.
async function ensureListenerReady(settings) {
  if (!settings.apiUrl || !settings.idInstance || !settings.apiTokenInstance) return;
  await greenApi.ensureIncomingWebhookEnabled(settings.apiUrl, settings.idInstance, settings.apiTokenInstance);
}

app.post('/api/auto-reply/toggle', async (req, res) => {
  try {
    const enabled = !!req.body.enabled;
    const updated = await db.saveSettings({ autoReplyEnabled: enabled });
    if (enabled) await ensureListenerReady(updated);
    res.json(updated);
  } catch (error) { handleError(res, error); }
});

app.post('/api/live-insights/toggle', async (req, res) => {
  try {
    const enabled = !!req.body.enabled;
    const updated = await db.saveSettings({ liveInsightsEnabled: enabled });
    if (enabled) await ensureListenerReady(updated);
    res.json(updated);
  } catch (error) { handleError(res, error); }
});

app.post('/api/message-listener/sync-now', async (req, res) => {
  try { res.json(await drainQueueNow()); } catch (error) { handleError(res, error); }
});

app.post('/api/history-scan/start', (req, res) => {
  try {
    const days = req.body.days != null ? Number(req.body.days) : 7; // 0 = no time cutoff
    const limit = req.body.limit != null ? Number(req.body.limit) : null;
    const segmentKeys = Array.isArray(req.body.segmentKeys) ? req.body.segmentKeys : null;
    const extractTasks = req.body.extractTasks != null ? !!req.body.extractTasks : true;
    res.json(startHistoryScan({ days, limit, segmentKeys, extractTasks }));
  } catch (error) { handleError(res, error); }
});

app.get('/api/history-scan/status', (req, res) => {
  res.json(getScanStatus());
});

// ---------- Activity log (undoable user actions) ----------
app.get('/api/activity-log', async (req, res) => {
  try { res.json(await db.getActivityLog()); } catch (error) { handleError(res, error); }
});

app.post('/api/activity-log/:id/undo', async (req, res) => {
  try {
    const result = await db.undoActivityLogEntry(Number(req.params.id));
    if (!result.success) return res.status(400).json({ error: result.message });
    res.json(result);
  } catch (error) { handleError(res, error); }
});

// ---------- Sync ----------
app.get('/api/sync/config', async (req, res) => {
  try { res.json(await sync.getSyncConfig()); } catch (error) { handleError(res, error); }
});

app.get('/api/sync/log', async (req, res) => {
  try { res.json(await db.getSyncLog()); } catch (error) { handleError(res, error); }
});

app.post('/api/sync/run', async (req, res) => {
  try {
    const result = await sync.runSync();
    await db.logSyncRun({ status: 'success', ...result });
    res.json({ ok: true, ...result, restarting: true });
    sync.scheduleRestart();
  } catch (error) {
    await db.logSyncRun({ status: 'error', error: error.message });
    handleError(res, error);
  }
});

// ---------- Morning briefing ----------
app.post('/api/briefing/send', async (req, res) => {
  try {
    const settings = await db.getSettings();
    if (!settings.recipientChatId) throw new Error('לא הוגדר יעד לשליחת התדרוך');
    const data = await db.getMorningBriefingData();
    const text = buildBriefingText(data);
    await greenApi.sendWhatsAppMessage(settings.apiUrl, settings.idInstance, settings.apiTokenInstance, settings.recipientChatId, text);
    await clearResurfacedSnoozes(data);
    res.json({ ok: true, text });
  } catch (error) { handleError(res, error); }
});

function buildBriefingText(data) {
  let text = `*☀️ תדרוך בוקר*\n_${new Date().toLocaleDateString('he-IL')}_\n\n`;
  if (data.overdue.length) {
    text += `⚠️ *באיחור:*\n`;
    data.overdue.forEach(i => { text += `• ${i.task}\n`; });
    text += `\n`;
  }
  if (data.upcoming.length) {
    text += `📌 *לקראת ה-48 שעות הקרובות:*\n`;
    data.upcoming.forEach(i => { text += `• ${i.task}${i.deadline ? ` (יעד: ${i.deadline})` : ''}\n`; });
    text += `\n`;
  }
  if (data.resurfaced?.length) {
    text += `🔔 *תזכורות שחזרו (שמרת להמשך):*\n`;
    data.resurfaced.forEach(i => { text += `• ${i.task}\n`; });
    text += `\n`;
  }
  if (!data.overdue.length && !data.upcoming.length && !data.resurfaced?.length) {
    text += `אין משימות דחופות היום. יום נעים! 🙌\n\n`;
  }
  if (data.pendingScheduled) {
    text += `📨 ${data.pendingScheduled} הודעות מתוזמנות ממתינות לשליחה היום.\n`;
  }
  return text;
}

// Once a snoozed task is mentioned in the briefing it moves back to the
// active list instead of nagging again every day until manually resolved.
async function clearResurfacedSnoozes(data) {
  for (const item of data.resurfaced || []) {
    await db.setActionItemSavedForLater(item.id, false);
  }
}

// ---------- Cron: daily digest / morning briefing (checked every minute) ----------
let lastDigestDate = null;
let lastBriefingDate = null;

cron.schedule('* * * * *', async () => {
  try {
    const settings = await db.getSettings();
    const now = new Date();
    const hhmm = now.toTimeString().slice(0, 5);
    const today = now.toISOString().slice(0, 10);

    if (settings.digestTime && hhmm === settings.digestTime && lastDigestDate !== today) {
      lastDigestDate = today;
      const chats = await db.getTrackedChats();
      for (const chat of chats.filter(c => c.include_in_digest)) {
        try {
          const history = await greenApi.fetchChatHistory(settings.apiUrl, settings.idInstance, settings.apiTokenInstance, chat.chat_id, 150);
          await db.saveMessages(chat.chat_id, history);
          const allMessages = await db.getMessagesForChat(chat.chat_id);
          if (allMessages.length === 0) continue;
          const messagesText = allMessages.map(m => `[${new Date(m.timestamp * 1000).toLocaleDateString('he-IL')} ${m.sender_name}]: ${m.body}`).join('\n');
          const summaryData = await gemini.summarizeMessages(settings.geminiApiKey, messagesText, chat.name);
          await db.insertSummary(chat.chat_id, summaryData);
          if (summaryData.actionItems?.length && chat.profile_type !== 'info') {
            const lastTimestamp = allMessages[allMessages.length - 1]?.timestamp;
            await db.insertActionItems(chat.chat_id, summaryData.actionItems.map(it => {
              const sourceMessage = db.findSourceMessage(it.task, allMessages);
              const created_at = sourceMessage
                ? new Date(sourceMessage.timestamp * 1000).toISOString()
                : scheduler.resolveMessageCreatedAt(it.messageDate, lastTimestamp);
              return { ...it, created_at };
            }));
          }
          await db.updateChat(chat.chat_id, { last_summary_at: new Date().toISOString() });
          await db.clearMessagesForChat(chat.chat_id);
          if (settings.recipientChatId) {
            const text = gemini.formatSummaryForWhatsApp(chat.name, summaryData);
            await greenApi.sendWhatsAppMessage(settings.apiUrl, settings.idInstance, settings.apiTokenInstance, settings.recipientChatId, text);
          }
        } catch (err) {
          console.error(`[cron] Digest failed for chat ${chat.chat_id}:`, err.message);
        }
      }
    }

    if (settings.briefingTime && hhmm === settings.briefingTime && lastBriefingDate !== today) {
      lastBriefingDate = today;
      if (settings.recipientChatId) {
        const data = await db.getMorningBriefingData();
        const text = buildBriefingText(data);
        await greenApi.sendWhatsAppMessage(settings.apiUrl, settings.idInstance, settings.apiTokenInstance, settings.recipientChatId, text);
        await clearResurfacedSnoozes(data);
      }
    }
  } catch (err) {
    console.error('[cron] Error in minute tick:', err.message);
  }
});

// Sends one scheduled message via the Green API call that matches its type.
async function dispatchScheduledMessage(settings, msg) {
  const { apiUrl, idInstance, apiTokenInstance } = settings;
  switch (msg.type) {
    case 'media':
      return greenApi.sendFile(apiUrl, idInstance, apiTokenInstance, msg.chat_id, {
        url: msg.media_url, filename: msg.media_filename || 'file', caption: msg.content || ''
      });
    case 'location':
      return greenApi.sendLocation(apiUrl, idInstance, apiTokenInstance, msg.chat_id, {
        lat: msg.location?.lat, lng: msg.location?.lng, name: msg.location?.name, address: msg.location?.address
      });
    case 'poll':
      return greenApi.sendPoll(apiUrl, idInstance, apiTokenInstance, msg.chat_id, {
        question: msg.content, options: msg.poll_options || [], multipleAnswers: msg.poll_multiple
      });
    case 'contact':
      return greenApi.sendContact(apiUrl, idInstance, apiTokenInstance, msg.chat_id, {
        phone: msg.contact?.phone, firstName: msg.contact?.firstName, lastName: msg.contact?.lastName
      });
    case 'text':
    default:
      return greenApi.sendWhatsAppMessage(apiUrl, idInstance, apiTokenInstance, msg.chat_id, msg.content);
  }
}

// ---------- Cron: scheduled-messages dispatcher (checked every minute) ----------
cron.schedule('* * * * *', async () => {
  try {
    const settings = await db.getSettings();
    if (!settings.apiUrl) return;
    // The Cloudflare Worker owns dispatch once configured — messages live
    // in its KV store, not here, so running this too would either find
    // nothing (harmless) or, if something was ever mirrored locally,
    // double-send. Simplest correct answer: skip entirely.
    if (workerProxy.isWorkerConfigured(settings)) return;
    const all = await db.getScheduledMessages();
    const now = new Date();
    for (const msg of all) {
      if (!scheduler.isDue(msg, now)) continue;
      // Checked BEFORE attempting to send (matches the personal dashboard):
      // if the computer/app was down and this became stale, don't send it
      // late — mark it failed instead of surprising someone with a
      // "good morning" message that goes out at 2pm.
      if (scheduler.isExpired(msg, now)) {
        await db.updateScheduledMessage(msg.id, { status: 'failed', attempts: (msg.attempts || 0) + 1 });
        continue;
      }
      try {
        await dispatchScheduledMessage(settings, msg);
        const nextRepeat = scheduler.getNextRepeatAt(msg);
        if (nextRepeat) {
          await db.updateScheduledMessage(msg.id, { scheduled_at: nextRepeat, attempts: 0, retry_after: null, status: 'pending' });
        } else {
          await db.updateScheduledMessage(msg.id, { status: 'sent' });
        }
      } catch (err) {
        const attempts = (msg.attempts || 0) + 1;
        const expired = scheduler.isExpired(msg, now);
        await db.updateScheduledMessage(msg.id, {
          attempts,
          status: expired || attempts >= msg.max_attempts ? 'failed' : 'pending',
          retry_after: scheduler.getNextRetryAt({ ...msg, attempts }, now)
        });
      }
    }
  } catch (err) {
    console.error('[cron] Error in scheduled-messages tick:', err.message);
  }
});

app.listen(PORT, () => {
  console.log(`בשורה התחתונה — עבודה: השרת רץ על פורט ${PORT}`);
  startMessageListener();
});
