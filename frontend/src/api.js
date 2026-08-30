async function request(path, options = {}) {
  const res = await fetch(`/api${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `שגיאה בבקשה ל-${path}`);
  return data;
}

export const api = {
  getSettings: () => request('/settings'),
  saveSettings: (patch) => request('/settings', { method: 'POST', body: JSON.stringify(patch) }),
  getInstanceStatus: () => request('/instance-status'),

  getChats: () => request('/chats'),
  getWhatsappContacts: () => request('/whatsapp-contacts'),
  syncChats: () => request('/chats/sync', { method: 'POST' }),
  toggleChatTracked: (chat_id, is_tracked) => request('/chats/toggle', { method: 'POST', body: JSON.stringify({ chat_id, is_tracked }) }),
  toggleChatDigest: (chat_id, include_in_digest) => request('/chats/toggle-digest', { method: 'POST', body: JSON.stringify({ chat_id, include_in_digest }) }),
  setChatCategory: (chat_id, category) => request('/chats/category', { method: 'POST', body: JSON.stringify({ chat_id, category }) }),
  summarizeChat: (chat_id) => request('/chats/summarize', { method: 'POST', body: JSON.stringify({ chat_id }) }),
  sendChatDigest: (chat_id) => request('/chats/send-digest', { method: 'POST', body: JSON.stringify({ chat_id }) }),
  getSummaries: (chatId) => request(`/chats/${encodeURIComponent(chatId)}/summaries`),
  getLatestSummaries: () => request('/summaries/latest'),
  askAboutChat: (chat_id, question, chatHistory) => request('/ai/ask-about-chat', { method: 'POST', body: JSON.stringify({ chat_id, question, chatHistory }) }),

  getActionItems: () => request('/action-items'),
  toggleActionItem: (id, completed) => request(`/action-items/${id}/toggle`, { method: 'POST', body: JSON.stringify({ completed }) }),
  toggleActionItemSaved: (id, saved_for_later, snooze_days) => request(`/action-items/${id}/toggle-save`, { method: 'POST', body: JSON.stringify({ saved_for_later, snooze_days }) }),
  setActionItemDeadline: (id, deadline) => request(`/action-items/${id}/deadline`, { method: 'POST', body: JSON.stringify({ deadline }) }),

  getScheduledMessages: () => request('/scheduled-messages'),
  createScheduledMessage: (msg) => request('/scheduled-messages', { method: 'POST', body: JSON.stringify(msg) }),
  updateScheduledMessage: (id, patch) => request(`/scheduled-messages/${id}`, { method: 'PUT', body: JSON.stringify(patch) }),
  deleteScheduledMessage: (id) => request(`/scheduled-messages/${id}`, { method: 'DELETE' }),

  getWorkerStatus: () => request('/worker/status'),
  syncWorkerConfig: () => request('/worker/sync-config', { method: 'POST' }),

  getContacts: () => request('/contacts'),
  createContact: (contact) => request('/contacts', { method: 'POST', body: JSON.stringify(contact) }),
  deleteContact: (id) => request(`/contacts/${id}`, { method: 'DELETE' }),

  getFaqs: () => request('/faq'),
  createFaq: (faq) => request('/faq', { method: 'POST', body: JSON.stringify(faq) }),
  updateFaq: (id, patch) => request(`/faq/${id}`, { method: 'PUT', body: JSON.stringify(patch) }),
  deleteFaq: (id) => request(`/faq/${id}`, { method: 'DELETE' }),

  getApprovalQueue: () => request('/approval-queue'),
  approveQueueItem: (id, editedText) => request(`/approval-queue/${id}/approve`, { method: 'POST', body: JSON.stringify({ editedText }) }),
  rejectQueueItem: (id) => request(`/approval-queue/${id}/reject`, { method: 'POST' }),
  toggleAutoReply: (enabled) => request('/auto-reply/toggle', { method: 'POST', body: JSON.stringify({ enabled }) }),
  toggleLiveInsights: (enabled) => request('/live-insights/toggle', { method: 'POST', body: JSON.stringify({ enabled }) }),
  syncMessagesNow: () => request('/message-listener/sync-now', { method: 'POST' }),
  startHistoryScan: (opts) => request('/history-scan/start', { method: 'POST', body: JSON.stringify(opts) }),
  getHistoryScanStatus: () => request('/history-scan/status'),

  getSyncConfig: () => request('/sync/config'),
  getSyncLog: () => request('/sync/log'),
  runSync: () => request('/sync/run', { method: 'POST' }),

  sendBriefingNow: () => request('/briefing/send', { method: 'POST' }),
  checkPhone: (phone) => request('/check-phone', { method: 'POST', body: JSON.stringify({ phone }) })
};
