// Provider switch. Every function keeps the exact signature greenApi.js had
// (apiUrl, idInstance, apiTokenInstance, ...args) so existing call sites do not
// change. settings.provider === 'baileys' routes to baileysClient.js (the
// credentials are ignored); anything else keeps using Green API.
import * as db from './database.js';
import * as green from './greenApi.js';
import * as baileys from './baileysClient.js';

let cache = { value: 'green', at: 0 };

export async function getProvider() {
  if (Date.now() - cache.at < 2000) return cache.value;
  const s = await db.getSettings();
  cache = { value: s.provider === 'baileys' ? 'baileys' : 'green', at: Date.now() };
  return cache.value;
}

export function resetProviderCache() { cache = { value: cache.value, at: 0 }; }

const isBaileys = async () => (await getProvider()) === 'baileys';

function wrap(name) {
  return async (apiUrl, idInstance, apiTokenInstance, ...rest) =>
    (await isBaileys()) ? baileys[name](...rest) : green[name](apiUrl, idInstance, apiTokenInstance, ...rest);
}

export const checkInstanceStatus = wrap('checkInstanceStatus');
export const getInstanceSettings = wrap('getInstanceSettings');
export const updateInstanceSettings = wrap('updateInstanceSettings');
export const ensureIncomingWebhookEnabled = wrap('ensureIncomingWebhookEnabled');
export const fetchChats = wrap('fetchChats');
export const fetchAllChatsRaw = wrap('fetchAllChatsRaw');
export const fetchLastIncomingMessages = wrap('fetchLastIncomingMessages');
export const fetchChatHistory = wrap('fetchChatHistory');
export const sendWhatsAppMessage = wrap('sendWhatsAppMessage');
export const sendFile = wrap('sendFile');
export const sendLocation = wrap('sendLocation');
export const sendContact = wrap('sendContact');
export const sendPoll = wrap('sendPoll');
export const checkPhone = wrap('checkPhone');
export const getContacts = wrap('getContacts');
export const getIndividualContacts = wrap('getIndividualContacts');
export const receiveNotification = wrap('receiveNotification');
export const deleteNotification = wrap('deleteNotification');

// Media URLs produced by baileysClient look like baileys-media://...; anything
// else is a normal Green API download URL.
export function downloadMediaAsBase64(url) {
  return (url || '').startsWith('baileys-media://') ? baileys.downloadMediaAsBase64(url) : green.downloadMediaAsBase64(url);
}

// Baileys notifications arrive already parsed.
export function parseIncomingMessage(notification) {
  return notification && notification.__baileys ? notification.parsed : green.parseIncomingMessage(notification);
}

/** True when this provider has what it needs to run (Green API: credentials; Baileys: nothing). */
export function isConfigured(settings) {
  if (settings.provider === 'baileys') return true;
  return !!(settings.apiUrl && settings.idInstance && settings.apiTokenInstance);
}

/** Starts the Baileys connection when it is the selected provider. Safe to call repeatedly. */
export async function init() {
  resetProviderCache();
  if (await isBaileys()) {
    try { await baileys.start(); } catch (e) { console.error('[whatsapp] Baileys start failed:', e.message); }
  }
}

export { baileys };
