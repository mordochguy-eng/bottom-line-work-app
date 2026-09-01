import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { useToast } from '../components/Toast.jsx';
import { CATEGORIES, CATEGORY_ORDER } from '../constants/categories.js';

export default function HomePage({ onCompose } = {}) {
  const [chats, setChats] = useState([]);
  const [summaries, setSummaries] = useState([]);
  const [actionItems, setActionItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [cardBusy, setCardBusy] = useState({}); // chat_id -> 'summarizing'
  const [globalSummarizing, setGlobalSummarizing] = useState(false);
  const [globalProgress, setGlobalProgress] = useState(null);
  const [search, setSearch] = useState('');

  // Everything below is keyed by chat_id so any number of rows can be
  // expanded — with their own tab, data, and busy state — at once.
  const [expanded, setExpanded] = useState({});
  const [rowTab, setRowTab] = useState({}); // chat_id -> 'summaries' | 'tasks' | 'media' | 'ask'
  const [rowData, setRowData] = useState({}); // chat_id -> { summaries, messages, loading }
  const [rowBusy, setRowBusy] = useState({}); // chat_id -> 'summarizing' | `sending:<id>`
  const [mediaBusy, setMediaBusy] = useState({}); // message_id -> 'transcribe' | 'ocr'
  const [askState, setAskState] = useState({}); // chat_id -> { messages, input, asking }
  // Snapshot of "has an update" taken at load time, used only for sort order
  // — opening a row marks it viewed (and drops its badge) right away, but
  // shouldn't yank it to a new position mid-click; it resettles the next
  // time the list actually reloads.
  const [sortSnapshot, setSortSnapshot] = useState({});

  const toast = useToast();

  async function load() {
    setLoading(true);
    try {
      const [c, s, a] = await Promise.all([api.getChats(), api.getLatestSummaries(), api.getActionItems()]);
      setChats(c);
      setSummaries(s);
      setActionItems(a);
      const summaryMap = Object.fromEntries(s.map(x => [x.chat_id, x]));
      const snapshot = {};
      c.forEach(chat => {
        const summary = summaryMap[chat.chat_id];
        snapshot[chat.chat_id] = !!summary && (!chat.last_viewed_at || new Date(summary.created_at) > new Date(chat.last_viewed_at));
      });
      setSortSnapshot(snapshot);
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
  // time you opened it — not just "was summarized recently" — so it stops
  // standing out the moment you've actually looked at it.
  function hasUpdate(chat) {
    const summary = summaryByChatId[chat.chat_id];
    if (!summary) return false;
    if (!chat.last_viewed_at) return true;
    return new Date(summary.created_at) > new Date(chat.last_viewed_at);
  }

  function ensureRowData(chatId) {
    if (rowData[chatId]) return;
    setRowData(p => ({ ...p, [chatId]: { summaries: [], messages: [], loading: true } }));
    Promise.all([api.getSummaries(chatId), api.getChatMessages(chatId)])
      .then(([s, m]) => {
        setRowData(p => ({ ...p, [chatId]: { summaries: s, messages: m, loading: false } }));
        // Marks the "has a new update" highlight as read — fire-and-forget.
        api.markChatViewed(chatId)
          .then(updatedChat => setChats(prev => prev.map(c => (c.chat_id === chatId ? updatedChat : c))))
          .catch(() => {});
      })
      .catch(err => {
        toast(err.message, 'error');
        setRowData(p => ({ ...p, [chatId]: { summaries: [], messages: [], loading: false } }));
      });
  }

  async function refreshRowData(chatId) {
    const [s, m] = await Promise.all([api.getSummaries(chatId), api.getChatMessages(chatId)]);
    setRowData(p => ({ ...p, [chatId]: { summaries: s, messages: m, loading: false } }));
  }

  function toggleRow(chat) {
    const willOpen = !expanded[chat.chat_id];
    setExpanded(p => ({ ...p, [chat.chat_id]: willOpen }));
    if (willOpen) {
      setRowTab(p => (p[chat.chat_id] ? p : { ...p, [chat.chat_id]: 'summaries' }));
      ensureRowData(chat.chat_id);
    }
  }

  function openRowTab(chat, tab) {
    setRowTab(p => ({ ...p, [chat.chat_id]: tab }));
    if (!expanded[chat.chat_id]) {
      setExpanded(p => ({ ...p, [chat.chat_id]: true }));
      ensureRowData(chat.chat_id);
    }
  }

  async function handleSummarizeOne(chat) {
    setCardBusy(p => ({ ...p, [chat.chat_id]: 'summarizing' }));
    try {
      const result = await api.summarizeChat(chat.chat_id);
      await load();
      if (rowData[chat.chat_id]) await refreshRowData(chat.chat_id);
      toast(result?.noNewMessages ? 'אין עדכונים חדשים מאז הסיכום האחרון' : 'הסיכום הופק בהצלחה', result?.noNewMessages ? 'info' : 'success');
    } catch (err) { toast(err.message, 'error'); } finally { setCardBusy(p => ({ ...p, [chat.chat_id]: null })); }
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

  async function handleSendSpecificSummary(chatId, summaryId) {
    setRowBusy(p => ({ ...p, [chatId]: `sending:${summaryId}` }));
    try {
      await api.sendChatDigest(chatId, summaryId);
      await refreshRowData(chatId);
      await load();
      toast('הסיכום נשלח לוואטסאפ', 'success');
    } catch (err) { toast(err.message, 'error'); } finally { setRowBusy(p => ({ ...p, [chatId]: null })); }
  }

  async function handleToggleTaskInRow(item) {
    try {
      await api.toggleActionItem(item.id, !item.completed);
      await load();
    } catch (err) { toast(err.message, 'error'); }
  }

  async function handleTranscribe(chatId, msg) {
    setMediaBusy(p => ({ ...p, [msg.message_id]: 'transcribe' }));
    try {
      const updated = await api.transcribeMessage(msg.message_id);
      setRowData(p => ({ ...p, [chatId]: { ...p[chatId], messages: p[chatId].messages.map(m => (m.message_id === msg.message_id ? updated : m)) } }));
    } catch (err) { toast(err.message, 'error'); } finally { setMediaBusy(p => ({ ...p, [msg.message_id]: null })); }
  }

  async function handleOcr(chatId, msg) {
    setMediaBusy(p => ({ ...p, [msg.message_id]: 'ocr' }));
    try {
      const updated = await api.ocrMessage(msg.message_id);
      setRowData(p => ({ ...p, [chatId]: { ...p[chatId], messages: p[chatId].messages.map(m => (m.message_id === msg.message_id ? updated : m)) } }));
    } catch (err) { toast(err.message, 'error'); } finally { setMediaBusy(p => ({ ...p, [msg.message_id]: null })); }
  }

  async function handleAsk(e, chatId) {
    e.preventDefault();
    const current = askState[chatId] || { messages: [], input: '', asking: false };
    const question = current.input.trim();
    if (!question) return;
    const historyForBackend = current.messages.map(m => ({ role: m.role, text: m.text }));
    setAskState(p => ({ ...p, [chatId]: { messages: [...current.messages, { role: 'user', text: question }], input: '', asking: true } }));
    try {
      const res = await api.askAboutChat(chatId, question, historyForBackend);
      setAskState(p => ({ ...p, [chatId]: { ...p[chatId], messages: [...p[chatId].messages, { role: 'assistant', text: res.answer }], asking: false } }));
    } catch (err) {
      toast(err.message, 'error');
      setAskState(p => ({ ...p, [chatId]: { ...p[chatId], messages: [...p[chatId].messages, { role: 'assistant', text: `שגיאה: ${err.message}` }], asking: false } }));
    }
  }

  function renderRowContent(chat) {
    const tab = rowTab[chat.chat_id] || 'summaries';
    const data = rowData[chat.chat_id];
    const rowTasks = actionItems.filter(a => a.chat_id === chat.chat_id).sort((a, b) => (a.completed - b.completed) || (b.id - a.id));
    const media = (data?.messages || []).filter(m => m.type === 'audio' || m.type === 'image');
    const ask = askState[chat.chat_id] || { messages: [], input: '', asking: false };
    const busy = rowBusy[chat.chat_id];

    return (
      <div style={{ marginTop: 14, paddingTop: 14, borderTop: '1px solid var(--border-color)' }}>
        <div className="type-btn-group" style={{ marginBottom: 16 }}>
          <button className={`type-btn ${tab === 'summaries' ? 'active' : ''}`} onClick={() => setRowTab(p => ({ ...p, [chat.chat_id]: 'summaries' }))}>
            📝 סיכומים ({data?.summaries.length || 0})
          </button>
          <button className={`type-btn ${tab === 'tasks' ? 'active' : ''}`} onClick={() => setRowTab(p => ({ ...p, [chat.chat_id]: 'tasks' }))}>
            📋 משימות ({rowTasks.length})
          </button>
          <button className={`type-btn ${tab === 'media' ? 'active' : ''}`} onClick={() => setRowTab(p => ({ ...p, [chat.chat_id]: 'media' }))}>
            🎙️ הודעות מולטימדיה / קוליות
          </button>
          <button className={`type-btn ${tab === 'ask' ? 'active' : ''}`} onClick={() => setRowTab(p => ({ ...p, [chat.chat_id]: 'ask' }))}>
            💬 שאל על הקבוצה
          </button>
        </div>

        {data?.loading ? (
          <div className="empty-state">טוען...</div>
        ) : (
          <>
            {tab === 'summaries' && (
              <div>
                {(data?.summaries.length || 0) === 0 ? (
                  <div className="empty-state">
                    <p>אין סיכומים עבור קבוצה זו עדיין.</p>
                    <button className="btn btn-primary" style={{ marginTop: 14 }} onClick={() => handleSummarizeOne(chat)} disabled={cardBusy[chat.chat_id] === 'summarizing'}>
                      {cardBusy[chat.chat_id] === 'summarizing' ? 'מסכם...' : 'סכם עכשיו'}
                    </button>
                  </div>
                ) : (
                  data.summaries.map((sum, index) => (
                    <div key={sum.id} className="glass-card" style={{ marginBottom: 16, background: '#fff', borderRight: index === 0 ? '4px solid var(--accent-primary)' : '1px solid var(--border-color)' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14, borderBottom: '1px solid var(--border-color)', paddingBottom: 10, flexWrap: 'wrap', gap: 8 }}>
                        <span style={{ fontWeight: 700, fontSize: '0.85rem' }}>
                          תאריך סיכום: {new Date(sum.created_at).toLocaleString('he-IL')}
                          {index === 0 && <span className="badge badge-info" style={{ marginRight: 8 }}>הכי חדש</span>}
                        </span>
                        <button
                          className="btn btn-sm btn-success"
                          onClick={() => handleSendSpecificSummary(chat.chat_id, sum.id)}
                          disabled={busy === `sending:${sum.id}`}
                        >
                          {busy === `sending:${sum.id}` ? 'שולח...' : '✉️ שלח סיכום זה לוואטסאפ שלי'}
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

            {tab === 'tasks' && (
              <div style={{ overflowX: 'auto' }}>
                {rowTasks.length === 0 ? (
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
                      {rowTasks.map(item => (
                        <tr key={item.id} style={item.completed ? { opacity: 0.6 } : undefined}>
                          <td className="row-id">#{item.id}</td>
                          <td>
                            <input type="checkbox" checked={item.completed} onChange={() => handleToggleTaskInRow(item)} style={{ width: 18, height: 18 }} />
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

            {tab === 'media' && (
              <div>
                <p style={{ fontSize: '0.88rem', color: 'var(--text-secondary)', marginBottom: 16 }}>
                  הודעות קוליות ותמונות מאז הסיכום האחרון. אפשר לתמלל/לקרוא טקסט מתוכן בלחיצת כפתור.
                </p>
                {media.length === 0 ? (
                  <div className="empty-state"><p>לא נמצאו הודעות קוליות או תמונות לאחרונה.</p></div>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                    {media.map(msg => {
                      const mBusy = mediaBusy[msg.message_id];
                      return (
                        <div key={msg.message_id} className="glass-card" style={{ padding: 14, background: '#fff' }}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6, flexWrap: 'wrap', gap: 6 }}>
                            <strong style={{ fontSize: '0.88rem' }}>{msg.sender_name}</strong>
                            <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>{new Date(msg.timestamp * 1000).toLocaleString('he-IL')}</span>
                          </div>
                          <p style={{ fontSize: '0.88rem', whiteSpace: 'pre-wrap', marginBottom: 10 }}>{msg.body}</p>
                          {msg.type === 'audio' && (
                            <button className="btn btn-sm btn-primary" onClick={() => handleTranscribe(chat.chat_id, msg)} disabled={!!mBusy}>
                              {mBusy === 'transcribe' ? '🎙️ מתמלל...' : '🎙️ תמלל קולית'}
                            </button>
                          )}
                          {msg.type === 'image' && (
                            <button className="btn btn-sm btn-primary" onClick={() => handleOcr(chat.chat_id, msg)} disabled={!!mBusy}>
                              {mBusy === 'ocr' ? '🔍 קורא תמונה...' : '📷 קרא טקסט מהתמונה'}
                            </button>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}

            {tab === 'ask' && (
              <div>
                <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: 14 }}>
                  שאל כל שאלה על תוכן הקבוצה — המערכת קוראת את ההודעות האחרונות ועונה בהתבסס עליהן בלבד.
                </p>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10, maxHeight: 320, overflowY: 'auto', marginBottom: 14 }}>
                  {ask.messages.length === 0 && (
                    <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>לדוגמה: "מה סוכם לגבי התשלום?" או "מי התנדב למשימה?"</p>
                  )}
                  {ask.messages.map((m, i) => (
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
                  {ask.asking && <div style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>חושב...</div>}
                </div>
                <form onSubmit={(e) => handleAsk(e, chat.chat_id)} style={{ display: 'flex', gap: 8 }}>
                  <input
                    className="form-input"
                    placeholder="הקלד שאלה על הקבוצה..."
                    value={ask.input}
                    onChange={(e) => setAskState(p => ({ ...p, [chat.chat_id]: { ...(p[chat.chat_id] || { messages: [], asking: false }), input: e.target.value } }))}
                    disabled={ask.asking}
                  />
                  <button className="btn btn-primary" type="submit" disabled={ask.asking || !ask.input.trim()}>שלח</button>
                </form>
              </div>
            )}
          </>
        )}
      </div>
    );
  }

  function renderCard(chat) {
    const summary = summaryByChatId[chat.chat_id];
    const busy = cardBusy[chat.chat_id];
    const updated = hasUpdate(chat);
    const isOpen = !!expanded[chat.chat_id];

    return (
      <div key={chat.chat_id} className="glass-card" style={{ padding: '12px 18px', background: '#fff', ...(updated ? { border: '1px solid rgba(180, 83, 9, 0.4)' } : {}) }}>
        <div
          style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap', cursor: 'pointer' }}
          onClick={() => toggleRow(chat)}
        >
          <strong style={{ fontSize: '1rem', flexShrink: 0 }}>{chat.name}</strong>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', flexShrink: 0 }}>
            {updated && <span className="badge badge-warning">🆕 עדכון חדש</span>}
            {openCount(chat.chat_id) > 0 && <span className="badge badge-danger">{openCount(chat.chat_id)} משימות</span>}
          </div>

          <div style={{ flex: 1 }} />

          {summary && (
            <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)', flexShrink: 0, whiteSpace: 'nowrap' }}>
              {new Date(summary.created_at).toLocaleString('he-IL')} {summary.is_sent ? '✅' : '📥'}
            </span>
          )}

          <div style={{ display: 'flex', gap: 6, flexShrink: 0 }} onClick={(e) => e.stopPropagation()}>
            <button className="btn btn-sm" onClick={() => openRowTab(chat, 'ask')}>💬 שאל</button>
            <button className="btn btn-sm btn-primary" onClick={() => handleSummarizeOne(chat)} disabled={!!busy}>
              {busy === 'summarizing' ? 'מסכם...' : '📝 סכם עכשיו'}
            </button>
            {onCompose && (
              <button
                className="btn btn-sm"
                onClick={() => onCompose(chat)}
                title="שלח הודעה מיידית/מתוזמנת לקבוצה זו"
                style={{ border: '1px solid #25D366', color: '#25D366', background: 'transparent', display: 'flex', alignItems: 'center', gap: 5 }}
              >
                <svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor" aria-hidden="true">
                  <path d="M12.04 2c-5.46 0-9.9 4.44-9.9 9.9 0 1.75.46 3.45 1.32 4.95L2 22l5.25-1.38a9.9 9.9 0 004.79 1.22h.01c5.46 0 9.9-4.44 9.9-9.9 0-2.65-1.03-5.13-2.9-7-1.87-1.87-4.35-2.9-7-2.9zm0 18.13h-.01a8.2 8.2 0 01-4.19-1.15l-.3-.18-3.12.82.83-3.04-.2-.31a8.23 8.23 0 01-1.26-4.37c0-4.55 3.7-8.25 8.26-8.25 2.21 0 4.28.86 5.84 2.42a8.2 8.2 0 012.42 5.83c0 4.55-3.7 8.24-8.27 8.24zm4.52-6.17c-.25-.12-1.47-.72-1.69-.81-.23-.08-.39-.12-.56.13-.17.24-.64.81-.78.97-.14.17-.29.19-.53.06-.25-.12-1.05-.39-2-1.23-.74-.66-1.24-1.47-1.38-1.72-.15-.24-.02-.38.11-.5.11-.11.25-.29.37-.43.12-.15.16-.25.24-.42.08-.16.04-.31-.02-.43-.06-.12-.56-1.34-.76-1.84-.2-.48-.4-.42-.56-.42h-.48c-.16 0-.43.06-.65.31-.23.24-.85.83-.85 2.02s.87 2.35.99 2.51c.12.16 1.71 2.61 4.14 3.66.58.25 1.03.4 1.38.51.58.19 1.11.16 1.53.1.47-.07 1.47-.6 1.67-1.19.21-.58.21-1.08.15-1.19-.06-.1-.23-.16-.48-.28z"/>
                </svg>
                הודעה
              </button>
            )}
          </div>

          <span
            title={isOpen ? 'סגור' : 'פתח לפרטי הקבוצה'}
            style={{
              fontSize: '0.9rem', color: 'var(--accent-primary)', flexShrink: 0, width: 22, height: 22,
              display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: '50%',
              background: 'var(--accent-primary-glow)', transition: 'transform 0.15s ease',
              transform: isOpen ? 'rotate(90deg)' : 'none'
            }}
          >
            ▸
          </span>
        </div>

        {isOpen && renderRowContent(chat)}
      </div>
    );
  }

  if (loading) return <div className="empty-state">טוען...</div>;

  return (
    <>
      <div className="page-header">
        <div className="page-title">
          <h2>שחר און - בשורה התחתונה, הפיד היומי שלך</h2>
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
              .sort((a, b) => (sortSnapshot[b.chat_id] ? 1 : 0) - (sortSnapshot[a.chat_id] ? 1 : 0));
            if (inCategory.length === 0) return null;
            const cat = CATEGORIES[key];
            return (
              <div key={key}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16, borderBottom: `2px solid ${cat.color}22`, paddingBottom: 8 }}>
                  <span style={{ fontSize: '1.4rem' }}>{cat.icon}</span>
                  <h3 style={{ margin: 0, fontSize: '1.2rem', fontWeight: 800, color: cat.color }}>{cat.label}</h3>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {inCategory.map(renderCard)}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}
