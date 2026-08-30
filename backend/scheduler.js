// Pure scheduling logic — no I/O, fully testable

export const RETRY_BASE_DELAY_MS = 5 * 60 * 1000; // 5 minutes
export const MISSED_MESSAGE_WINDOW_HOURS = 1;

export function isDue(msg, now = new Date()) {
  if (msg.status !== 'pending') return false;
  if (msg.attempts >= msg.max_attempts) return false;
  if (new Date(msg.scheduled_at) > now) return false;
  if (msg.retry_after && new Date(msg.retry_after) > now) return false;
  return true;
}

export function isExpired(msg, now = new Date(), maxHours = MISSED_MESSAGE_WINDOW_HOURS) {
  const ageMs = now.getTime() - new Date(msg.scheduled_at).getTime();
  return ageMs > maxHours * 60 * 60 * 1000;
}

export function getNextRetryAt(msg, now = new Date()) {
  const delay = RETRY_BASE_DELAY_MS * Math.pow(2, msg.attempts - 1);
  return new Date(now.getTime() + delay).toISOString();
}

export function getNextRepeatAt(msg) {
  if (!msg.repeat) return null;
  const base = new Date(msg.scheduled_at);
  switch (msg.repeat) {
    case 'daily':   base.setDate(base.getDate() + 1); break;
    case 'weekly':  base.setDate(base.getDate() + 7); break;
    case 'monthly': base.setMonth(base.getMonth() + 1); break;
    default: return null;
  }
  return base.toISOString();
}

/** Accepts: 0521234567 / 972521234567 / +972521234567 */
export function normaliseChatId(input) {
  if (!input) return null;
  const stripped = input.trim().replace(/[\s\-()]/g, '');
  if (stripped.endsWith('@c.us') || stripped.endsWith('@g.us')) return stripped;
  let digits = stripped.replace(/^\+/, '');
  if (digits.startsWith('0')) digits = '972' + digits.slice(1);
  return `${digits}@c.us`;
}

export function hebrewTimeUntil(isoDate, now = new Date()) {
  const diff = new Date(isoDate).getTime() - now.getTime();
  const abs = Math.abs(diff);
  const past = diff < 0;
  const mins = Math.floor(abs / 60000);
  const hours = Math.floor(abs / 3600000);
  const days = Math.floor(abs / 86400000);
  let str;
  if (mins < 1) str = 'עכשיו';
  else if (mins < 60) str = `${mins} דק׳`;
  else if (hours < 24) str = `${hours} שע׳`;
  else str = `${days} יום`;
  return past ? `לפני ${str}` : `בעוד ${str}`;
}
