import * as db from './database.js';
import * as greenApi from './greenApi.js';
import { scanChatForActions, identifyRecurringMotifs } from './gemini.js';

/**
 * On-demand historical backfill, split into two segments — saved contacts +
 * groups vs. unsaved individuals — since they tend to ask different kinds
 * of things (the whole point of the split is to characterize each
 * separately). Configurable per run: which segment(s), how far back
 * (days=0 means no time cutoff — everything getChatHistory returns), a
 * chat-count cap, and whether to also extract action items or just collect
 * questions for the motif analysis (much faster when the answer is "just
 * characterize what people ask" over a large, old-message segment).
 *
 * getChatHistory works per chat regardless of Green API's notification
 * settings (it syncs directly from WhatsApp), so this reliably reaches real
 * history; the cost is one API call per chat, plus one Gemini call per chat
 * when task extraction is on. Runs as a background job (not inside the
 * request) since a full pass can take minutes — the frontend starts it and
 * polls getScanStatus().
 */

const SEGMENTS = {
  namedAndGroups: 'אנשי קשר שמורים וקבוצות',
  unsavedIndividuals: 'צ׳אטים אישיים לא שמורים'
};

const MAX_QUESTIONS_PER_SEGMENT = 400; // keeps the motif-analysis prompt bounded

let state = defaultState();

function defaultState() {
  return {
    running: false,
    totalEligible: 0,
    chatsAttempted: 0,
    chatsScanned: 0,
    chatsWithHistory: 0,
    itemsAdded: 0,
    faqSuggestionsAdded: 0,
    startedAt: null,
    finishedAt: null,
    error: null
  };
}

export function getScanStatus() {
  return { ...state };
}

/**
 * options:
 *   days           - 0/null = no time cutoff (all available history)
 *   limit           - 0/null = no chat-count cap
 *   segmentKeys     - subset of Object.keys(SEGMENTS); omit/null = both
 *   extractTasks    - default true; false = only collect questions for the
 *                     motif analysis, skip the per-chat task-extraction call
 */
export function startHistoryScan(options) {
  if (state.running) {
    throw new Error('סריקת היסטוריה כבר רצה — המתן שתסתיים');
  }
  state = { ...defaultState(), running: true, startedAt: new Date().toISOString() };
  runScan(options).catch(err => {
    state.error = err.message;
  }).finally(() => {
    state.running = false;
    state.finishedAt = new Date().toISOString();
  });
  return getScanStatus();
}

async function buildSegments(settings) {
  const [rawContacts, groups, allChats] = await Promise.all([
    greenApi.getContacts(settings.apiUrl, settings.idInstance, settings.apiTokenInstance),
    db.getChats(),
    greenApi.fetchAllChatsRaw(settings.apiUrl, settings.idInstance, settings.apiTokenInstance)
  ]);

  // contactName (not name!) is the field that reflects a real phone-book
  // save — `name` also fires for WhatsApp profile names people set
  // themselves, which shows up even for total strangers who never got
  // saved. Confirmed against the real account: ~980 individual chats had a
  // `name` but an empty `contactName`.
  const namedContactIds = new Set(
    rawContacts.filter(c => c.type === 'user' && c.id?.endsWith('@c.us') && c.contactName?.trim()).map(c => c.id)
  );

  const namedAndGroups = [
    ...groups.map(g => ({ chat_id: g.chat_id, name: g.name, isGroup: true })),
    ...rawContacts
      .filter(c => c.type === 'user' && c.id?.endsWith('@c.us') && c.contactName?.trim())
      .map(c => ({ chat_id: c.id, name: c.contactName, isGroup: false }))
  ];

  const unsavedIndividuals = allChats
    .filter(c => !c.isGroup && !namedContactIds.has(c.chat_id))
    .map(c => ({ chat_id: c.chat_id, name: c.name, isGroup: false }));

  return { namedAndGroups, unsavedIndividuals };
}

async function scanSegment(settings, label, targets, cutoffSeconds, remainingLimit, extractTasks) {
  const questions = [];
  let count = 0;
  for (const target of targets) {
    if (remainingLimit != null && count >= remainingLimit) break;
    count++;
    try {
      const history = await greenApi.fetchChatHistory(settings.apiUrl, settings.idInstance, settings.apiTokenInstance, target.chat_id, 100);
      const recent = cutoffSeconds ? history.filter(m => m.timestamp >= cutoffSeconds) : history;
      if (recent.length > 0) {
        state.chatsWithHistory++;

        for (const m of recent) {
          if (m.sender_name !== 'אני' && m.body && questions.length < MAX_QUESTIONS_PER_SEGMENT) {
            questions.push(m.body);
          }
        }

        if (extractTasks) {
          const messages = recent.map(m => ({ senderName: m.sender_name, text: m.body, timestamp: m.timestamp }));
          const result = await scanChatForActions(settings.geminiApiKey, { chatName: target.name, isGroup: target.isGroup, messages });
          const items = result?.items || [];
          if (items.length) {
            const created = await db.insertActionItems(target.chat_id, items.map(it => ({
              task: it.task,
              category: it.category || null,
              assignee: it.sender || target.name,
              deadline: it.deadline || null
            })));
            state.itemsAdded += created.length;
          }
        }
      }
    } catch (err) {
      console.error(`[historyScan] [${label}] chat ${target.chat_id} failed:`, err.message);
    } finally {
      state.chatsScanned++;
    }
  }
  return { questions, chatsUsed: count };
}

async function runScan({ days, limit, segmentKeys, extractTasks = true }) {
  const settings = await db.getSettings();
  if (!settings.apiUrl || !settings.idInstance || !settings.apiTokenInstance) {
    throw new Error('לא הוגדרו פרטי Green API בהגדרות');
  }
  if (!settings.geminiApiKey) {
    throw new Error('לא הוגדר מפתח Gemini בהגדרות');
  }

  const cutoffSeconds = days && days > 0 ? Math.floor(Date.now() / 1000) - Math.round(days * 24 * 60 * 60) : null;
  const allSegments = await buildSegments(settings);
  const keys = segmentKeys && segmentKeys.length ? segmentKeys : Object.keys(SEGMENTS);

  const totalEligible = keys.reduce((sum, key) => sum + (allSegments[key]?.length || 0), 0);
  state.totalEligible = totalEligible;
  state.chatsAttempted = limit && limit > 0 ? Math.min(limit, totalEligible) : totalEligible;

  let remainingLimit = limit && limit > 0 ? limit : null;
  const questionsBySegment = {};

  for (const key of keys) {
    const label = SEGMENTS[key];
    const targets = allSegments[key] || [];
    const { questions, chatsUsed } = await scanSegment(settings, label, targets, cutoffSeconds, remainingLimit, extractTasks);
    questionsBySegment[label] = questions;
    if (remainingLimit != null) remainingLimit = Math.max(0, remainingLimit - chatsUsed);
  }

  for (const [label, questions] of Object.entries(questionsBySegment)) {
    if (questions.length < 3) continue; // not enough signal to look for a pattern
    try {
      const result = await identifyRecurringMotifs(settings.geminiApiKey, { segmentLabel: label, questions });
      const suggestions = result?.faqSuggestions || [];
      if (suggestions.length) {
        const created = await db.insertFaqSuggestions(suggestions);
        state.faqSuggestionsAdded += created.length;
      }
    } catch (err) {
      console.error(`[historyScan] motif analysis for "${label}" failed:`, err.message);
    }
  }
}
