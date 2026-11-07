import { useEffect, useState } from 'react';
import { api } from '../api.js';

const POLL_MS = 30000;
const STALE_INCOMING_HOURS = 12;
const FAILURE_WINDOW_MS = 24 * 3600 * 1000;

const STATUS_TEXT = {
  qr: 'וואטסאפ ממתין לסריקת QR',
  loggedOut: 'החיבור נותק מהטלפון (המכשיר הוסר מהמכשירים המקושרים)',
  replaced: 'החיבור הוחלף בתהליך אחר שמשתמש באותו חיבור',
  starting: 'מתחבר לוואטסאפ...',
  reconnecting: 'החיבור נותק, מנסה להתחבר מחדש...',
  error: 'שגיאה בחיבור לוואטסאפ',
  idle: 'החיבור לוואטסאפ לא פעיל',
};

// Shown on every page while something is wrong with WhatsApp: not connected,
// the last send / read failed, or nothing has arrived for many hours.
export default function WhatsAppStatusBanner({ onOpenSettings }) {
  const [health, setHealth] = useState(null);
  const [backendDown, setBackendDown] = useState(false);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const h = await api.getWhatsappHealth();
        if (alive) { setHealth(h); setBackendDown(false); }
      } catch {
        if (alive) setBackendDown(true);
      }
    };
    load();
    const t = setInterval(load, POLL_MS);
    return () => { alive = false; clearInterval(t); };
  }, []);

  const problems = [];
  let severe = false;

  if (backendDown) {
    problems.push('שרת האפליקציה לא מגיב.');
    severe = true;
  } else if (health) {
    const now = health.serverTime || Date.now();
    if (!health.connected) {
      problems.push(`${STATUS_TEXT[health.status] || `מצב החיבור: ${health.status}`}${health.error && health.status !== 'qr' ? ` (${health.error})` : ''}. הודעות מתוזמנות, סיכומים והאזנה לא יעבדו עד שהחיבור יחזור.`);
      severe = !['starting', 'reconnecting'].includes(health.status);
    } else {
      if (health.lastSend && !health.lastSend.ok && now - health.lastSend.at < FAILURE_WINDOW_MS) {
        problems.push(`השליחה האחרונה לוואטסאפ נכשלה: ${health.lastSend.error || 'שגיאה לא ידועה'}`);
      }
      if (health.lastRead && !health.lastRead.ok && now - health.lastRead.at < FAILURE_WINDOW_MS) {
        problems.push(`קריאת נתונים מוואטסאפ נכשלה: ${health.lastRead.error || 'שגיאה לא ידועה'}`);
      }
      if (health.lastIncomingAt) {
        const hours = (now - health.lastIncomingAt) / 3600000;
        if (hours > STALE_INCOMING_HOURS) {
          problems.push(`לא התקבלו הודעות חדשות כבר ${Math.floor(hours)} שעות. ייתכן שהחיבור תקוע — נסה "התחבר מחדש" בהגדרות.`);
        }
      }
    }
  }

  const bad = problems.length > 0;
  useEffect(() => {
    const base = document.title.replace(/^⚠️ /, '');
    document.title = bad ? `⚠️ ${base}` : base;
    return () => { document.title = base; };
  }, [bad]);

  if (!bad) return null;

  const palette = severe
    ? { bg: '#fee2e2', border: '#fca5a5', color: '#991b1b' }
    : { bg: '#fef3c7', border: '#fcd34d', color: '#92400e' };

  return (
    <div
      role="alert"
      style={{
        position: 'sticky', top: 0, zIndex: 100, marginBottom: 12, padding: '10px 16px', borderRadius: 10,
        background: palette.bg, border: `1px solid ${palette.border}`, color: palette.color, fontSize: '0.9rem',
        display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
      }}
    >
      <strong>{severe ? '⚠️ וואטסאפ לא מחובר' : '⚠️ בעיה בוואטסאפ'}</strong>
      <span style={{ flex: 1 }}>{problems.join('  •  ')}</span>
      {onOpenSettings && (
        <button type="button" className="btn" style={{ padding: '4px 12px', fontSize: '0.8rem' }} onClick={onOpenSettings}>פתח הגדרות</button>
      )}
    </div>
  );
}
