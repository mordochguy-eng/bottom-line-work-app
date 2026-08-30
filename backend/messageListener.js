import * as db from './database.js';
import * as greenApi from './greenApi.js';
import { draftAutoReply, analyzeMessageForAction } from './gemini.js';

// Single polling loop over Green API's notification queue, feeding two
// independent pipelines per incoming message:
//   1. Auto-reply drafting (1:1 only, contact/FAQ-gated) -> approval queue.
//   2. Live insight extraction (every chat, group or 1:1) -> action items.
// Both read the SAME queue, so they must share one poller rather than each
// running their own — two independent pollers would each steal half the
// notifications from the other.

let polling = false;
let timer = null;

function isEligibleContact(contacts, chatId) {
  return contacts.some(c => c.chat_id === chatId);
}

// Naive keyword-overlap FAQ match. Good enough as a pre-filter since every
// draft still requires human approval before anything is sent.
function matchFaq(faqs, text) {
  const lower = (text || '').toLowerCase();
  let best = null;
  let bestScore = 0;
  for (const f of faqs) {
    const qWords = f.question.toLowerCase().split(/\s+/).filter(Boolean);
    const score = qWords.filter(w => lower.includes(w)).length / Math.max(qWords.length, 1);
    if (score > bestScore) { bestScore = score; best = f; }
  }
  return bestScore >= 0.5 ? best : null;
}

async function runAutoReply(settings, parsed) {
  if (parsed.isGroup || !settings.autoReplyEnabled) return;
  const [contacts, faqs] = await Promise.all([db.getContacts(), db.getFaqs()]);
  const known = isEligibleContact(contacts, parsed.chatId);
  const faqMatch = known ? null : matchFaq(faqs, parsed.text);
  if (!known && !faqMatch) return;

  const draft = await draftAutoReply(settings.geminiApiKey, {
    senderName: parsed.senderName,
    incomingMessage: parsed.text,
    faqs,
    isKnownContact: known
  });
  await db.addToApprovalQueue({
    chat_id: parsed.chatId,
    sender_name: parsed.senderName,
    incoming_message: parsed.text,
    draft_reply: draft,
    match_reason: known ? 'איש קשר מאושר' : `שאלה נפוצה: ${faqMatch.question}`
  });
}

async function runLiveInsights(settings, parsed) {
  if (!settings.liveInsightsEnabled) return;
  const chats = await db.getChats();
  const chatName = chats.find(c => c.chat_id === parsed.chatId)?.name || parsed.senderName;

  const result = await analyzeMessageForAction(settings.geminiApiKey, {
    senderName: parsed.senderName,
    chatName,
    isGroup: parsed.isGroup,
    text: parsed.text
  });
  if (result?.needsAction && result.task) {
    await db.insertActionItems(parsed.chatId, [{
      task: result.task,
      assignee: parsed.senderName,
      deadline: result.deadline || null
    }]);
  }
}

export async function pollOnce() {
  const settings = await db.getSettings();
  if (!settings.autoReplyEnabled && !settings.liveInsightsEnabled) return;
  if (!settings.apiUrl || !settings.idInstance || !settings.apiTokenInstance) return;

  const notification = await greenApi.receiveNotification(settings.apiUrl, settings.idInstance, settings.apiTokenInstance);
  if (!notification) return;

  try {
    const parsed = greenApi.parseIncomingMessage(notification);
    if (parsed && settings.geminiApiKey) {
      await Promise.all([
        runAutoReply(settings, parsed).catch(err => console.error('[messageListener] auto-reply error:', err.message)),
        runLiveInsights(settings, parsed).catch(err => console.error('[messageListener] live-insights error:', err.message))
      ]);
    }
  } catch (err) {
    console.error('[messageListener] Error processing notification:', err.message);
  } finally {
    await greenApi.deleteNotification(settings.apiUrl, settings.idInstance, settings.apiTokenInstance, notification.receiptId);
  }
}

export function startMessageListener(intervalMs = 4000) {
  if (polling) return;
  polling = true;
  const loop = async () => {
    if (!polling) return;
    try {
      await pollOnce();
    } catch (err) {
      console.error('[messageListener] poll error:', err.message);
    }
    timer = setTimeout(loop, intervalMs);
  };
  loop();
}

export function stopMessageListener() {
  polling = false;
  if (timer) clearTimeout(timer);
}
