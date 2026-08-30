/**
 * בשורה התחתונה — עבודה: מנוע הודעות מתוזמנות בענן
 *
 * שולח הודעות וואטסאפ מתוזמנות דרך Green API בזמן — גם כשהמחשב המקומי
 * כבוי. זה הדבר היחיד שרץ פה; שאר האפליקציה (סיכומים, משימות, האזנה
 * חיה) נשארת מקומית אצלך.
 *
 * הקובץ הזה עצמאי לגמרי — בלי import, בלי npm, בלי שלב build. אפשר
 * להדביק אותו ישירות בעורך הקוד של Cloudflare באתר (Quick Edit) ולפרסם.
 *
 * דורש (מוגדרים ב-Cloudflare Dashboard, לא בקוד):
 *  - KV namespace מחובר בשם QUEUE
 *  - משתנה סודי בשם AUTH_TOKEN (מגן על כל הבקשות ל-Worker הזה)
 *  - Cron Trigger: כל דקה ("* * * * *")
 *
 * כל בקשת HTTP חייבת לשאת: Authorization: Bearer <AUTH_TOKEN>
 */

const MESSAGES_KEY = 'messages';
const CONFIG_KEY = 'config';
const RETRY_BASE_DELAY_MS = 5 * 60 * 1000; // 5 דקות
const MISSED_MESSAGE_WINDOW_HOURS = 1;

// ---------- לוגיקת תזמון טהורה (זהה ל-scheduler.js המקומי) ----------

function isDue(msg, now) {
  if (msg.status !== 'pending') return false;
  if (msg.attempts >= msg.max_attempts) return false;
  if (new Date(msg.scheduled_at) > now) return false;
  if (msg.retry_after && new Date(msg.retry_after) > now) return false;
  return true;
}

function isExpired(msg, now) {
  const ageMs = now.getTime() - new Date(msg.scheduled_at).getTime();
  return ageMs > MISSED_MESSAGE_WINDOW_HOURS * 60 * 60 * 1000;
}

function getNextRetryAt(msg, now) {
  const delay = RETRY_BASE_DELAY_MS * Math.pow(2, msg.attempts - 1);
  return new Date(now.getTime() + delay).toISOString();
}

function getNextRepeatAt(msg) {
  if (!msg.repeat) return null;
  const base = new Date(msg.scheduled_at);
  switch (msg.repeat) {
    case 'daily': base.setDate(base.getDate() + 1); break;
    case 'weekly': base.setDate(base.getDate() + 7); break;
    case 'monthly': base.setMonth(base.getMonth() + 1); break;
    default: return null;
  }
  return base.toISOString();
}

function normaliseChatId(input) {
  if (!input) return null;
  const stripped = String(input).trim().replace(/[\s\-()]/g, '');
  if (stripped.endsWith('@c.us') || stripped.endsWith('@g.us')) return stripped;
  let digits = stripped.replace(/^\+/, '');
  if (digits.startsWith('0')) digits = '972' + digits.slice(1);
  return `${digits}@c.us`;
}

// ---------- Green API (fetch, לא axios — Workers לא תומך ב-Node APIs) ----------

function greenApiBase(config, path) {
  const cleanUrl = config.apiUrl.replace(/\/+$/, '');
  return `${cleanUrl}/waInstance${config.idInstance}/${path}/${config.apiTokenInstance}`;
}

async function greenApiPost(config, path, body) {
  const res = await fetch(greenApiBase(config, path), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!res.ok) throw new Error(`Green API ${path} failed: ${res.status} ${await res.text()}`);
  return res.json();
}

async function dispatchMessage(config, msg) {
  switch (msg.type) {
    case 'media':
      return greenApiPost(config, 'sendFileByUrl', {
        chatId: msg.chat_id, urlFile: msg.media_url, fileName: msg.media_filename || 'file', caption: msg.content || ''
      });
    case 'location':
      return greenApiPost(config, 'sendLocation', {
        chatId: msg.chat_id, latitude: msg.location?.lat, longitude: msg.location?.lng,
        nameLocation: msg.location?.name, address: msg.location?.address
      });
    case 'poll':
      return greenApiPost(config, 'sendPoll', {
        chatId: msg.chat_id, message: msg.content,
        options: (msg.poll_options || []).map(o => ({ optionName: o })),
        multipleAnswers: !!msg.poll_multiple
      });
    case 'contact':
      return greenApiPost(config, 'sendContact', {
        chatId: msg.chat_id,
        contact: { phoneContact: msg.contact?.phone, firstName: msg.contact?.firstName, lastName: msg.contact?.lastName || '' }
      });
    case 'text':
    default:
      return greenApiPost(config, 'sendMessage', { chatId: msg.chat_id, message: msg.content });
  }
}

// ---------- אחסון (KV) ----------

