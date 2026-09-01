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
  const toast = useToast();

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

  async function handleToggleTracked(chatId, current) {
    try {
      await api.toggleChatTracked(chatId, !current);
      await load();
    } catch (err) { toast(err.message, 'error'); }
  }

  async function handleToggleDigest(chatId, current) {
    try {
      await api.toggleChatDigest(chatId, !current);
      await load();
    } catch (err) { toast(err.message, 'error'); }
  }

  async function handleCategoryChange(chatId, category) {
    try {
      await api.setChatCategory(chatId, category);
      await load();
    } catch (err) { toast(err.message, 'error'); }
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
        <button className="btn btn-primary" onClick={handleSync} disabled={syncing}>
          {syncing ? 'מסנכרן...' : '🔄 סנכרן רשימת קבוצות'}
        </button>
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
                <tr key={chat.chat_id}>
                  <td>{chat.name}</td>
                  <td>
                    <select
                      className="form-select"
                      style={{ padding: '6px 10px', fontSize: '0.82rem' }}
                      value={chat.profile_type || 'general'}
                      onChange={(e) => handleCategoryChange(chat.chat_id, e.target.value)}
                    >
                      {CATEGORY_ORDER.map(key => (
                        <option key={key} value={key}>{CATEGORIES[key].icon} {CATEGORIES[key].label}</option>
                      ))}
                    </select>
                  </td>
                  <td>
                    <label className="switch">
                      <input type="checkbox" checked={chat.is_tracked} onChange={() => handleToggleTracked(chat.chat_id, chat.is_tracked)} />
                      <span className="slider"></span>
                    </label>
                  </td>
                  <td>
                    <label className="switch">
                      <input type="checkbox" checked={chat.include_in_digest} onChange={() => handleToggleDigest(chat.chat_id, chat.include_in_digest)} disabled={!chat.is_tracked} />
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
