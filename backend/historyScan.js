import * as db from './database.js';
import * as greenApi from './greenApi.js';
import { scanChatForActions } from './gemini.js';

/**
 * On-demand historical backfill, scoped to named/known chats only: your
 * saved contacts (via getContacts, filtered to ones with a real name) plus
 * your groups. This avoids both problems with a full-account approach —
 * lastIncomingMessages returns nothing before the notification setting was
 * turned on (see messageListener), and crawling every one of the ~2,300
 * raw chats on the account would be far too slow and hit Green API's rate
 * limit almost immediately.
 *
 * Runs as a background job (not inside the request) since a full pass over
 * ~1,800 chats takes on the order of 10+ minutes — the frontend starts it
 * and polls getScanStatus() for live progress instead of blocking on it.
 */

let state = defaultState();

function defaultState() {
  return {
    running: false,
    totalEligible: 0,
    chatsAttempted: 0,
    chatsScanned: 0,
    chatsWithHistory: 0,
    itemsAdded: 0,
    startedAt: null,
    finishedAt: null,
    error: null
  };
}

export function getScanStatus() {
  return { ...state };
}

export function startHistoryScan({ days, limit }) {
  if (state.running) {
    throw new Error('סריקת היסטוריה כבר רצה — המתן שתסתיים');
  }
  state = { ...defaultState(), running: true, startedAt: new Date().toISOString() };
  runScan({ days, limit }).catch(err => {
    state.error = err.message;
  }).finally(() => {
    state.running = false;
    state.finishedAt = new Date().toISOString();
  });
  return getScanStatus();
}

async function runScan({ days, limit }) {
  const settings = await db.getSettings();
  if (!settings.apiUrl || !settings.idInstance || !settings.apiTokenInstance) {
    throw new Error('לא הוגדרו פרטי Green API בהגדרות');
  }
  if (!settings.geminiApiKey) {
    throw new Error('לא הוגדר מפתח Gemini בהגדרות');
  }

  const cutoffSeconds = Math.floor(Date.now() / 1000) - Math.round(days * 24 * 60 * 60);

  const [rawContacts, groups] = await Promise.all([
    greenApi.getContacts(settings.apiUrl, settings.idInstance, settings.apiTokenInstance),
    db.getChats()
  ]);

  const namedContacts = rawContacts
    .filter(c => c.type === 'user' && c.id?.endsWith('@c.us') && c.name?.trim())
    .map(c => ({ chat_id: c.id, name: c.name, isGroup: false }));
  const groupTargets = groups.map(g => ({ chat_id: g.chat_id, name: g.name, isGroup: true }));

  let targets = [...groupTargets, ...namedContacts];
  state.totalEligible = targets.length;
  if (limit && limit > 0) targets = targets.slice(0, limit);
  state.chatsAttempted = targets.length;

  for (const target of targets) {
    try {
      const history = await greenApi.fetchChatHistory(settings.apiUrl, settings.idInstance, settings.apiTokenInstance, target.chat_id, 50);
      const recent = history.filter(m => m.timestamp >= cutoffSeconds);
      if (recent.length > 0) {
        state.chatsWithHistory++;
        const messages = recent.map(m => ({ senderName: m.sender_name, text: m.body, timestamp: m.timestamp }));
        const result = await scanChatForActions(settings.geminiApiKey, { chatName: target.name, isGroup: target.isGroup, messages });
        const items = result?.items || [];
        if (items.length) {
          await db.insertActionItems(target.chat_id, items.map(it => ({
            task: it.task,
            category: it.category || null,
            assignee: it.sender || target.name,
            deadline: it.deadline || null
          })));
          state.itemsAdded += items.length;
        }
      }
    } catch (err) {
      console.error(`[historyScan] chat ${target.chat_id} failed:`, err.message);
    } finally {
      state.chatsScanned++;
    }
  }
}