async function getMessages(env) {
  const raw = await env.QUEUE.get(MESSAGES_KEY);
  return raw ? JSON.parse(raw) : [];
}
async function saveMessages(env, messages) {
  await env.QUEUE.put(MESSAGES_KEY, JSON.stringify(messages));
}
async function getConfig(env) {
  const raw = await env.QUEUE.get(CONFIG_KEY);
  return raw ? JSON.parse(raw) : null;
}
function nextId(rows) {
  return rows.length > 0 ? Math.max(...rows.map(r => r.id)) + 1 : 1;
}

// ---------- הרצת התור (מופעל ע"י Cron Trigger כל דקה) ----------

async function runDispatch(env) {
  const config = await getConfig(env);
  if (!config?.apiUrl) return; // עדיין לא הוגדרו פרטי Green API

  const messages = await getMessages(env);
  const now = new Date();
  let changed = false;

  for (const msg of messages) {
    if (!isDue(msg, now)) continue;
    changed = true;

    // נבדק *לפני* ניסיון שליחה — הודעה שהתיישנה יותר משעה מסומנת "נכשל"
    // במקום להישלח באיחור.
    if (isExpired(msg, now)) {
      msg.status = 'failed';
      msg.attempts = (msg.attempts || 0) + 1;
      continue;
    }

    try {
      await dispatchMessage(config, msg);
      const nextRepeat = getNextRepeatAt(msg);
      if (nextRepeat) {
        msg.scheduled_at = nextRepeat;
        msg.attempts = 0;
        msg.retry_after = null;
        msg.status = 'pending';
      } else {
        msg.status = 'sent';
      }
    } catch (err) {
      const attempts = (msg.attempts || 0) + 1;
      msg.attempts = attempts;
      msg.status = (isExpired(msg, now) || attempts >= msg.max_attempts) ? 'failed' : 'pending';
      msg.retry_after = getNextRetryAt({ ...msg, attempts }, now);
    }
  }

  if (changed) await saveMessages(env, messages);
}

// ---------- שרת HTTP (CRUD זהה ל-API המקומי) ----------

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json; charset=utf-8' } });
}

function isAuthorized(request, env) {
  const auth = request.headers.get('Authorization') || '';
  return auth === `Bearer ${env.AUTH_TOKEN}`;
}

async function handleRequest(request, env) {
  if (!env.AUTH_TOKEN) return json({ error: 'AUTH_TOKEN לא הוגדר ב-Worker' }, 500);
  if (!isAuthorized(request, env)) return json({ error: 'לא מורשה' }, 401);

  const url = new URL(request.url);
  const parts = url.pathname.split('/').filter(Boolean); // e.g. ['messages'] or ['messages','12']

  try {
    if (parts[0] === 'config') {
      if (request.method === 'GET') {
        const config = await getConfig(env);
        return json({ configured: !!config?.apiUrl });
      }
      if (request.method === 'POST') {
        const body = await request.json();
        await env.QUEUE.put(CONFIG_KEY, JSON.stringify({
          apiUrl: body.apiUrl, idInstance: body.idInstance, apiTokenInstance: body.apiTokenInstance
        }));
        return json({ ok: true });
      }
    }

    if (parts[0] === 'messages') {
      const messages = await getMessages(env);

      if (parts.length === 1 && request.method === 'GET') {
        return json(messages);
      }

      if (parts.length === 1 && request.method === 'POST') {
        const body = await request.json();
        const entry = {
          id: nextId(messages),
          chat_id: normaliseChatId(body.chat_id),
          display_name: body.display_name || null,
          type: body.type || 'text',
          content: body.content || null,
          media_url: body.media_url || null,
          media_filename: body.media_filename || null,
          location: body.location || null,
          poll_options: body.poll_options || null,
          poll_multiple: !!body.poll_multiple,
          contact: body.contact || null,
          scheduled_at: body.scheduled_at,
          repeat: body.repeat || null,
          status: 'pending',
          attempts: 0,
          max_attempts: 3,
          retry_after: null,
          created_at: new Date().toISOString()
        };
        messages.push(entry);
        await saveMessages(env, messages);
        return json(entry);
      }

      if (parts.length === 2 && request.method === 'PUT') {
        const id = Number(parts[1]);
        const idx = messages.findIndex(m => m.id === id);
        if (idx === -1) return json({ error: 'ההודעה לא נמצאה' }, 404);
        const patch = await request.json();
        messages[idx] = { ...messages[idx], ...patch };
        await saveMessages(env, messages);
        return json(messages[idx]);
      }

      if (parts.length === 2 && request.method === 'DELETE') {
        const id = Number(parts[1]);
        await saveMessages(env, messages.filter(m => m.id !== id));
        return json({ ok: true });
      }
    }

    if (parts[0] === 'dispatch-now' && request.method === 'POST') {
      // הפעלה ידנית מיידית — שימושי לבדיקה, בלי לחכות לטריגר הבא
      await runDispatch(env);
      return json({ ok: true });
    }

    return json({ error: 'נתיב לא נמצא' }, 404);
  } catch (err) {
    return json({ error: err.message }, 500);
  }
}

export default {
  async fetch(request, env) {
    return handleRequest(request, env);
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runDispatch(env));
  }
};
