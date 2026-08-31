import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { useToast } from '../components/Toast.jsx';
import SortTh from '../components/SortTh.jsx';
import { useSort } from '../hooks/useSort.js';

export default function TasksPage() {
  const [items, setItems] = useState([]);
  const [chats, setChats] = useState([]);
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
  const [pendingIds, setPendingIds] = useState([]); // ids checked but not yet applied
  const [applying, setApplying] = useState(false);
  const toast = useToast();

  async function load() {
    setLoading(true);
    try {
      const [a, c, s] = await Promise.all([api.getActionItems(), api.getChats(), api.getSettings()]);
      setItems(a);
      setChats(c);
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

  // Checking a box just marks it "pending" — nothing is sent to the server
  // until "בצע" is clicked, so checking several rows in a row doesn't fire
  // an API call (and a toast) per click.
  function togglePending(id) {
    setPendingIds(prev => (prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]));
  }

  async function handleApplyPending() {
    setApplying(true);
    try {
      for (const id of pendingIds) {
        const item = items.find(i => i.id === id);
        if (item) await api.toggleActionItem(id, !item.completed);
      }
      setPendingIds([]);
      await load();
    } catch (err) { toast(err.message, 'error'); } finally { setApplying(false); }
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

  const filtered = items.filter(i => {
    if (directionFilter !== 'all' && (i.direction || 'my_action') !== directionFilter) return false;
    if (filter === 'completed') return i.completed;
    if (filter === 'saved') return i.saved_for_later && !i.completed;
    return !i.completed && !i.saved_for_later;
  });

  const { sorted, sortKey, sortDir, requestSort } = useSort(filtered, 'created_at', 'desc');

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
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
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
          <label style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: '0.88rem', fontWeight: 600 }}>
            🎧 האזנה חיה {settings.liveInsightsEnabled ? 'פעילה' : 'כבויה'}
            <label className="switch">
              <input type="checkbox" checked={!!settings.liveInsightsEnabled} onChange={handleToggleLiveInsights} />
              <span className="slider"></span>
            </label>
          </label>
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 18, flexWrap: 'wrap', marginBottom: 10, fontSize: '0.85rem' }}>
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

      <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', marginTop: 0, marginBottom: 10 }}>
        כשההאזנה פעילה, כל הודעה נכנסת (בקבוצות ובצ'אטים אישיים) נבדקת אוטומטית ברקע — כשהתור ריק היא נבדקת כל כמה שניות, וכשמצטברות כמה הודעות ביחד היא מרוקנת אותן ברצף מהיר. "סנכרן עכשיו" מריק את התור מיידית בלי לחכות, כולל כל מה שהצטבר מאז הפעם האחרונה (Green API שומר את התור גם כשההאזנה כבויה, לזמן מוגבל).
        "נתח היסטוריה" סורק את הפלחים שנבחרו ומחפש בכל אחד שאלות שחוזרות על עצמן, כדי להציע שאלות נפוצות (FAQ) ללשונית "תור אישור תגובות". ביטול "גם ליצור משימות" מריץ רק את איסוף השאלות לאפיון — הרבה יותר מהיר, בלי ליצור משימות לפניות ישנות. משימות כפולות מדולגות אוטומטית.
      </p>

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
        {pendingIds.length > 0 && (
          <>
            <button className="btn btn-sm btn-success" onClick={handleApplyPending} disabled={applying}>
              {applying ? 'מבצע...' : `✅ בצע (${pendingIds.length})`}
            </button>
            <button className="btn btn-sm" onClick={() => setPendingIds([])} disabled={applying}>✖ נקה בחירה</button>
          </>
        )}
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
                  <SortTh label="#" sortKey="id" currentKey={sortKey} currentDir={sortDir} onSort={requestSort} />
                  <SortTh label="משימה" sortKey="task" currentKey={sortKey} currentDir={sortDir} onSort={requestSort} />
                  <SortTh label="קטגוריה" sortKey="category" currentKey={sortKey} currentDir={sortDir} onSort={requestSort} />
                  <SortTh label="קבוצה / מקור" sortKey="chat_id" currentKey={sortKey} currentDir={sortDir} onSort={requestSort} />
                  <SortTh label="אחראי" sortKey="assignee" currentKey={sortKey} currentDir={sortDir} onSort={requestSort} />
                  <SortTh label="תאריך ביצוע" sortKey="deadline" currentKey={sortKey} currentDir={sortDir} onSort={requestSort} />
                  <SortTh label="נוצר" sortKey="created_at" currentKey={sortKey} currentDir={sortDir} onSort={requestSort} />
                  <th>סטטוס</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {sorted.map(item => (
                  <tr key={item.id}>
                    <td className="row-id">#{item.id}</td>
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
                      {item.chat_id?.endsWith('@c.us') && chatName(item.chat_id) === item.chat_id
                        ? `שיחה עם ${item.assignee || item.chat_id}`
                        : chatName(item.chat_id)}
                    </td>
                    <td>{item.assignee || '—'}</td>
                    <td>
                      <input
                        type="date"
                        dir="ltr"
                        className="form-input"
                        style={{ padding: '4px 6px', fontSize: '0.8rem', width: 140 }}
                        value={item.deadline || ''}
                        onChange={e => handleDeadlineChange(item, e.target.value)}
                      />
                      {item.deadline && (
                        <a href={outlookCalendarUrl(item)} target="_blank" rel="noreferrer" title="הוסף ליומן Outlook" style={{ marginRight: 6 }}>📅</a>
                      )}
                      {item.deadline && !item.saved_for_later && new Date(`${item.deadline}T00:00:00`) > new Date().setHours(0, 0, 0, 0) && (
                        <button
                          type="button"
                          className="btn-icon"
                          title="הוסף תזכורת — תופיע בתדרוך הבוקר ביום היעד"
                          style={{ marginRight: 6, background: 'none', border: 'none', cursor: 'pointer' }}
                          onClick={() => handleSetReminder(item)}
                        >🔔</button>
                      )}
                    </td>
                    <td style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>{new Date(item.created_at).toLocaleString('he-IL')}</td>
                    <td>
                      <input
                        type="checkbox"
                        checked={pendingIds.includes(item.id) ? !item.completed : item.completed}
                        onChange={() => togglePending(item.id)}
                        style={{ width: 18, height: 18, outline: pendingIds.includes(item.id) ? '2px solid var(--accent-warning)' : 'none' }}
                      />
                    </td>
                    <td>
                      {!item.completed && (
                        item.saved_for_later ? (
                          <button className="btn btn-sm" onClick={() => handleUnsnooze(item)} title={item.snoozed_until ? `יחזור אוטומטית ב-${new Date(item.snoozed_until).toLocaleDateString('he-IL')}` : ''}>
                            החזר לפעילות
                          </button>
                        ) : (
                          <select
                            className="form-select"
                            style={{ padding: '5px 8px', fontSize: '0.78rem', width: 'auto' }}
                            value=""
                            onChange={(e) => { if (e.target.value) handleSnooze(item, Number(e.target.value)); }}
                          >
                            <option value="">שמור להמשך...</option>
                            <option value="1">תזכיר לי מחר</option>
                            <option value="3">בעוד 3 ימים</option>
                            <option value="5">בעוד 5 ימים</option>
                            <option value="7">בעוד שבוע</option>
                          </select>
                        )
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}
