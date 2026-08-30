import axios from 'axios';

// Talks to the optional Cloudflare Worker that takes over scheduled-message
// sending so it keeps working while this computer is off. Scheduled
// messages live entirely in the Worker's KV store once configured — not
// mirrored locally — so there's exactly one source of truth and no risk of
// double-sending from both places.

export function isWorkerConfigured(settings) {
  return !!(settings.workerUrl && settings.workerAuthToken);
}

function baseUrl(settings) {
  return settings.workerUrl.replace(/\/+$/, '');
}

async function request(settings, method, path, body) {
  const res = await axios({
    method,
    url: `${baseUrl(settings)}/${path}`,
    headers: { Authorization: `Bearer ${settings.workerAuthToken}` },
    data: body,
    timeout: 15000
  });
  return res.data;
}

export const getMessages = (settings) => request(settings, 'get', 'messages');
export const createMessage = (settings, body) => request(settings, 'post', 'messages', body);
export const updateMessage = (settings, id, patch) => request(settings, 'put', `messages/${id}`, patch);
export const deleteMessage = (settings, id) => request(settings, 'delete', `messages/${id}`);

export const pushConfig = (settings) => request(settings, 'post', 'config', {
  apiUrl: settings.apiUrl,
  idInstance: settings.idInstance,
  apiTokenInstance: settings.apiTokenInstance
});

export const getWorkerStatus = (settings) => request(settings, 'get', 'config');
