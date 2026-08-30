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
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [scanDays, setScanDays] = useState(7);
  const [scanning, setScanning] = useState(false);
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
    setScanning(true);
    try {
      const result = await api.runHistoryScan(scanDays);
      toast(`נסרקו ${result.chatsScanned} צ'אטים (${result.messagesScanned} הודעות) · ${result.itemsAdded} משימות חדשות נמצאו`, 'success');
      await load();
    } catch (err) { toast(err.message, 'error'); } finally { setScanning(false); }
  }

  async function toggleComplete(item) {
    try { await api.toggleActionItem(item.id, !item.completed); await load(); } catch (err) { toast(err.message, 'error'); }
  }

  async function toggleSaved(item) {
    try { await api.toggleActionItemSaved(item.id, !item.saved_for_later); await load(); } catch (err) { toast(err.message, 'error'); }
  }

  const filtered = items.filter(i => {
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
            </select>
            <button className="btn" onClick={handleHistoryScan} disabled={scanning}>
              {scanning ? 'סורק...' : '🔍 נתח היסטוריה'}
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

      <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', marginTop: -18, marginBottom: 18 }}>
        כשההאזנה פעילה, כל הודעה נכנסת (בקבוצות ובצ'אטים אישיים) נבדקת אוטומטית ברקע — כשהתור ריק היא נבדקת כל כמה שניות, וכשמצטברות כמה הודעות ביחד היא מרוקנת אותן ברצף מהיר. "סנכרן עכשיו" מריק את התור מיידית בלי לחכות, כולל כל מה שהצטבר מאז הפעם האחרונה (Green API שומר את התור גם כשההאזנה כבויה, לזמן מוגבל).
        "נתח היסטוריה" הוא נפרד — הוא סורק את כל מי שפנה אליך (קבוצות וגם צ'אטים אישיים) בטווח הימים שבחרת, גם אם ההאזנה החיה הייתה כבויה כל הזמן הזה. ייתכנו משימות כפולות אם הטווחים חופפים — פשוט תסמן אותן כבוצעו.
      </p>

      <div style={{ display: 'flex', gap: 8, marginBottom: 18 }}>
        {[['active', 'פעילות'], ['saved', 'שמורות להמשך'], ['completed', 'בוצעו']].map(([key, label]) => (
          <button key={key} className="btn btn-sm" style={filter === key ? { background: 'var(--accent-primary-glow)', color: 'var(--accent-primary)', borderColor: 'rgba(79,70,229,0.2)' } : {}} onClick={() => setFilter(key)}>
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
                  <SortTh label="#" sortKey="id" currentKey={sortKey} currentDir={sortDir} onSort={requestSort} />
                  <SortTh label="משימה" sortKey="task" currentKey={sortKey} currentDir={sortDir} onSort={requestSort} />
                  <SortTh label="קבוצה / מקור" sortKey="chat_id" currentKey={sortKey} currentDir={sortDir} onSort={requestSort} />
                  <SortTh label="אחראי" sortKey="assignee" currentKey={sortKey} currentDir={sortDir} onSort={requestSort} />
                  <SortTh label="תאריך יעד" sortKey="deadline" currentKey={sortKey} currentDir={sortDir} onSort={requestSort} />
                  <SortTh label="נוצר" sortKey="created_at" currentKey={sortKey} currentDir={sortDir} onSort={requestSort} />
                  <th>סטטוס</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {sorted.map(item => (
                  <tr key={item.id}>
                    <td className="row-id">#{item.id}</td>
                    <td style={item.completed ? { textDecoration: 'line-through', color: 'var(--text-muted)' } : {}}>{item.task}</td>
                    <td>{chatName(item.chat_id)}</td>
                    <td>{item.assignee || '—'}</td>
                    <td>{item.deadline || '—'}</td>
                    <td style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>{new Date(item.created_at).toLocaleString('he-IL')}</td>
                    <td>
                      <input type="checkbox" checked={item.completed} onChange={() => toggleComplete(item)} style={{ width: 18, height: 18 }} />
                    </td>
                    <td>
                      {!item.completed && (
                        <button className="btn btn-sm" onClick={() => toggleSaved(item)}>
                          {item.saved_for_later ? 'החזר לפעילות' : 'שמור להמשך'}
                        </button>
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
