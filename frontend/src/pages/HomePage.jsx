import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { useToast } from '../components/Toast.jsx';

export default function HomePage() {
  const [chats, setChats] = useState([]);
  const [summaries, setSummaries] = useState([]);
  const [actionItems, setActionItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const toast = useToast();

  async function load() {
    setLoading(true);
    try {
      const [c, s, a] = await Promise.all([api.getChats(), api.getLatestSummaries(), api.getActionItems()]);
      setChats(c);
      setSummaries(s);
      setActionItems(a);
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, []);

  const tracked = chats.filter(c => c.is_tracked);
  const summaryByChatId = Object.fromEntries(summaries.map(s => [s.chat_id, s]));
  const openCount = (chatId) => actionItems.filter(a => a.chat_id === chatId && !a.completed).length;

  if (loading) return <div className="empty-state">טוען...</div>;

  return (
    <>
      <div className="page-header">
        <div className="page-title">
          <h2>🏠 דף הבית</h2>
          <p>סיכום מצב הקבוצות שלך במעקב</p>
        </div>
      </div>

      {tracked.length === 0 ? (
        <div className="glass-card empty-state">
          <div className="empty-state-icon">💬</div>
          <p>עדיין אין קבוצות במעקב. עבור ללשונית "קבוצות מעקב" כדי להתחיל.</p>
        </div>
      ) : (
        <div className="feed-grid">
          {tracked.map(chat => {
            const summary = summaryByChatId[chat.chat_id];
            return (
              <div key={chat.chat_id} className="glass-card">
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 10 }}>
                  <strong style={{ fontSize: '1.05rem' }}>{chat.name}</strong>
                  {openCount(chat.chat_id) > 0 && <span className="badge badge-warning">{openCount(chat.chat_id)} משימות פתוחות</span>}
                </div>
                {summary ? (
                  <>
                    <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', lineHeight: 1.6, marginBottom: 10 }}>
                      {summary.content.summary}
                    </p>
                    <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>
                      עודכן: {new Date(summary.created_at).toLocaleString('he-IL')}
                    </div>
                  </>
                ) : (
                  <p style={{ color: 'var(--text-muted)', fontSize: '0.88rem' }}>אין עדיין סיכום לקבוצה זו.</p>
                )}
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}
