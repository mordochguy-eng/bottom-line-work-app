import axios from 'axios';

function getBaseUrl(apiUrl, idInstance) {
  const cleanUrl = apiUrl.replace(/\/+$/, '');
  return `${cleanUrl}/waInstance${idInstance}`;
}

export async function checkInstanceStatus(apiUrl, idInstance, apiTokenInstance) {
  try {
    const url = `${getBaseUrl(apiUrl, idInstance)}/getStateInstance/${apiTokenInstance}`;
    const response = await axios.get(url, { timeout: 8000 });
    return response.data;
  } catch (error) {
    console.error('Error checking instance status:', error.message);
    throw new Error('Failed to connect to Green API. Please check your credentials.');
  }
}

export async function getInstanceSettings(apiUrl, idInstance, apiTokenInstance) {
  const url = `${getBaseUrl(apiUrl, idInstance)}/getSettings/${apiTokenInstance}`;
  const response = await axios.get(url, { timeout: 15000 });
  return response.data;
}

export async function updateInstanceSettings(apiUrl, idInstance, apiTokenInstance, settings) {
  const url = `${getBaseUrl(apiUrl, idInstance)}/setSettings/${apiTokenInstance}`;
  const response = await axios.post(url, settings, { timeout: 15000 });
  return response.data;
}

// receiveNotification/lastIncomingMessages both depend on Green API actually
// generating incoming-message events server-side, which is off by default
// on a fresh instance (a real account was silently producing nothing until
// this was found and turned on manually). Auto-reply and live-insights both
// call this before relying on the notification queue, so a fresh setup
// self-heals instead of failing the same way silently.
export async function ensureIncomingWebhookEnabled(apiUrl, idInstance, apiTokenInstance) {
  const current = await getInstanceSettings(apiUrl, idInstance, apiTokenInstance);
  if (current.incomingWebhook === 'yes') return false;
  await updateInstanceSettings(apiUrl, idInstance, apiTokenInstance, { incomingWebhook: 'yes' });
  return true;
}

export async function fetchChats(apiUrl, idInstance, apiTokenInstance) {
  try {
    const url = `${getBaseUrl(apiUrl, idInstance)}/getChats/${apiTokenInstance}`;
    const response = await axios.get(url, { timeout: 15000 });
    // getChats returns every chat — thousands of individual contacts (@c.us)
    // alongside actual groups (@g.us). This tab is for group digests only,
    // so individual contacts are filtered out here rather than shown.
    return response.data
      .filter(chat => chat.id?.endsWith('@g.us'))
      .map(chat => ({
        chat_id: chat.id,
        name: chat.name || chat.id,
        type: 'general'
      }));
  } catch (error) {
    console.error('Error fetching chats:', error.message);
    throw new Error('Failed to fetch chats from Green API.');
  }
}

// Unfiltered version of the above — every chat on the account, individuals
// included. Used by the history scan to build the "unsaved individuals"
// segment (raw chats minus whichever ones are in the named-contacts list).
export async function fetchAllChatsRaw(apiUrl, idInstance, apiTokenInstance) {
  const url = `${getBaseUrl(apiUrl, idInstance)}/getChats/${apiTokenInstance}`;
  const response = await axios.get(url, { timeout: 15000 });
  return (response.data || []).map(chat => ({
    chat_id: chat.id,
    name: chat.name || chat.id,
    isGroup: chat.id?.endsWith('@g.us')
  }));
}

