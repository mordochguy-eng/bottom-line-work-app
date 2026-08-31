import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { useToast } from '../components/Toast.jsx';

export default function ActivityLogPage() {
  const [log, setLog] = useState([]);
  const [loading, setLoading] = useState(true);
  const [undoingId, setUndoingId] = useState(null);
  const toast = useToast();

  async function load() {
    setLoading(true);
    try {
      setLog(await api.getActivityLog());
    } catch (err) { toast(err.message, 'error'); } finally { setLoading(false); }
  }

  useEffect(() => { load(); }, []);

  async function handleUndo(entry) {
    setUndoingId(entry.id);
    try {
      await api.undoActivityLogEntry(entry.id);
      toast('הפעולה בוטלה', 'success');
      await load();
    } catch (err) { toast(err.message, 'error'); } finally { setUndoingId(null); }
  }

  return (
    <>
      <div className="page-header">
        <div className="page-title">
          <h2>🕘 יומן פעולות</h2>
          <p>כל פעולה שביצעת באפליקציה, עם אפשרות ביטול</p>
        </div>
        <button className="btn" onClick={load} disabled={loading}>{loading ? '🔄 טוען...' : '🔄 רענן'}</button>
      </div>

      <div className="glass-card">
        {loading ? (
          <div className="empty-state">טוען...</div>
        ) : log.length === 0 ? (
          <div className="empty-state">
            <div className="empty-state-icon">🕘</div>
            <p>אין עדיין פעולות רשומות ביומן.</p>
          </div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table className="data-table">
              <thead>
                <tr>
                  <th>מתי</th>
                  <th>פעולה</th>
                  <th>סטטוס</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {log.map(entry => (
                  <tr key={entry.id}>
                    <td style={{ fontSize: '0.78rem', color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
                      {new Date(entry.timestamp).toLocaleString('he-IL')}
                    </td>
                    <td>{entry.description}</td>
                    <td>
                      {entry.undone ? (
                        <span className="badge badge-muted">בוטלה{entry.undone_at ? ` · ${new Date(entry.undone_at).toLocaleString('he-IL')}` : ''}</span>
                      ) : (
                        <span className="badge badge-info">פעילה</span>
                      )}
                    </td>
                    <td>
                      {!entry.undone && (
                        <button
                          className="btn btn-sm btn-danger"
                          disabled={undoingId === entry.id}
                          onClick={() => handleUndo(entry)}
                        >
                          {undoingId === entry.id ? 'מבטל...' : '↩ בטל פעולה'}
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
