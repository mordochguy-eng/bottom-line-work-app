import { useEffect, useState, useMemo, Fragment } from 'react';
import { api } from '../api.js';
import { useToast } from '../components/Toast.jsx';
import SortTh from '../components/SortTh.jsx';
import { useSort } from '../hooks/useSort.js';

export default function TasksPage() {
  const [items, setItems] = useState([]);
  const [chats, setChats] = useState([]);
  const [contacts, setContacts] = useState([]);
  const [settings, setSettings] = useState({});
  const [filter, setFilter] = useState('active'); // active | saved | completed
  const [directionFilter, setDirectionFilter] = useState('all'); // all | waiting_on_them | my_action
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [scanDays, setScanDays] = useState(7);
  const [scanLimit, setScanLimit] = useState(0);
  const [scanSegments, setScanSegments] = useState({ namedAndGroups: true, unsavedIndividuals: true });
  const [scanExtractTasks, setScanExtractTasks] = useState(true);
  const [scanStatus, setScanStatus] = useState(null);
  const [showAdvancedScan, setShowAdvancedScan] = useState(false);
  // Groups are open by default (the point of grouping is to see everything
  // at once with a clear indent, not to hide it) — this tracks which ones
  // were manually collapsed, so the common case needs zero state.
  const [collapsedContacts, setCollapsedContacts] = useState(new Set());
  const toast = useToast();

  async function load() {
    setLoading(true);
    try {
      const [a, c, ct, s] = await Promise.all([api.getActionItems(), api.getChats(), api.getWhatsappContacts(), api.getSettings()]);
      setItems(a);
      setChats(c);
      setContacts(ct);
      setSettings(s);
    } catch (err) { toast(err.message, 'error'); } finally { setLoading(false); }
  }

  useEffect(() => { load(); }, []);

  // Resume watching an already-running scan (e.g. after a page reload).
  useEffect(() => {
    api.getHistoryScanStatus().then(s => { if (s.running) { setScanStatus(s); pollScanStatus(); } }).catch(() => {});
  }, []);

  function pollScanStatus() {
    const interval = setInterval(async () => {
      try {
        const s = await api.getHistoryScanStatus();
        setScanStatus(s);
        if (!s.running) {
          clearInterval(interval);
          if (s.error) toast(`הסריקה נכשלה: ${s.error}`, 'error');
          else toast(`נסרקו ${s.chatsScanned}/${s.chatsAttempted} צ'אטים · ${s.itemsAdded} משימות חדשות · ${s.faqSuggestionsAdded} הצעות שאלה נפוצה`, 'success');
          load();
        }
      } catch (err) {
        clearInterval(interval);
        toast(err.message, 'error');
      }
    }, 1500);
  }

  const chatName = (chatId) => chats.find(c => c.chat_id === chatId)?.name || chatId;
  const contactByChatId = useMemo(() => new Map(contacts.map(c => [c.chat_id, c])), [contacts]);

  // "אחראי" comes from Gemini as "who owes the action" — in a personal (1:1)
  // chat that's almost always the person on the other side of the
  // conversation, so it doubles as the contact's display name whenever
  // Green API's real phone-book has no better name for that number. In a
  // group chat it can be the group or a specific member, so it is NOT
  // treated as a contact identity there.
  //
  // isSaved distinguishes a real phone-book save (contactName) from a name
  // pulled from the conversation itself (Gemini's guess, or a self-set
  // WhatsApp profile name) — the same person you're texting could be a
  // total stranger, and the name alone doesn't tell you that.
  function contactInfo(item) {
    if (item.chat_id?.endsWith('@c.us')) {
      const known = contactByChatId.get(item.chat_id);
      if (known) return { label: known.name, isSaved: known.isSaved };
      return { label: item.assignee || item.chat_id, isSaved: false };
    }
    return { label: chatName(item.chat_id), isSaved: null }; // group — not a person
  }

  async function handleToggleLiveInsights() {
    try {
      const updated = await api.toggleLiveInsights(!settings.liveInsightsEnabled);
      setSettings(updated);
      toast(updated.liveInsightsEnabled ? 'האזנה חיה להודעות נכנסות הופעלה' : 'האזנה חיה הושבתה', 'info');
    } catch (err) { toast(err.message, 'error'); }
  }

  async function handleSyncNow() {
    setSyncing(true);
    try {
      const result = await api.syncMessagesNow();
      if (result.consumed === 0) {
        toast('אין הודעות חדשות בתור — הכול מעודכן', 'info');
      } else {
        toast(`נבדקו ${result.consumed} הודעות · ${result.insightsAdded} משימות חדשות · ${result.repliesQueued} טיוטות מענה חדשות`, 'success');
      }
      await load();
    } catch (err) { toast(err.message, 'error'); } finally { setSyncing(false); }
  }

  async function handleHistoryScan() {
    const segmentKeys = Object.entries(scanSegments).filter(([, on]) => on).map(([key]) => key);
    if (segmentKeys.length === 0) { toast('בחר לפחות פלח אחד לסריקה', 'error'); return; }
    try {
      const s = await api.startHistoryScan({ days: scanDays, limit: scanLimit || null, segmentKeys, extractTasks: scanExtractTasks });
      setScanStatus(s);
      pollScanStatus();
    } catch (err) { toast(err.message, 'error'); }
  }

  // Checking the box completes the task immediately and it drops off the
  // active list right away — no separate confirm step for the common case
  // of finishing one task at a time.
  async function handleToggleComplete(item) {
    try {
      await api.toggleActionItem(item.id, !item.completed);
      await load();
    } catch (err) { toast(err.message, 'error'); }
  }

  async function handleSnooze(item, days) {
    try {
      await api.toggleActionItemSaved(item.id, true, days);
      toast('נשמר להמשך — יחזור לרשימה הפעילה בעוד ' + days + ' ימים, וגם יוזכר בתדרוך הבוקר', 'info');
      await load();
    } catch (err) { toast(err.message, 'error'); }
  }

  async function handleUnsnooze(item) {
    try { await api.toggleActionItemSaved(item.id, false); await load(); } catch (err) { toast(err.message, 'error'); }
  }

  // A manually-typed 2-digit year (e.g. "26") comes back from the native
  // date input zero-padded as "0026" — treat anything under 100 as a
  // shorthand for the 2000s rather than a literal year 26 AD.
  function normalizeDeadlineYear(value) {
    if (!value) return value;
    const [y, m, d] = value.split('-');
    if (!y || !m || !d) return value;
    const year = parseInt(y, 10);
    if (year >= 100) return value;
    return `${year + 2000}-${m}-${d}`;
  }

  async function handleDeadlineChange(item, value) {
    try {
      const normalized = normalizeDeadlineYear(value);
      const updated = await api.setActionItemDeadline(item.id, normalized || null);
      setItems(prev => prev.map(i => (i.id === item.id ? updated : i)));
    } catch (err) { toast(err.message, 'error'); }
  }

  // Reuses the existing "שמור להמשך" resurface mechanism, but targets the
  // task's own deadline instead of a fixed N-days-from-now — so it pops
  // back up in the morning WhatsApp briefing exactly on the day you chose,
  // ahead of the automatic 48-hour-window reminder.
  async function handleSetReminder(item) {
    const days = Math.ceil((new Date(`${item.deadline}T00:00:00`) - new Date().setHours(0, 0, 0, 0)) / 86400000);
    try {
      await api.toggleActionItemSaved(item.id, true, Math.max(days, 1));
      toast(`🔔 תזכורת תופיע בתדרוך הבוקר ב-${item.deadline}`, 'info');
      await load();
    } catch (err) { toast(err.message, 'error'); }
  }

  // Universal deep link (works for Office 365 / Outlook web) — no download,
  // no backend involved, just opens a pre-filled event compose screen.
  function outlookCalendarUrl(item) {
    const start = new Date(`${item.deadline}T09:00:00`);
    const end = new Date(start.getTime() + 30 * 60000);
    const fmt = (d) => d.toISOString().replace(/\.\d{3}Z$/, '');
    const params = new URLSearchParams({
      path: '/calendar/action/compose',
      rru: 'addevent',
      subject: item.task,
      startdt: fmt(start),
      enddt: fmt(end),
      body: [chatName(item.chat_id), item.assignee ? `אחראי: ${item.assignee}` : null].filter(Boolean).join(' | ')
    });
    return `https://outlook.office.com/calendar/0/deeplink/compose?${params.toString()}`;
  }

  // wa.me only knows how to open a chat by phone number — there's no public
  // deep link to jump straight into an existing group, so this is
  // individuals only (returns null for a group chat_id).
  function whatsappUrl(chatId) {
    if (!chatId?.endsWith('@c.us')) return null;
    const digits = chatId.replace('@c.us', '');
    return `https://wa.me/${digits}`;
  }

  async function handleCompleteGroup(members) {
    const toComplete = members.filter(m => !m.completed);
    if (toComplete.length === 0) return;
    try {
      for (const m of toComplete) await api.toggleActionItem(m.id, true);
      toast(`${toComplete.length} משימות סומנו כבוצעו`, 'success');
      await load();
    } catch (err) { toast(err.message, 'error'); }
  }

  function toggleCollapseContact(chatId) {
    setCollapsedContacts(prev => {
      const next = new Set(prev);
      if (next.has(chatId)) next.delete(chatId); else next.add(chatId);
      return next;
    });
  }

  // A small icon next to a person's name showing whether it's a verified
  // phone-book contact or just a name pulled from the conversation/profile.
  function ContactBadge({ isSaved }) {
    if (isSaved === null) return null; // group chat — not applicable
    return (
      <span
        title={isSaved ? 'איש קשר שמור' : 'לא באנשי הקשר שלי — השם מהשיחה בלבד'}
        style={{ marginLeft: 5, fontSize: '0.85em', opacity: isSaved ? 0.9 : 1 }}
      >
        {isSaved ? '👤' : '❓'}
      </span>
    );
  }

  // A real, visible button (not a subtle emoji) — same WhatsApp-brand mark
  // used elsewhere in the app (see the "הודעה" button on the home feed).
  function WhatsAppButton({ chatId, onClick }) {
    const url = whatsappUrl(chatId);
    if (!url) return null;
    return (
      <a
        href={url}
        target="_blank"
        rel="noreferrer"
        title="פתח שיחה בוואטסאפ"
        onClick={onClick}
        className="btn btn-sm"
        style={{ border: '1px solid #25D366', color: '#25D366', background: 'transparent', display: 'inline-flex', alignItems: 'center', gap: 5, marginRight: 8, textDecoration: 'none' }}
      >
        <svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor" aria-hidden="true">
          <path d="M12.04 2c-5.46 0-9.9 4.44-9.9 9.9 0 1.75.46 3.45 1.32 4.95L2 22l5.25-1.38a9.9 9.9 0 004.79 1.22h.01c5.46 0 9.9-4.44 9.9-9.9 0-2.65-1.03-5.13-2.9-7-1.87-1.87-4.35-2.9-7-2.9zm0 18.13h-.01a8.2 8.2 0 01-4.19-1.15l-.3-.18-3.12.82.83-3.04-.2-.31a8.23 8.23 0 01-1.26-4.37c0-4.55 3.7-8.25 8.26-8.25 2.21 0 4.28.86 5.84 2.42a8.2 8.2 0 012.42 5.83c0 4.55-3.7 8.24-8.27 8.24zm4.52-6.17c-.25-.12-1.47-.72-1.69-.81-.23-.08-.39-.12-.56.13-.17.24-.64.81-.78.97-.14.17-.29.19-.53.06-.25-.12-1.05-.39-2-1.23-.74-.66-1.24-1.47-1.38-1.72-.15-.24-.02-.38.11-.5.11-.11.25-.29.37-.43.12-.15.16-.25.24-.42.08-.16.04-.31-.02-.43-.06-.12-.56-1.34-.76-1.84-.2-.48-.4-.42-.56-.42h-.48c-.16 0-.43.06-.65.31-.23.24-.85.83-.85 2.02s.87 2.35.99 2.51c.12.16 1.71 2.61 4.14 3.66.58.25 1.03.4 1.38.51.58.19 1.11.16 1.53.1.47-.07 1.47-.6 1.67-1.19.21-.58.21-1.08.15-1.19-.06-.1-.23-.16-.48-.28z"/>
        </svg>
        וואטסאפ
      </a>
    );
  }

  const filtered = items.filter(i => {
    if (directionFilter !== 'all' && (i.direction || 'my_action') !== directionFilter) return false;
    if (filter === 'completed') return i.completed;
    if (filter === 'saved') return i.saved_for_later && !i.completed;
    return !i.completed && !i.saved_for_later;
  });

  const { sorted, sortKey, sortDir, requestSort } = useSort(filtered, 'created_at', 'desc');

  // Group personal-chat items by the contact they came from — a group chat
  // (@g.us) is a room with many people in it, not "a conversation with one
  // contact", so those rows are never clustered. A contact with only one
  // open item also renders as a plain row (nothing to collapse).
  const rows = useMemo(() => {
    const perChatCount = new Map();
    for (const item of sorted) {
      if (item.chat_id?.endsWith('@c.us')) {
        perChatCount.set(item.chat_id, (perChatCount.get(item.chat_id) || 0) + 1);
      }
    }
    const seen = new Set();
    const result = [];
    for (const item of sorted) {
      const clusterable = item.chat_id?.endsWith('@c.us') && perChatCount.get(item.chat_id) > 1;
      if (!clusterable) {
        result.push({ type: 'single', item });
        continue;
      }
      if (seen.has(item.chat_id)) continue;
      seen.add(item.chat_id);
      result.push({ type: 'cluster', chatId: item.chat_id, members: sorted.filter(i => i.chat_id === item.chat_id) });
    }
    return result;
  }, [sorted]);

  function renderItemRow(item, { indented = false, clusterClass = '', isLastInCluster = false } = {}) {
    const rowClass = [indented ? 'contact-child-row' : '', clusterClass, isLastInCluster ? 'contact-cluster-last' : ''].filter(Boolean).join(' ');
    return (
      <tr key={item.id} className={rowClass}>
        <td style={indented ? { color: 'var(--text-muted)', fontSize: '0.82rem' } : {}}>
          {indented ? '↳' : (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
              <span>{contactInfo(item).label}<ContactBadge isSaved={contactInfo(item).isSaved} /></span>
              <WhatsAppButton chatId={item.chat_id} />
            </div>
          )}
        </td>
        <td style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>{new Date(item.created_at).toLocaleString('he-IL')}</td>
        <td style={item.completed ? { textDecoration: 'line-through', color: 'var(--text-muted)' } : {}}>
          {item.direction && (
            <span
              className="badge badge-warning"
              style={{ marginLeft: 6, fontSize: '0.7rem' }}
              title={item.direction === 'waiting_on_them' ? 'ממתין לתשובה מהצד השני' : 'דורש פעולה שלי'}
            >
              {item.direction === 'waiting_on_them' ? '📤 מהם' : '📥 אצלי'}
            </span>
          )}
          {item.task}
        </td>
        <td>{item.category ? <span className="badge badge-info">{item.category}</span> : '—'}</td>
        <td>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
            {/* One bordered unit instead of two separate boxes — the date
                input and the snooze/reminder select share a single frame.
                Before any deadline exists, the date box has nothing to show
                and "תאריך אחר" in the dropdown is how you'd set one anyway —
                so it's shrunk to (almost) nothing rather than sitting there
                empty. It can't be display:none, though: showPicker() only
                works on an element that's actually rendered. */}
            <div style={{ display: 'flex', alignItems: 'center', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-md, 6px)', overflow: 'hidden' }}>
              <input
                id={`deadline-input-${item.id}`}
                type="date"
                dir="ltr"
                style={item.deadline
                  ? { padding: '4px 6px', fontSize: '0.8rem', width: 130, border: 'none', background: 'transparent' }
                  : { width: 1, height: 1, padding: 0, border: 'none', opacity: 0, position: 'absolute', pointerEvents: 'none' }}
                value={item.deadline || ''}
                onChange={e => handleDeadlineChange(item, e.target.value)}
              />
              {!item.completed && !item.saved_for_later && (
                <select
                  className="form-select"
                  style={{ padding: '5px 8px', fontSize: '0.78rem', width: 'auto', border: 'none', borderRight: item.deadline ? '1px solid var(--border-color)' : 'none' }}
                  value=""
                  onChange={(e) => {
                    if (e.target.value === 'custom') {
                      const input = document.getElementById(`deadline-input-${item.id}`);
                      try { input?.showPicker?.(); } catch { input?.focus(); }
                    } else if (e.target.value) {
                      handleSnooze(item, Number(e.target.value));
                    }
                  }}
                >
                  <option value="">שמור להמשך...</option>
                  <option value="custom">📅 תאריך אחר...</option>
                  <option value="1">תזכיר לי מחר</option>
                  <option value="3">בעוד 3 ימים</option>
                  <option value="5">בעוד 5 ימים</option>
                  <option value="7">בעוד שבוע</option>
                </select>
              )}
            </div>
            {item.deadline && (
              <a href={outlookCalendarUrl(item)} target="_blank" rel="noreferrer" title="הוסף ליומן Outlook">📅</a>
            )}
            {!item.completed && (
              item.saved_for_later ? (
                <button className="btn btn-sm" onClick={() => handleUnsnooze(item)} title={item.snoozed_until ? `יחזור אוטומטית ב-${new Date(item.snoozed_until).toLocaleDateString('he-IL')}` : ''}>
                  🔔 החזר לפעילות
                </button>
              ) : (
                item.deadline && new Date(`${item.deadline}T00:00:00`) > new Date().setHours(0, 0, 0, 0) && (
                  <button
                    type="button"
                    className="btn-icon"
                    title="הוסף תזכורת — תופיע בתדרוך הבוקר ביום היעד"
                    style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '1rem' }}
                    onClick={() => handleSetReminder(item)}
                  >🔔</button>
                )
              )
            )}
          </div>
        </td>
        <td>
          <input
            type="checkbox"
            checked={item.completed}
            onChange={() => handleToggleComplete(item)}
            style={{ width: 18, height: 18 }}
          />
        </td>
      </tr>
    );
  }

  return (
    <>
      <div className="page-header">
        <div className="page-title">
          <h2>✅ משימות</h2>
          <p>משימות מסיכומי הקבוצות, ומהאזנה חיה לכל הודעה נכנסת</p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
          <button className="btn" onClick={handleSyncNow} disabled={syncing}>
            {syncing ? 'מסנכרן...' : '🔄 סנכרן עכשיו'}
          </button>
          <label style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: '0.88rem', fontWeight: 600 }}>
            🎧 האזנה חיה {settings.liveInsightsEnabled ? 'פעילה' : 'כבויה'}
            <label className="switch">
              <input type="checkbox" checked={!!settings.liveInsightsEnabled} onChange={handleToggleLiveInsights} />
              <span className="slider"></span>
            </label>
          </label>
          <button className="btn btn-sm" onClick={() => setShowAdvancedScan(p => !p)}>
            {showAdvancedScan ? '▲ ' : '▼ '}⚙️ ניתוח היסטוריה
          </button>
        </div>
      </div>

      {showAdvancedScan && (
        <div className="glass-card" style={{ marginBottom: 18, padding: 16 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', marginBottom: 14 }}>
            <select className="form-select" style={{ padding: '9px 10px', width: 'auto' }} value={scanDays} onChange={(e) => setScanDays(Number(e.target.value))}>
              <option value={1}>יום אחרון</option>
              <option value={3}>3 ימים</option>
              <option value={7}>שבוע</option>
              <option value={14}>שבועיים</option>
              <option value={30}>חודש</option>
              <option value={0}>כל ההיסטוריה</option>
            </select>
            <input
              className="form-input"
              type="number"
              min={0}
              style={{ width: 90, padding: '9px 10px' }}
              value={scanLimit}
              onChange={(e) => setScanLimit(Number(e.target.value))}
              title="מגבלת צ'אטים לבדיקה (0 = ללא הגבלה, כל הצ'אטים בשני הפלחים)"
            />
            <button className="btn" onClick={handleHistoryScan} disabled={scanStatus?.running}>
              {scanStatus?.running ? 'סורק...' : '🔍 נתח היסטוריה'}
            </button>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 18, flexWrap: 'wrap', marginBottom: 12, fontSize: '0.85rem' }}>
            <span style={{ color: 'var(--text-muted)' }}>פלחים לסריקה:</span>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <input type="checkbox" checked={scanSegments.namedAndGroups} onChange={(e) => setScanSegments(p => ({ ...p, namedAndGroups: e.target.checked }))} />
              אנשי קשר שמורים + קבוצות
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <input type="checkbox" checked={scanSegments.unsavedIndividuals} onChange={(e) => setScanSegments(p => ({ ...p, unsavedIndividuals: e.target.checked }))} />
              צ'אטים אישיים לא שמורים
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <input type="checkbox" checked={scanExtractTasks} onChange={(e) => setScanExtractTasks(e.target.checked)} />
              גם ליצור משימות (לא רק לאפיין שאלות)
            </label>
          </div>

          <p style={{ color: 'var(--text-secondary)', fontSize: '0.82rem', margin: 0 }}>
            כשההאזנה פעילה, כל הודעה נכנסת (בקבוצות ובצ'אטים אישיים) נבדקת אוטומטית ברקע — כשהתור ריק היא נבדקת כל כמה שניות, וכשמצטברות כמה הודעות ביחד היא מרוקנת אותן ברצף מהיר. "סנכרן עכשיו" מריק את התור מיידית בלי לחכות, כולל כל מה שהצטבר מאז הפעם האחרונה (Green API שומר את התור גם כשההאזנה כבויה, לזמן מוגבל).
            "נתח היסטוריה" סורק את הפלחים שנבחרו ומחפש בכל אחד שאלות שחוזרות על עצמן, כדי להציע שאלות נפוצות (FAQ) ללשונית "תור אישור תגובות". ביטול "גם ליצור משימות" מריץ רק את איסוף השאלות לאפיון — הרבה יותר מהיר, בלי ליצור משימות לפניות ישנות. משימות כפולות מדולגות אוטומטית.
          </p>
        </div>
      )}

      {scanStatus && (scanStatus.running || scanStatus.finishedAt) && (
        <div className="glass-card" style={{ marginBottom: 18, padding: 16 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.85rem', marginBottom: 8 }}>
            <span>{scanStatus.running ? '🔍 סורק היסטוריה...' : scanStatus.error ? '❌ הסריקה נכשלה' : '✅ הסריקה הושלמה'}</span>
            <span>{scanStatus.chatsScanned}/{scanStatus.chatsAttempted} צ'אטים · {scanStatus.itemsAdded} משימות · {scanStatus.faqSuggestionsAdded || 0} הצעות FAQ</span>
          </div>
          <div style={{ background: 'var(--bg-tertiary)', borderRadius: 6, height: 8, overflow: 'hidden' }}>
            <div style={{
              width: `${scanStatus.chatsAttempted ? Math.round((scanStatus.chatsScanned / scanStatus.chatsAttempted) * 100) : 0}%`,
              background: scanStatus.error ? 'var(--accent-danger)' : 'var(--accent-primary)',
              height: '100%', transition: 'width 0.3s ease'
            }} />
          </div>
        </div>
      )}

      <div style={{ display: 'flex', gap: 8, marginBottom: 12, alignItems: 'center', flexWrap: 'wrap' }}>
        {[['active', 'פעילות'], ['saved', 'שמורות להמשך'], ['completed', 'בוצעו']].map(([key, label]) => (
          <button key={key} className="btn btn-sm" style={filter === key ? { background: 'var(--accent-primary-glow)', color: 'var(--accent-primary)', borderColor: 'rgba(79,70,229,0.2)' } : {}} onClick={() => setFilter(key)}>
            {label}
          </button>
        ))}
        <span style={{ width: 1, height: 20, background: 'var(--border-color)', margin: '0 4px' }} />
        {[['all', 'הכל'], ['my_action', '📥 לטיפולי'], ['waiting_on_them', '📤 ממתין מהם']].map(([key, label]) => (
          <button key={key} className="btn btn-sm" style={directionFilter === key ? { background: 'var(--accent-warning-glow, rgba(180,83,9,0.1))', color: 'var(--accent-warning)', borderColor: 'rgba(180,83,9,0.25)' } : {}} onClick={() => setDirectionFilter(key)}>
            {label}
          </button>
        ))}
      </div>

      <div className="glass-card">
        {loading ? (
          <div className="empty-state">טוען...</div>
        ) : sorted.length === 0 ? (
          <div className="empty-state">
            <div className="empty-state-icon">✅</div>
            <p>אין משימות בקטגוריה זו.</p>
          </div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table className="data-table">
              <thead>
                <tr>
                  <SortTh label="איש קשר" sortKey="assignee" currentKey={sortKey} currentDir={sortDir} onSort={requestSort} />
                  <SortTh label="נוצר" sortKey="created_at" currentKey={sortKey} currentDir={sortDir} onSort={requestSort} />
                  <SortTh label="משימה" sortKey="task" currentKey={sortKey} currentDir={sortDir} onSort={requestSort} />
                  <SortTh label="קטגוריה" sortKey="category" currentKey={sortKey} currentDir={sortDir} onSort={requestSort} />
                  <SortTh label="יעד ותזכורת" sortKey="deadline" currentKey={sortKey} currentDir={sortDir} onSort={requestSort} />
                  <th>סטטוס</th>
                </tr>
              </thead>
              <tbody>
                {(() => {
                  let clusterIndex = 0;
                  return rows.map(row => {
                    if (row.type === 'single') return renderItemRow(row.item);

                    const { chatId, members } = row;
                    const clusterClass = clusterIndex % 2 === 0 ? 'contact-cluster-a' : 'contact-cluster-b';
                    clusterIndex++;
                    const isOpen = !collapsedContacts.has(chatId);
                    const info = contactInfo(members[0]);
                    const overdueCount = members.filter(m => !m.completed && m.deadline && new Date(`${m.deadline}T00:00:00`) < new Date().setHours(0, 0, 0, 0)).length;
                    return (
                      <Fragment key={`group-${chatId}`}>
                        <tr className={`contact-group-row ${clusterClass}`} onClick={() => toggleCollapseContact(chatId)}>
                          <td>
                            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                              <span>
                                <span className={`contact-group-chevron ${isOpen ? 'open' : ''}`}>▶</span>
                                {info.label}<ContactBadge isSaved={info.isSaved} />
                              </span>
                              <WhatsAppButton chatId={chatId} onClick={e => e.stopPropagation()} />
                            </div>
                          </td>
                          <td colSpan={5} style={{ color: 'var(--text-muted)', fontSize: '0.82rem' }}>
                            <span className="badge badge-info" style={{ marginLeft: 8 }}>{members.length} פניות</span>
                            {overdueCount > 0 && <span className="badge badge-danger" style={{ marginLeft: 8 }}>{overdueCount} באיחור</span>}
                            {isOpen ? 'לחץ לכיווץ' : 'לחץ להרחבה'}
                            {members.some(m => !m.completed) && (
                              <button
                                className="btn btn-sm btn-success"
                                style={{ marginRight: 12 }}
                                onClick={e => { e.stopPropagation(); handleCompleteGroup(members); }}
                              >
                                ✅ סמן הכל כבוצע
                              </button>
                            )}
                          </td>
                        </tr>
                        {isOpen && members.map((member, i) => renderItemRow(member, { indented: true, clusterClass, isLastInCluster: i === members.length - 1 }))}
                      </Fragment>
                    );
                  });
                })()}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}
