import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { useToast } from '../components/Toast.jsx';

export default function TasksPage() {
  const [items, setItems] = useState([]);
  const [chats, setChats] = useState([]);
  const [settings, setSettings] = useState({});
  const [filter, setFilter] = useState('active'); // active | saved | completed
  const [loading, setLoading] = useState(true);
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

  async function handleToggleLiveInsights() {
    try {
      const updated = await api.toggleLiveInsights(!settings.liveInsightsEnabled);
      setSettings(updated);
      toast(updated.liveInsightsEnabled ? 'האזנה חיה להודעות נכנסות הופעלה' : 'האזנה חיה הושבתה', 'info');
    } catch (err) { toast(err.message, 'error'); }
  }

  useEffect(() => { load(); }, []);

  const chatName = (chatId) => chats.find(c => c.chat_id === chatId)?.name || chatId;

  const filtered = items.filter(i => {
    if (filter === 'completed') return i.completed;
    if (filter === 'saved') return i.saved_for_later && !i.completed;
    return !i.completed && !i.saved_for_later;
  });

  async function toggleComplete(item) {
    try { await api.toggleActionItem(item.id, !item.completed); await load(); } catch (err) { toast(err.message, 'error'); }
  }

  async function toggleSaved(item) {
    try { await api.toggleActionItemSaved(item.id, !item.saved_for_later); await load(); } catch (err) { toast(err.message, 'error'); }
  }

  return (
    <>
      <div className="page-header">
        <div className="page-title">
          <h2>✅ משימות</h2>
          <p>משימות מסיכומי הקבוצות, ומהאזנה חיה לכל הודעה נכנסת</p>
        </div>
        <label style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: '0.88rem', fontWeight: 600 }}>
          🎧 האזנה חיה להודעות נכנסות {settings.liveInsightsEnabled ? 'פעילה' : 'כבויה'}
          <label className="switch">
            <input type="checkbox" checked={!!settings.liveInsightsEnabled} onChange={handleToggleLiveInsights} />
            <span className="slider"></span>
          </label>
        </label>
      </div>
      {settings.liveInsightsEnabled && (
        <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', marginTop: -18, marginBottom: 18 }}>
          כל הודעה נכנסת (בקבוצות ובצ'אטים אישיים) נבדקת אוטומטית — אם משהו דורש ממך פעולה, הוא מתווסף כאן.
        </p>
      )}

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
        ) : filtered.length === 0 ? (
          <div className="empty-state">
            <div className="empty-state-icon">✅</div>
            <p>אין משימות בקטגוריה זו.</p>
          </div>
        ) : (
          filtered.map(item => (
            <div key={item.id} className="list-row">
              <input type="checkbox" checked={item.completed} onChange={() => toggleComplete(item)} style={{ width: 18, height: 18 }} />
              <div className="list-row-main">
                <div className="list-row-title" style={item.completed ? { textDecoration: 'line-through', color: 'var(--text-muted)' } : {}}>
                  {item.task}
                </div>
                <div className="list-row-sub">
                  {chatName(item.chat_id)}
                  {item.assignee && ` · אחראי: ${item.assignee}`}
                  {item.deadline && ` · יעד: ${item.deadline}`}
                </div>
              </div>
              {!item.completed && (
                <button className="btn btn-sm" onClick={() => toggleSaved(item)}>
                  {item.saved_for_later ? 'החזר לפעילות' : 'שמור להמשך'}
                </button>
              )}
            </div>
          ))
        )}
      </div>
    </>
  );
}
