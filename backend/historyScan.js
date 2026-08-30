import * as db from './database.js';
import * as greenApi from './greenApi.js';
import { scanChatForActions, identifyRecurringMotifs } from './gemini.js';

/**
 * On-demand historical backfill across the WHOLE account, split into two
 * segments — saved contacts + groups vs. unsaved individuals — because they
 * tend to ask different kinds of things (the whole point of the split is to
 * later characterize each separately).
 *
 * getChatHistory works per chat regardless of Green API's notification
 * settings (it syncs directly from WhatsApp), so this reliably reaches real
 * history; the cost is one API call per chat. Runs as a background job
 * (not inside the request) since a full pass over ~2,300 chats takes
 * several minutes — the frontend starts it and polls getScanStatus().
 *
 * Two extra things happen beyond simple task extraction:
 *  - insertActionItems already dedupes against existing tasks for the same
 *    chat, so re-running (or overlapping with the live listener) doesn't
 *    pile up near-duplicate tasks.
 *  - every incoming (non-"אני") message is also collected per segment; once
 *    the crawl is done, one Gemini call per segment looks for recurring
 *    themes and proposes FAQ entries for the auto-reply feature.
 */

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

async function buildSegments(settings) {
  const [rawContacts, groups, allChats] = await Promise.all([
    greenApi.getContacts(settings.apiUrl, settings.idInstance, settings.apiTokenInstance),
    db.getChats(),
    greenApi.fetchAllChatsRaw(settings.apiUrl, settings.idInstance, settings.apiTokenInstance)
  ]);

  const namedContactIds = new Set(
    rawContacts.filter(c => c.type === 'user' && c.id?.endsWith('@c.us') && c.name?.trim()).map(c => c.id)
  );

  const namedAndGroups = [
    ...groups.map(g => ({ chat_id: g.chat_id, name: g.name, isGroup: true })),
    ...rawContacts
      .filter(c => c.type === 'user' && c.id?.endsWith('@c.us') && c.name?.trim())
      .map(c => ({ chat_id: c.id, name: c.name, isGroup: false }))
  ];

  const unsavedIndividuals = allChats
    .filter(c => !c.isGroup && !namedContactIds.has(c.chat_id))
    .map(c => ({ chat_id: c.chat_id, name: c.name, isGroup: false }));

  return {
    'אנשי קשר שמורים וקבוצות': namedAndGroups,
    'צ׳אטים אישיים לא שמורים': unsavedIndividuals
  };
}

async function scanSegment(settings, label, targets, cutoffSeconds, remainingLimit) {
  const questions = [];
  let count = 0;
  for (const target of targets) {
    if (remainingLimit != null && count >= remainingLimit) break;
    count++;
    try {
      const history = await greenApi.fetchChatHistory(settings.apiUrl, settings.idInstance, settings.apiTokenInstance, target.chat_id, 50);
      const recent = history.filter(m => m.timestamp >= cutoffSeconds);
      if (recent.length > 0) {
        state.chatsWithHistory++;

        for (const m of recent) {
          if (m.sender_name !== 'אני' && m.body && questions.length < MAX_QUESTIONS_PER_SEGMENT) {
            questions.push(m.body);
          }
        }

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
    } catch (err) {
      console.error(`[historyScan] [${label}] chat ${target.chat_id} failed:`, err.message);
    } finally {
      state.chatsScanned++;
    }
  }
  return { questions, chatsUsed: count };
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
  const segments = await buildSegments(settings);

  const totalEligible = Object.values(segments).reduce((sum, arr) => sum + arr.length, 0);
  state.totalEligible = totalEligible;
  state.chatsAttempted = limit && limit > 0 ? Math.min(limit, totalEligible) : totalEligible;

  let remainingLimit = limit && limit > 0 ? limit : null;
  const questionsBySegment = {};

  for (const [label, targets] of Object.entries(segments)) {
    const { questions, chatsUsed } = await scanSegment(settings, label, targets, cutoffSeconds, remainingLimit);
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
