import * as db from './database.js';
import * as greenApi from './greenApi.js';
import { scanChatForActions } from './gemini.js';

/**
 * On-demand historical backfill: pulls every incoming message account-wide
 * (all chats — groups and individuals) from the last N days in one Green
 * API call, groups them by chat, and runs one Gemini call per chat to pull
 * out anything that needed action. Manually triggered from the Tasks page —
 * separate from the live listener, which only sees messages from the
 * moment it's turned on.
 *
 * Note: if the live listener was already running during part of this
 * window, the same message could produce a duplicate task here — harmless
 * (just an extra checklist line), not de-duplicated in this version.
 */
export async function runHistoryScan(days) {
  const settings = await db.getSettings();
  if (!settings.apiUrl || !settings.idInstance || !settings.apiTokenInstance) {
    throw new Error('לא הוגדרו פרטי Green API בהגדרות');
  }
  if (!settings.geminiApiKey) {
    throw new Error('לא הוגדר מפתח Gemini בהגדרות');
  }

  const minutes = Math.max(1, Math.round(days * 24 * 60));
  const messages = await greenApi.fetchLastIncomingMessages(settings.apiUrl, settings.idInstance, settings.apiTokenInstance, minutes);

  const byChat = new Map();
  for (const m of messages) {
    if (!byChat.has(m.chatId)) byChat.set(m.chatId, []);
    byChat.get(m.chatId).push(m);
  }

  const chats = await db.getChats(); // group names, when known
  let chatsScanned = 0;
  let itemsAdded = 0;

  for (const [chatId, msgs] of byChat) {
    chatsScanned++;
    const isGroup = chatId.endsWith('@g.us');
    const chatName = chats.find(c => c.chat_id === chatId)?.name || (isGroup ? chatId : msgs[0]?.senderName || chatId);
    try {
      const result = await scanChatForActions(settings.geminiApiKey, { chatName, isGroup, messages: msgs });
      const items = result?.items || [];
      if (items.length) {
        await db.insertActionItems(chatId, items.map(it => ({
          task: it.task,
          assignee: it.sender || msgs[0]?.senderName,
          deadline: it.deadline || null
        })));
        itemsAdded += items.length;
      }
    } catch (err) {
      console.error(`[historyScan] chat ${chatId} failed:`, err.message);
    }
  }

  return { chatsScanned, messagesScanned: messages.length, itemsAdded };
}
