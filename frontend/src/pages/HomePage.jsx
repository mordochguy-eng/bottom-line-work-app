import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { useToast } from '../components/Toast.jsx';
import Modal from '../components/Modal.jsx';
import { CATEGORIES, CATEGORY_ORDER } from '../constants/categories.js';

export default function HomePage() {
  const [chats, setChats] = useState([]);
  const [summaries, setSummaries] = useState([]);
  const [actionItems, setActionItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [cardBusy, setCardBusy] = useState({}); // chat_id -> 'summarizing' | 'sending'
  const [globalSummarizing, setGlobalSummarizing] = useState(false);
  const [globalProgress, setGlobalProgress] = useState(null);

  const [askChat, setAskChat] = useState(null); // the chat object currently open in the ask modal
  const [askMessages, setAskMessages] = useState([]);
  const [askInput, setAskInput] = useState('');
  const [asking, setAsking] = useState(false);

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

  async function handleSummarizeOne(chatId) {
    setCardBusy(p => ({ ...p, [chatId]: 'summarizing' }));
    try {
      await api.summarizeChat(chatId);
      await load();
      toast('הסיכום הופק בהצלחה', 'success');
    } catch (err) { toast(err.message, 'error'); } finally { setCardBusy(p => ({ ...p, [chatId]: null })); }
  }

  async function handleSendOne(chatId) {
    setCardBusy(p => ({ ...p, [chatId]: 'sending' }));
    try {
      await api.sendChatDigest(chatId);
      await load();
      toast('הסיכום נשלח לוואטסאפ', 'success');
    } catch (err) { toast(err.message, 'error'); } finally { setCardBusy(p => ({ ...p, [chatId]: null })); }
  }

  async function handleSummarizeAll() {
    setGlobalSummarizing(true);
    setGlobalProgress({ current: 0, total: tracked.length });
    let ok = 0;
    for (let i = 0; i < tracked.length; i++) {
      try {
        await api.summarizeChat(tracked[i].chat_id);
        ok++;
      } catch (err) {
        console.error(`summarize failed for ${tracked[i].name}:`, err.message);
      }
      setGlobalProgress({ current: i + 1, total: tracked.length });
    }
    await load();
    setGlobalSummarizing(false);
    setGlobalProgress(null);
    toast(`סוכמו ${ok}/${tracked.length} קבוצות`, 'success');
  }

  function openAsk(chat) {
    setAskChat(chat);
    setAskMessages([]);
    setAskInput('');
  }

  async function handleAsk(e) {
    e.preventDefault();
    const question = askInput.trim();
    if (!question || !askChat) return;
    const historyForBackend = askMessages.map(m => ({ role: m.role, text: m.text }));
    setAskMessages(m => [...m, { role: 'user', text: question }]);
    setAskInput('');
    setAsking(true);
    try {
      const res = await api.askAboutChat(askChat.chat_id, question, historyForBackend);
      setAskMessages(m => [...m, { role: 'assistant', text: res.answer }]);
    } catch (err) {
      toast(err.message, 'error');
      setAskMessages(m => [...m, { role: 'assistant', text: `שגיאה: ${err.message}` }]);
    } finally {
      setAsking(false);
    }
  }

  function renderCard(chat) {
    const summary = summaryByChatId[chat.chat_id];
    const cat = CATEGORIES[chat.profile_type] || CATEGORIES.general;
    const busy = cardBusy[chat.chat_id];

    return (
      <div key={chat.chat_id} className="glass-card">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 10, gap: 8 }}>
          <strong style={{ fontSize: '1.05rem' }}>{chat.name}</strong>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
            <span className={`badge ${cat.badge}`}>{cat.icon} {cat.label}</span>
            {openCount(chat.chat_id) > 0 && <span className="badge badge-danger">{openCount(chat.chat_id)} משימות</span>}
          </div>
        </div>

        {summary ? (
          <>
            <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', lineHeight: 1.6, marginBottom: 10 }}>
              {summary.content.summary}
            </p>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.78rem', color: 'var(--text-muted)', marginBottom: 12 }}>
              <span>סיכום אחרון: {new Date(summary.created_at).toLocaleString('he-IL')}</span>
              <span>{summary.is_sent ? '✅ נשלח לוואטסאפ' : '📥 טרם נשלח'}</span>
            </div>
          </>
        ) : (
          <p style={{ color: 'var(--text-muted)', fontSize: '0.88rem', marginBottom: 12 }}>אין עדיין סיכום לקבוצה זו.</p>
        )}

        <div style={{ display: 'flex', gap: 8, borderTop: '1px solid var(--border-color)', paddingTop: 12 }}>
          <button className="btn btn-sm" style={{ flexGrow: 1 }} onClick={() => openAsk(chat)}>💬 שאל</button>
          <button className="btn btn-sm btn-primary" style={{ flexGrow: 1 }} onClick={() => handleSummarizeOne(chat.chat_id)} disabled={!!busy}>
            {busy === 'summarizing' ? 'מסכם...' : '📝 סכם עכשיו'}
          </button>
          {summary && (
            <button className="btn btn-sm btn-success" style={{ flexGrow: 1 }} onClick={() => handleSendOne(chat.chat_id)} disabled={!!busy}>
              {busy === 'sending' ? 'שולח...' : '✉️ שלח'}
            </button>
          )}
        </div>
      </div>
    );
  }

  if (loading) return <div className="empty-state">טוען...</div>;

  return (
    <>
      <div className="page-header">
        <div className="page-title">
          <h2>🏠 הפיד היומי שלך</h2>
          <p>ריכוז סיכומי קבוצות הוואטסאפ במעקב</p>
        </div>
        <button className="btn btn-primary" onClick={handleSummarizeAll} disabled={globalSummarizing || tracked.length === 0}>
          {globalSummarizing ? `📝 מסכם... ${globalProgress ? `(${globalProgress.current}/${globalProgress.total})` : ''}` : '📝 סכם עכשיו'}
        </button>
      </div>

      {tracked.length === 0 ? (
        <div className="glass-card empty-state">
          <div className="empty-state-icon">💬</div>
          <p>עדיין אין קבוצות במעקב. עבור ללשונית "קבוצות מעקב" כדי להתחיל.</p>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 32 }}>
          {CATEGORY_ORDER.map(key => {
            const inCategory = tracked.filter(c => (c.profile_type || 'general') === key);
            if (inCategory.length === 0) return null;
            const cat = CATEGORIES[key];
            return (
              <div key={key}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16, borderBottom: `2px solid ${cat.color}22`, paddingBottom: 8 }}>
                  <span style={{ fontSize: '1.4rem' }}>{cat.icon}</span>
                  <h3 style={{ margin: 0, fontSize: '1.2rem', fontWeight: 800, color: cat.color }}>{cat.label}</h3>
                </div>
                <div className="feed-grid">
                  {inCategory.map(renderCard)}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {askChat && (
        <Modal title={`💬 שאל על "${askChat.name}"`} onClose={() => setAskChat(null)}>
          <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: 14 }}>
            שאל כל שאלה על תוכן הקבוצה — המערכת קוראת את ההודעות האחרונות ועונה בהתבסס עליהן בלבד.
          </p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, maxHeight: 320, overflowY: 'auto', marginBottom: 14 }}>
            {askMessages.length === 0 && (
              <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>לדוגמה: "מה סוכם לגבי התשלום?" או "מי התנדב למשימה?"</p>
            )}
            {askMessages.map((m, i) => (
              <div
                key={i}
                style={{
                  alignSelf: m.role === 'user' ? 'flex-end' : 'flex-start',
                  maxWidth: '85%',
                  background: m.role === 'user' ? 'var(--accent-primary)' : '#fff',
                  color: m.role === 'user' ? '#fff' : 'var(--text-primary)',
                  border: m.role === 'user' ? 'none' : '1px solid var(--border-color)',
                  borderRadius: 12,
                  padding: '10px 14px',
                  fontSize: '0.9rem',
                  whiteSpace: 'pre-wrap'
                }}
              >
                {m.text}
              </div>
            ))}
            {asking && <div style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>חושב...</div>}
          </div>
          <form onSubmit={handleAsk} style={{ display: 'flex', gap: 8 }}>
            <input
              className="form-input"
              placeholder="הקלד שאלה על הקבוצה..."
              value={askInput}
              onChange={(e) => setAskInput(e.target.value)}
              disabled={asking}
            />
            <button className="btn btn-primary" type="submit" disabled={asking || !askInput.trim()}>שלח</button>
          </form>
        </Modal>
      )}
    </>
  );
}
