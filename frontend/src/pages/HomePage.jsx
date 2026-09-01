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
  const [search, setSearch] = useState('');
  const [expanded, setExpanded] = useState({}); // chat_id -> bool, collapsed by default to cut visual noise

  // Group detail modal — one modal, four tabs (mirrors the personal dashboard).
  const [detailChat, setDetailChat] = useState(null);
  const [detailTab, setDetailTab] = useState('summaries');
  const [detailSummaries, setDetailSummaries] = useState([]);
  const [detailMessages, setDetailMessages] = useState([]);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailBusy, setDetailBusy] = useState(null); // 'summarizing' | 'sending:<id>'
  const [mediaBusy, setMediaBusy] = useState({}); // message_id -> 'transcribe' | 'ocr'

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

  const allTracked = chats.filter(c => c.is_tracked);
  // Search only narrows what's shown — "summarize all" still means all
  // tracked groups, not just whatever the search happens to be filtering to.
  const tracked = allTracked.filter(c => !search.trim() || c.name.toLowerCase().includes(search.trim().toLowerCase()));
  const summaryByChatId = Object.fromEntries(summaries.map(s => [s.chat_id, s]));
  const openCount = (chatId) => actionItems.filter(a => a.chat_id === chatId && !a.completed).length;
  // A group "has an update" when its latest summary is newer than the last
  // time you opened its detail modal — not just "was summarized recently",
  // so it stops standing out the moment you've actually looked at it.
  function hasUpdate(chat) {
    const summary = summaryByChatId[chat.chat_id];
    if (!summary) return false;
    if (!chat.last_viewed_at) return true;
    return new Date(summary.created_at) > new Date(chat.last_viewed_at);
  }

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
    setGlobalProgress({ current: 0, total: allTracked.length });
    let ok = 0;
    for (let i = 0; i < allTracked.length; i++) {
      try {
        await api.summarizeChat(allTracked[i].chat_id);
        ok++;
      } catch (err) {
        console.error(`summarize failed for ${allTracked[i].name}:`, err.message);
      }
      setGlobalProgress({ current: i + 1, total: allTracked.length });
    }
    await load();
    setGlobalSummarizing(false);
    setGlobalProgress(null);
    toast(`סוכמו ${ok}/${allTracked.length} קבוצות`, 'success');
  }

  async function openDetail(chat, tab = 'summaries') {
    setDetailChat(chat);
    setDetailTab(tab);
    setAskMessages([]);
    setAskInput('');
    setDetailLoading(true);
    try {
      const [s, m] = await Promise.all([api.getSummaries(chat.chat_id), api.getChatMessages(chat.chat_id)]);
      setDetailSummaries(s);
      setDetailMessages(m);
      // Marks the "has a new update" highlight as read — fire-and-forget,
      // the modal itself shouldn't wait on it.
      api.markChatViewed(chat.chat_id)
        .then(updatedChat => setChats(prev => prev.map(c => (c.chat_id === chat.chat_id ? updatedChat : c))))
        .catch(() => {});
    } catch (err) { toast(err.message, 'error'); } finally { setDetailLoading(false); }
  }

  function closeDetail() {
    setDetailChat(null);
  }

  async function handleSummarizeInModal() {
    setDetailBusy('summarizing');
    try {
      await api.summarizeChat(detailChat.chat_id);
      const [s, m] = await Promise.all([api.getSummaries(detailChat.chat_id), api.getChatMessages(detailChat.chat_id)]);
      setDetailSummaries(s);
      setDetailMessages(m);
      await load();
      toast('הסיכום הופק בהצלחה', 'success');
    } catch (err) { toast(err.message, 'error'); } finally { setDetailBusy(null); }
  }

  async function handleSendSpecificSummary(summaryId) {
    setDetailBusy(`sending:${summaryId}`);
    try {
      await api.sendChatDigest(detailChat.chat_id, summaryId);
      const s = await api.getSummaries(detailChat.chat_id);
      setDetailSummaries(s);
      await load();
      toast('הסיכום נשלח לוואטסאפ', 'success');
    } catch (err) { toast(err.message, 'error'); } finally { setDetailBusy(null); }
  }

  async function handleToggleTaskInModal(item) {
    try {
      await api.toggleActionItem(item.id, !item.completed);
      await load();
    } catch (err) { toast(err.message, 'error'); }
  }

  async function handleTranscribe(msg) {
    setMediaBusy(p => ({ ...p, [msg.message_id]: 'transcribe' }));
    try {
      const updated = await api.transcribeMessage(msg.message_id);
      setDetailMessages(prev => prev.map(m => (m.message_id === msg.message_id ? updated : m)));
    } catch (err) { toast(err.message, 'error'); } finally { setMediaBusy(p => ({ ...p, [msg.message_id]: null })); }
  }

  async function handleOcr(msg) {
    setMediaBusy(p => ({ ...p, [msg.message_id]: 'ocr' }));
    try {
      const updated = await api.ocrMessage(msg.message_id);
      setDetailMessages(prev => prev.map(m => (m.message_id === msg.message_id ? updated : m)));
    } catch (err) { toast(err.message, 'error'); } finally { setMediaBusy(p => ({ ...p, [msg.message_id]: null })); }
  }

  async function handleAsk(e) {
    e.preventDefault();
    const question = askInput.trim();
    if (!question || !detailChat) return;
    const historyForBackend = askMessages.map(m => ({ role: m.role, text: m.text }));
    setAskMessages(m => [...m, { role: 'user', text: question }]);
    setAskInput('');
    setAsking(true);
    try {
      const res = await api.askAboutChat(detailChat.chat_id, question, historyForBackend);
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
    const updated = hasUpdate(chat);
    const isOpen = !!expanded[chat.chat_id];

    return (
      <div key={chat.chat_id} className="glass-card" style={updated ? { borderRight: '4px solid var(--accent-warning)', background: 'rgba(180, 83, 9, 0.04)' } : undefined}>
        <div style={{ cursor: 'pointer' }} onClick={() => setExpanded(p => ({ ...p, [chat.chat_id]: !p[chat.chat_id] }))}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 10, gap: 8 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
              <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)', flexShrink: 0 }}>{isOpen ? '▾' : '◂'}</span>
              <strong
                style={{ fontSize: '1.05rem', cursor: 'pointer' }}
                onClick={(e) => { e.stopPropagation(); openDetail(chat, 'summaries'); }}
                title="פתח פרטי קבוצה"
              >
                {chat.name}
              </strong>
            </div>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
              {updated && <span className="badge badge-warning">🆕 עדכון חדש</span>}
              <span className={`badge ${cat.badge}`}>{cat.icon} {cat.label}</span>
              {openCount(chat.chat_id) > 0 && <span className="badge badge-danger">{openCount(chat.chat_id)} משימות</span>}
            </div>
          </div>

          {summary ? (
            <>
              <p style={{
                color: 'var(--text-secondary)', fontSize: '0.9rem', lineHeight: 1.6, marginBottom: 10,
                ...(isOpen ? {} : { whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' })
              }}>
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
        </div>

        <div style={{ display: 'flex', gap: 8, borderTop: '1px solid var(--border-color)', paddingTop: 12 }}>
          <button className="btn btn-sm" style={{ flexGrow: 1 }} onClick={() => openDetail(chat, 'ask')}>💬 שאל</button>
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

  const detailTasks = detailChat ? actionItems.filter(a => a.chat_id === detailChat.chat_id).sort((a, b) => (a.completed - b.completed) || (b.id - a.id)) : [];
  const detailMedia = detailMessages.filter(m => m.type === 'audio' || m.type === 'image');

  return (
    <>
      <div className="page-header">
        <div className="page-title">
          <h2>🏠 הפיד היומי שלך</h2>
          <p>ריכוז סיכומי קבוצות הוואטסאפ במעקב</p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <input
            className="form-input"
            placeholder="🔍 חפש קבוצה/לקוח לפי שם..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{ width: 240 }}
          />
          <button className="btn btn-primary" onClick={handleSummarizeAll} disabled={globalSummarizing || allTracked.length === 0}>
            {globalSummarizing ? `📝 מסכם... ${globalProgress ? `(${globalProgress.current}/${globalProgress.total})` : ''}` : '📝 סכם עכשיו'}
          </button>
        </div>
      </div>

      {allTracked.length === 0 ? (
        <div className="glass-card empty-state">
          <div className="empty-state-icon">💬</div>
          <p>עדיין אין קבוצות במעקב. עבור ללשונית "קבוצות מעקב" כדי להתחיל.</p>
        </div>
      ) : tracked.length === 0 ? (
        <div className="glass-card empty-state">
          <div className="empty-state-icon">🔍</div>
          <p>לא נמצאו קבוצות התואמות ל"{search}".</p>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 32 }}>
          {CATEGORY_ORDER.map(key => {
            // Groups with a new update float to the top of their own
            // category — never across categories, so the existing
            // customer/distribution/info grouping stays intact.
            const inCategory = tracked
              .filter(c => (c.profile_type || 'general') === key)
              .sort((a, b) => (hasUpdate(b) ? 1 : 0) - (hasUpdate(a) ? 1 : 0));
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

      {detailChat && (
        <Modal title={detailChat.name} onClose={closeDetail} maxWidth={900}>
          <div className="type-btn-group" style={{ marginBottom: 18 }}>
            <button className={`type-btn ${detailTab === 'summaries' ? 'active' : ''}`} onClick={() => setDetailTab('summaries')}>
              📝 סיכומים ({detailSummaries.length})
            </button>
            <button className={`type-btn ${detailTab === 'tasks' ? 'active' : ''}`} onClick={() => setDetailTab('tasks')}>
              📋 משימות ({detailTasks.length})
            </button>
            <button className={`type-btn ${detailTab === 'media' ? 'active' : ''}`} onClick={() => setDetailTab('media')}>
              🎙️ הודעות מולטימדיה / קוליות
            </button>
            <button className={`type-btn ${detailTab === 'ask' ? 'active' : ''}`} onClick={() => setDetailTab('ask')}>
              💬 שאל על הקבוצה
            </button>
          </div>

          {detailLoading ? (
            <div className="empty-state">טוען...</div>
          ) : (
            <>
              {detailTab === 'summaries' && (
                <div>
                  {detailSummaries.length === 0 ? (
                    <div className="empty-state">
                      <p>אין סיכומים עבור קבוצה זו עדיין.</p>
                      <button className="btn btn-primary" style={{ marginTop: 14 }} onClick={handleSummarizeInModal} disabled={detailBusy === 'summarizing'}>
                        {detailBusy === 'summarizing' ? 'מסכם...' : 'סכם עכשיו'}
                      </button>
                    </div>
                  ) : (
                    detailSummaries.map((sum, index) => (
                      <div key={sum.id} className="glass-card" style={{ marginBottom: 16, borderRight: index === 0 ? '4px solid var(--accent-primary)' : '1px solid var(--border-color)' }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14, borderBottom: '1px solid var(--border-color)', paddingBottom: 10, flexWrap: 'wrap', gap: 8 }}>
                          <span style={{ fontWeight: 700, fontSize: '0.85rem' }}>
                            תאריך סיכום: {new Date(sum.created_at).toLocaleString('he-IL')}
                            {index === 0 && <span className="badge badge-info" style={{ marginRight: 8 }}>הכי חדש</span>}
                          </span>
                          <button
                            className="btn btn-sm btn-success"
                            onClick={() => handleSendSpecificSummary(sum.id)}
                            disabled={detailBusy === `sending:${sum.id}`}
                          >
                            {detailBusy === `sending:${sum.id}` ? 'שולח...' : '✉️ שלח סיכום זה לוואטסאפ שלי'}
                          </button>
                        </div>
                        <p style={{ lineHeight: 1.6, marginBottom: 16 }}><strong>תקציר מנהלים:</strong> {sum.content.summary}</p>
                        {sum.content.topics?.length > 0 && (
                          <div>
                            <h4 style={{ fontSize: '0.9rem', fontWeight: 700, borderBottom: '1px solid var(--border-color)', paddingBottom: 6, marginBottom: 10 }}>נושאים מרכזיים</h4>
                            {sum.content.topics.map((t, idx) => (
                              <div key={idx} style={{ marginBottom: 10 }}>
                                <div style={{ fontWeight: 600, fontSize: '0.88rem', marginBottom: 4 }}>{t.topic}</div>
                                <ul style={{ margin: 0, paddingRight: 20, fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
                                  {t.bullets?.map((b, bIdx) => <li key={bIdx}>{b}</li>)}
                                </ul>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    ))
                  )}
                </div>
              )}

              {detailTab === 'tasks' && (
                <div style={{ overflowX: 'auto' }}>
                  {detailTasks.length === 0 ? (
                    <div className="empty-state"><p>אין משימות לקבוצה זו.</p></div>
                  ) : (
                    <table className="data-table">
                      <thead>
                        <tr>
                          <th>#</th>
                          <th>סטטוס</th>
                          <th>המשימה</th>
                          <th>תאריך ביצוע</th>
                          <th>נוצר</th>
                        </tr>
                      </thead>
                      <tbody>
                        {detailTasks.map(item => (
                          <tr key={item.id} style={item.completed ? { opacity: 0.6 } : undefined}>
                            <td className="row-id">#{item.id}</td>
                            <td>
                              <input type="checkbox" checked={item.completed} onChange={() => handleToggleTaskInModal(item)} style={{ width: 18, height: 18 }} />
                            </td>
                            <td style={item.completed ? { textDecoration: 'line-through' } : undefined}>
                              {item.direction && (
                                <span className="badge badge-warning" style={{ marginLeft: 6, fontSize: '0.7rem' }}>
                                  {item.direction === 'waiting_on_them' ? '📤 מהם' : '📥 אצלי'}
                                </span>
                              )}
                              {item.task}
                            </td>
                            <td style={{ whiteSpace: 'nowrap' }}>{item.deadline || '—'}</td>
                            <td style={{ fontSize: '0.78rem', color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>{new Date(item.created_at).toLocaleDateString('he-IL')}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              )}

              {detailTab === 'media' && (
                <div>
                  <p style={{ fontSize: '0.88rem', color: 'var(--text-secondary)', marginBottom: 16 }}>
                    הודעות קוליות ותמונות מאז הסיכום האחרון. אפשר לתמלל/לקרוא טקסט מתוכן בלחיצת כפתור.
                  </p>
                  {detailMedia.length === 0 ? (
                    <div className="empty-state"><p>לא נמצאו הודעות קוליות או תמונות לאחרונה.</p></div>
                  ) : (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                      {detailMedia.map(msg => {
                        const busy = mediaBusy[msg.message_id];
                        return (
                          <div key={msg.message_id} className="glass-card" style={{ padding: 14 }}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6, flexWrap: 'wrap', gap: 6 }}>
                              <strong style={{ fontSize: '0.88rem' }}>{msg.sender_name}</strong>
                              <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>{new Date(msg.timestamp * 1000).toLocaleString('he-IL')}</span>
                            </div>
                            <p style={{ fontSize: '0.88rem', whiteSpace: 'pre-wrap', marginBottom: 10 }}>{msg.body}</p>
                            {msg.type === 'audio' && (
                              <button className="btn btn-sm btn-primary" onClick={() => handleTranscribe(msg)} disabled={!!busy}>
                                {busy === 'transcribe' ? '🎙️ מתמלל...' : '🎙️ תמלל קולית'}
                              </button>
                            )}
                            {msg.type === 'image' && (
                              <button className="btn btn-sm btn-primary" onClick={() => handleOcr(msg)} disabled={!!busy}>
                                {busy === 'ocr' ? '🔍 קורא תמונה...' : '📷 קרא טקסט מהתמונה'}
                              </button>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}

              {detailTab === 'ask' && (
                <div>
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
                </div>
              )}
            </>
          )}
        </Modal>
      )}
    </>
  );
}
