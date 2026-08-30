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

app.post('/api/chats/toggle', async (req, res) => {
  try {
    const { chat_id, is_tracked } = req.body;
    res.json(await db.updateChat(chat_id, { is_tracked }));
  } catch (error) { handleError(res, error); }
});

app.post('/api/chats/toggle-digest', async (req, res) => {
  try {
    const { chat_id, include_in_digest } = req.body;
    res.json(await db.updateChat(chat_id, { include_in_digest }));
  } catch (error) { handleError(res, error); }
});

app.post('/api/chats/category', async (req, res) => {
  try {
    const { chat_id, category } = req.body;
    res.json(await db.updateChat(chat_id, { profile_type: category }));
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
      await db.insertActionItems(chat_id, summaryData.actionItems.map(it => ({
        ...it,
        created_at: scheduler.resolveMessageCreatedAt(it.messageDate, lastTimestamp)
      })));
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
app.get('/api/scheduled-messages', async (req, res) => {
  try { res.json(await db.getScheduledMessages()); } catch (error) { handleError(res, error); }
});

app.post('/api/scheduled-messages', async (req, res) => {
  try {
    const body = { ...req.body, chat_id: scheduler.normaliseChatId(req.body.chat_id) };
    res.json(await db.saveScheduledMessage(body));
  } catch (error) { handleError(res, error); }
});

app.put('/api/scheduled-messages/:id', async (req, res) => {
  try { res.json(await db.updateScheduledMessage(Number(req.params.id), req.body)); } catch (error) { handleError(res, error); }
});

app.delete('/api/scheduled-messages/:id', async (req, res) => {
  try { await db.deleteScheduledMessage(Number(req.params.id)); res.json({ ok: true }); } catch (error) { handleError(res, error); }
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
  try { await db.deleteContact(Number(req.params.id)); res.json({ ok: true }); } catch (error) { handleError(res, error); }
});

app.get('/api/faq', async (req, res) => {
  try { res.json(await db.getFaqs()); } catch (error) { handleError(res, error); }
});

app.post('/api/faq', async (req, res) => {
  try { res.json(await db.saveFaq(req.body)); } catch (error) { handleError(res, error); }
});

app.put('/api/faq/:id', async (req, res) => {
  try { res.json(await db.updateFaq(Number(req.params.id), req.body)); } catch (error) { handleError(res, error); }
});

app.delete('/api/faq/:id', async (req, res) => {
  try { await db.deleteFaq(Number(req.params.id)); res.json({ ok: true }); } catch (error) { handleError(res, error); }
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
            await db.insertActionItems(chat.chat_id, summaryData.actionItems.map(it => ({
              ...it,
              created_at: scheduler.resolveMessageCreatedAt(it.messageDate, lastTimestamp)
            })));
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