// Every incoming message across the WHOLE account (all chats, groups and
// individuals) within the last N minutes, in one call — used for the
// historical-scan feature so it doesn't need to enumerate every chat
// individually (which could be thousands of contacts).
export async function fetchLastIncomingMessages(apiUrl, idInstance, apiTokenInstance, minutes = 10080) {
  try {
    const url = `${getBaseUrl(apiUrl, idInstance)}/lastIncomingMessages/${apiTokenInstance}`;
    const response = await axios.get(url, { params: { minutes }, timeout: 30000 });
    const raw = response.data || [];
    return raw
      .map(msg => {
        let text = '';
        if (msg.typeMessage === 'textMessage') text = msg.textMessage || '';
        else if (msg.typeMessage === 'extendedTextMessage') text = msg.extendedTextMessageData?.text || msg.textMessage || '';
        else text = msg.caption || '';
        const chatId = msg.chatId;
        return {
          chatId,
          isGroup: chatId?.endsWith('@g.us'),
          senderName: msg.senderName || (msg.senderId ? msg.senderId.split('@')[0] : 'לא ידוע'),
          text,
          timestamp: msg.timestamp || 0
        };
      })
      .filter(m => m.chatId && m.text);
  } catch (error) {
    console.error('Error fetching last incoming messages:', error.message);
    throw new Error('Failed to fetch recent messages from Green API.');
  }
}

export async function fetchChatHistory(apiUrl, idInstance, apiTokenInstance, chatId, count = 100) {
  try {
    const url = `${getBaseUrl(apiUrl, idInstance)}/getChatHistory/${apiTokenInstance}`;
    const response = await axios.post(url, { chatId, count }, { timeout: 15000 });
    const rawMsgs = response.data || [];
    const normalized = rawMsgs.map(msg => {
      let body = '';
      let type = 'text';
      if (msg.typeMessage === 'textMessage' || msg.typeMessage === 'extendedTextMessage') {
        body = msg.textMessage || '';
      } else if (msg.typeMessage === 'imageMessage') {
        body = msg.caption || '[Image]'; type = 'image';
      } else if (msg.typeMessage === 'audioMessage') {
        body = '[Voice Message]'; type = 'audio';
      } else if (msg.typeMessage === 'documentMessage') {
        body = msg.caption || `[Document: ${msg.fileName || ''}]`; type = 'document';
      } else {
        body = msg.textMessage || `[Message: ${msg.typeMessage || 'unknown'}]`;
      }
      const senderId = msg.senderId || msg.sender || '';
      const senderName = msg.senderName || (senderId ? senderId.split('@')[0] : 'אני');
      return {
        message_id: msg.idMessage || Math.random().toString(36).substring(7),
        chat_id: chatId,
        sender_id: senderId,
        sender_name: senderName,
        type,
        body,
        timestamp: msg.timestamp || Math.floor(Date.now() / 1000)
      };
    });
    return normalized.reverse();
  } catch (error) {
    console.error(`Error fetching history for chat ${chatId}:`, error.message);
    return [];
  }
}

export async function sendWhatsAppMessage(apiUrl, idInstance, apiTokenInstance, chatId, message) {
  try {
    const url = `${getBaseUrl(apiUrl, idInstance)}/sendMessage/${apiTokenInstance}`;
    const response = await axios.post(url, { chatId, message }, { timeout: 15000 });
    return response.data;
  } catch (error) {
    console.error(`Error sending message to ${chatId}:`, error.message);
    throw new Error('Failed to send WhatsApp message.');
  }
}

export async function sendFile(apiUrl, idInstance, apiTokenInstance, chatId, { url, filename, caption = '' }) {
  const endpoint = `${getBaseUrl(apiUrl, idInstance)}/sendFileByUrl/${apiTokenInstance}`;
  const response = await axios.post(endpoint, { chatId, urlFile: url, fileName: filename, caption }, { timeout: 30000 });
  return response.data;
}

export async function sendLocation(apiUrl, idInstance, apiTokenInstance, chatId, { lat, lng, name = '', address = '' }) {
  const endpoint = `${getBaseUrl(apiUrl, idInstance)}/sendLocation/${apiTokenInstance}`;
  const response = await axios.post(endpoint, { chatId, latitude: lat, longitude: lng, nameLocation: name, address }, { timeout: 15000 });
  return response.data;
}

export async function sendContact(apiUrl, idInstance, apiTokenInstance, chatId, { phone, firstName, lastName = '' }) {
  const endpoint = `${getBaseUrl(apiUrl, idInstance)}/sendContact/${apiTokenInstance}`;
  const response = await axios.post(endpoint, { chatId, contact: { phoneContact: phone, firstName, lastName } }, { timeout: 15000 });
  return response.data;
}

