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
//
// Green API keeps the queue server-side for a limited window (about a day)
// even while nothing is polling it, so re-enabling (or hitting "sync now")
// catches up on whatever accumulated in the meantime — it isn't lost.

const IDLE_INTERVAL_MS = 4000; // how often we check when the queue was empty last time
const BUSY_DELAY_MS = 250;     // how fast we drain back-to-back when there's a backlog
const DRAIN_SAFETY_CAP = 300;  // hard stop for a manual "sync now" so it can't run forever

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
  if (parsed.isGroup || !settings.autoReplyEnabled) return false;
  const [contacts, faqs] = await Promise.all([db.getContacts(), db.getFaqs()]);
  const known = isEligibleContact(contacts, parsed.chatId);
  const faqMatch = known ? null : matchFaq(faqs, parsed.text);
  if (!known && !faqMatch) return false;

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
  return true;
}

async function runLiveInsights(settings, parsed) {
  if (!settings.liveInsightsEnabled) return false;
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
      category: result.category || null,
      assignee: parsed.senderName,
      deadline: result.deadline || null
    }]);
    return true;
  }
  return false;
}

/** Pops and processes exactly one notification. Returns whether one was found (i.e. whether the queue might have more). */
async function processOneNotification() {
  const settings = await db.getSettings();
  if (!settings.autoReplyEnabled && !settings.liveInsightsEnabled) return { found: false };
  if (!settings.apiUrl || !settings.idInstance || !settings.apiTokenInstance) return { found: false };

  const notification = await greenApi.receiveNotification(settings.apiUrl, settings.idInstance, settings.apiTokenInstance);
  if (!notification) return { found: false };

  let replyQueued = false;
  let insightAdded = false;
  try {
    const parsed = greenApi.parseIncomingMessage(notification);
    if (parsed && settings.geminiApiKey) {
      const [r, i] = await Promise.all([
        runAutoReply(settings, parsed).catch(err => { console.error('[messageListener] auto-reply error:', err.message); return false; }),
        runLiveInsights(settings, parsed).catch(err => { console.error('[messageListener] live-insights error:', err.message); return false; })
      ]);
      replyQueued = r;
      insightAdded = i;
    }
  } catch (err) {
    console.error('[messageListener] Error processing notification:', err.message);
  } finally {
    await greenApi.deleteNotification(settings.apiUrl, settings.idInstance, settings.apiTokenInstance, notification.receiptId);
  }
  return { found: true, replyQueued, insightAdded };
}

export function startMessageListener() {
  if (polling) return;
  polling = true;
  const loop = async () => {
    if (!polling) return;
    let found = false;
    try {
      ({ found } = await processOneNotification());
    } catch (err) {
      console.error('[messageListener] poll error:', err.message);
    }
    timer = setTimeout(loop, found ? BUSY_DELAY_MS : IDLE_INTERVAL_MS);
  };
  loop();
}

export function stopMessageListener() {
  polling = false;
  if (timer) clearTimeout(timer);
}

/** Manually drains whatever is currently queued, right now, instead of waiting for the background loop. */
export async function drainQueueNow() {
  let consumed = 0;
  let repliesQueued = 0;
  let insightsAdded = 0;
  for (let i = 0; i < DRAIN_SAFETY_CAP; i++) {
    const result = await processOneNotification();
    if (!result.found) break;
    consumed++;
    if (result.replyQueued) repliesQueued++;
    if (result.insightAdded) insightsAdded++;
  }
  return { consumed, repliesQueued, insightsAdded, hitSafetyCap: consumed === DRAIN_SAFETY_CAP };
}
