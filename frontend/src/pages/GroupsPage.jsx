import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { useToast } from '../components/Toast.jsx';
import SortTh from '../components/SortTh.jsx';
import { useSort } from '../hooks/useSort.js';
import { CATEGORIES, CATEGORY_ORDER } from '../constants/categories.js';

export default function GroupsPage() {
  const [chats, setChats] = useState([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [summarizingId, setSummarizingId] = useState(null);
  // Toggling several groups' switches used to fire an API call (and a
  // reload) per click — staged here instead, so you can check/change a
  // batch of rows and send them all in one "בצע" action.
  const [pending, setPending] = useState({}); // chat_id -> { is_tracked?, include_in_digest?, profile_type? }
  const [applying, setApplying] = useState(false);
  const toast = useToast();

  function displayValue(chat, field) {
    const staged = pending[chat.chat_id]?.[field];
    return staged !== undefined ? staged : chat[field];
  }

  function stage(chatId, field, value) {
    setPending(prev => ({ ...prev, [chatId]: { ...prev[chatId], [field]: value } }));
  }

  async function handleApplyChanges() {
    setApplying(true);
    try {
      for (const [chatId, changes] of Object.entries(pending)) {
        if (changes.is_tracked !== undefined) await api.toggleChatTracked(chatId, changes.is_tracked);
        if (changes.include_in_digest !== undefined) await api.toggleChatDigest(chatId, changes.include_in_digest);
        if (changes.profile_type !== undefined) await api.setChatCategory(chatId, changes.profile_type);
      }
      setPending({});
      toast('השינויים בוצעו', 'success');
      await load();
    } catch (err) { toast(err.message, 'error'); } finally { setApplying(false); }
  }

  async function load() {
    setLoading(true);
    try { setChats(await api.getChats()); } catch (err) { toast(err.message, 'error'); } finally { setLoading(false); }
  }

  useEffect(() => { load(); }, []);

  async function handleSync() {
    setSyncing(true);
    try {
      await api.syncChats();
      await load();
      toast('רשימת הקבוצות עודכנה', 'success');
    } catch (err) { toast(err.message, 'error'); } finally { setSyncing(false); }
  }

  async function handleSummarizeNow(chatId) {
    setSummarizingId(chatId);
    try {
      await api.summarizeChat(chatId);
      await load();
      toast('הסיכום הופק בהצלחה', 'success');
    } catch (err) { toast(err.message, 'error'); } finally { setSummarizingId(null); }
  }

  // Default arrangement (before any column header is clicked): grouped by
  // category in the app's standard order, tracked groups first within each
  // category — clicking a column header still overrides this, same as any
  // other sortable table.
  const categoryRank = Object.fromEntries(CATEGORY_ORDER.map((key, i) => [key, i]));
  const basePreSorted = [...chats].sort((a, b) => {
    const catDiff = (categoryRank[a.profile_type || 'general'] ?? 999) - (categoryRank[b.profile_type || 'general'] ?? 999);
    if (catDiff !== 0) return catDiff;
    const trackedDiff = (b.is_tracked ? 1 : 0) - (a.is_tracked ? 1 : 0);
    if (trackedDiff !== 0) return trackedDiff;
    return (a.name || '').localeCompare(b.name || '');
  });
  const { sorted, sortKey, sortDir, requestSort } = useSort(basePreSorted, null, 'asc');

  return (
    <>
      <div className="page-header">
        <div className="page-title">
          <h2>💬 קבוצות מעקב</h2>
          <p>בחר אילו קבוצות לעקוב אחריהן ולסכם אוטומטית</p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          {Object.keys(pending).length > 0 && (
            <>
              <button className="btn btn-sm btn-success" onClick={handleApplyChanges} disabled={applying}>
                {applying ? 'מבצע...' : `✅ בצע (${Object.keys(pending).length})`}
              </button>
              <button className="btn btn-sm" onClick={() => setPending({})} disabled={applying}>✖ בטל</button>
            </>
          )}
          <button className="btn btn-primary" onClick={handleSync} disabled={syncing}>
            {syncing ? 'מסנכרן...' : '🔄 סנכרן רשימת קבוצות'}
          </button>
        </div>
      </div>

      <div className="glass-card">
        {loading ? (
          <div className="empty-state">טוען...</div>
        ) : chats.length === 0 ? (
          <div className="empty-state">
            <div className="empty-state-icon">📭</div>
            <p>אין קבוצות. לחץ על "סנכרן רשימת קבוצות" כדי למשוך אותן מהוואטסאפ.</p>
          </div>
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <SortTh label="שם" sortKey="name" currentKey={sortKey} currentDir={sortDir} onSort={requestSort} />
                <SortTh label="קטגוריה" sortKey="profile_type" currentKey={sortKey} currentDir={sortDir} onSort={requestSort} />
                <SortTh label="במעקב" sortKey="is_tracked" currentKey={sortKey} currentDir={sortDir} onSort={requestSort} />
                <SortTh label="כלול בסיכום היומי" sortKey="include_in_digest" currentKey={sortKey} currentDir={sortDir} onSort={requestSort} />
                <SortTh label="סיכום אחרון" sortKey="last_summary_at" currentKey={sortKey} currentDir={sortDir} onSort={requestSort} />
                <th></th>
              </tr>
            </thead>
            <tbody>
              {sorted.map(chat => (
                <tr key={chat.chat_id} style={pending[chat.chat_id] ? { background: 'rgba(180, 83, 9, 0.05)' } : {}}>
                  <td>{chat.name}</td>
                  <td>
                    <select
                      className="form-select"
                      style={{ padding: '6px 10px', fontSize: '0.82rem' }}
                      value={displayValue(chat, 'profile_type') || 'general'}
                      onChange={(e) => stage(chat.chat_id, 'profile_type', e.target.value)}
                    >
                      {CATEGORY_ORDER.map(key => (
                        <option key={key} value={key}>{CATEGORIES[key].icon} {CATEGORIES[key].label}</option>
                      ))}
                    </select>
                  </td>
                  <td>
                    <label className="switch">
                      <input type="checkbox" checked={displayValue(chat, 'is_tracked')} onChange={(e) => stage(chat.chat_id, 'is_tracked', e.target.checked)} />
                      <span className="slider"></span>
                    </label>
                  </td>
                  <td>
                    <label className="switch">
                      <input type="checkbox" checked={displayValue(chat, 'include_in_digest')} onChange={(e) => stage(chat.chat_id, 'include_in_digest', e.target.checked)} disabled={!displayValue(chat, 'is_tracked')} />
                      <span className="slider"></span>
                    </label>
                  </td>
                  <td style={{ fontSize: '0.82rem', color: 'var(--text-muted)' }}>
                    {chat.last_summary_at ? new Date(chat.last_summary_at).toLocaleString('he-IL') : '—'}
                  </td>
                  <td>
                    {chat.is_tracked && (
                      <button className="btn btn-sm" onClick={() => handleSummarizeNow(chat.chat_id)} disabled={summarizingId === chat.chat_id}>
                        {summarizingId === chat.chat_id ? 'מסכם...' : '🤖 סכם עכשיו'}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
