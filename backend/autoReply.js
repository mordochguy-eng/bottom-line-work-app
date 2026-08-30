import * as db from './database.js';
import * as greenApi from './greenApi.js';
import { draftAutoReply } from './gemini.js';

// Draft-only auto-reply pipeline:
// receiveNotification (poll) -> filter -> Gemini draft -> approval queue.
// Nothing is ever sent from here — sending only happens when the user
// approves an item from the queue via the /api/approval-queue/:id/approve route.

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

export async function pollOnce() {
  const settings = await db.getSettings();
  if (!settings.autoReplyEnabled) return;
  if (!settings.apiUrl || !settings.idInstance || !settings.apiTokenInstance) return;

  const notification = await greenApi.receiveNotification(settings.apiUrl, settings.idInstance, settings.apiTokenInstance);
  if (!notification) return;

  try {
    const parsed = greenApi.parseIncomingMessage(notification);
    if (parsed && !parsed.isGroup) {
      const [contacts, faqs] = await Promise.all([db.getContacts(), db.getFaqs()]);
      const known = isEligibleContact(contacts, parsed.chatId);
      const faqMatch = known ? null : matchFaq(faqs, parsed.text);

      if ((known || faqMatch) && settings.geminiApiKey) {
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
    }
  } catch (err) {
    console.error('[autoReply] Error processing notification:', err.message);
  } finally {
    await greenApi.deleteNotification(settings.apiUrl, settings.idInstance, settings.apiTokenInstance, notification.receiptId);
  }
}

export function startAutoReplyPolling(intervalMs = 4000) {
  if (polling) return;
  polling = true;
  const loop = async () => {
    if (!polling) return;
    try {
      await pollOnce();
    } catch (err) {
      console.error('[autoReply] poll error:', err.message);
    }
    timer = setTimeout(loop, intervalMs);
  };
  loop();
}

export function stopAutoReplyPolling() {
  polling = false;
  if (timer) clearTimeout(timer);
}