export async function sendPoll(apiUrl, idInstance, apiTokenInstance, chatId, { question, options, multipleAnswers = false }) {
  const endpoint = `${getBaseUrl(apiUrl, idInstance)}/sendPoll/${apiTokenInstance}`;
  const response = await axios.post(endpoint, { chatId, message: question, options: options.map(o => ({ optionName: o })), multipleAnswers }, { timeout: 15000 });
  return response.data;
}

export async function checkPhone(apiUrl, idInstance, apiTokenInstance, phone) {
  const endpoint = `${getBaseUrl(apiUrl, idInstance)}/checkWhatsapp/${apiTokenInstance}`;
  const response = await axios.post(endpoint, { phoneNumber: phone }, { timeout: 10000 });
  return response.data;
}

// The phone's synced contact list — includes both individuals (type:'user')
// and groups (type:'group'), most without a saved name. Used by the
// history-scan feature to limit its scope to named/known contacts instead
// of every number that ever crossed the account.
export async function getContacts(apiUrl, idInstance, apiTokenInstance) {
  const endpoint = `${getBaseUrl(apiUrl, idInstance)}/getContacts/${apiTokenInstance}`;
  const response = await axios.get(endpoint, { timeout: 20000 });
  return response.data || [];
}

// Individuals only, named for display — used by the scheduled-message
// recipient picker so it can search real WhatsApp contacts, not just the
// tracked-groups list.
export async function getIndividualContacts(apiUrl, idInstance, apiTokenInstance) {
  const raw = await getContacts(apiUrl, idInstance, apiTokenInstance);
  return raw
    .filter(c => c.type === 'user' && c.id?.endsWith('@c.us'))
    .map(c => ({ chat_id: c.id, name: c.contactName?.trim() || c.name?.trim() || c.id }));
}

// ---------- Notification queue polling (used for the auto-reply feature) ----------
// This is Green API's pull-based mechanism for real-time incoming messages:
// no public URL is needed (unlike webhooks), which matters because this app
// runs on ordinary home/work machines behind NAT with no port exposed.

export async function receiveNotification(apiUrl, idInstance, apiTokenInstance) {
  try {
    const url = `${getBaseUrl(apiUrl, idInstance)}/receiveNotification/${apiTokenInstance}`;
    const response = await axios.get(url, { timeout: 20000 });
    return response.data; // null when the queue is empty
  } catch (error) {
    console.error('Error receiving notification:', error.message);
    return null;
  }
}

export async function deleteNotification(apiUrl, idInstance, apiTokenInstance, receiptId) {
  try {
    const url = `${getBaseUrl(apiUrl, idInstance)}/deleteNotification/${apiTokenInstance}/${receiptId}`;
    await axios.delete(url, { timeout: 10000 });
  } catch (error) {
    console.error('Error deleting notification:', error.message);
  }
}

// Extracts a normalized {chatId, senderName, isGroup, text} from a raw
// incomingMessageReceived webhook/notification body, or null if it isn't one.
export function parseIncomingMessage(notification) {
  const body = notification?.body;
  if (!body || body.typeWebhook !== 'incomingMessageReceived') return null;
  const chatId = body.senderData?.chatId;
  if (!chatId) return null;
  const isGroup = chatId.endsWith('@g.us');
  const md = body.messageData || {};
  let text = null;
  if (md.typeMessage === 'textMessage') text = md.textMessageData?.textMessage;
  else if (md.typeMessage === 'extendedTextMessage') text = md.extendedTextMessageData?.text;
  if (!text) return null;
  return {
    chatId,
    isGroup,
    senderName: body.senderData?.senderName || body.senderData?.sender?.split('@')[0] || 'לא ידוע',
    senderPhone: (body.senderData?.sender || '').split('@')[0],
    text,
    timestamp: body.timestamp || null
  };
}
