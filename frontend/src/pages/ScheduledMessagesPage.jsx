import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { useToast } from '../components/Toast.jsx';

const emptyForm = { chat_id: '', content: '', scheduled_at: '', repeat: '' };

export default function ScheduledMessagesPage() {
  const [messages, setMessages] = useState([]);
  const [form, setForm] = useState(emptyForm);
  const [loading, setLoading] = useState(true);
  const toast = useToast();

  async function load() {
    setLoading(true);
    try { setMessages(await api.getScheduledMessages()); } catch (err) { toast(err.message, 'error'); } finally { setLoading(false); }
  }

  useEffect(() => { load(); }, []);

  async function handleCreate(e) {
    e.preventDefault();
    if (!form.chat_id || !form.content || !form.scheduled_at) return;
    try {
      await api.createScheduledMessage({ ...form, scheduled_at: new Date(form.scheduled_at).toISOString() });
      setForm(emptyForm);
      await load();
      toast('ההודעה תוזמנה', 'success');
    } catch (err) { toast(err.message, 'error'); }
  }

  async function handleDelete(id) {
    try { await api.deleteScheduledMessage(id); await load(); } catch (err) { toast(err.message, 'error'); }
  }

  const statusBadge = (status) => {
    if (status === 'sent') return <span className="badge badge-success">נשלח</span>;
    if (status === 'failed') return <span className="badge badge-danger">נכשל</span>;
    return <span className="badge badge-info">ממתין</span>;
  };

  return (
    <>
      <div className="page-header">
        <div className="page-title">
          <h2>📨 הודעות מתוזמנות</h2>
          <p>הודעות טקסט שיישלחו אוטומטית במועד שתבחר</p>
        </div>
      </div>

      <div className="glass-card">
        <form onSubmit={handleCreate}>
          <div className="form-row">
            <div className="form-group">
              <label className="form-label">נמען (טלפון או מזהה קבוצה)</label>
              <input className="form-input" value={form.chat_id} onChange={e => setForm(p => ({ ...p, chat_id: e.target.value }))} placeholder="0521234567" />
            </div>
            <div className="form-group">
              <label className="form-label">מועד שליחה</label>
              <input className="form-input" type="datetime-local" value={form.scheduled_at} onChange={e => setForm(p => ({ ...p, scheduled_at: e.target.value }))} />
            </div>
            <div className="form-group">
              <label className="form-label">חזרה</label>
              <select className="form-select" value={form.repeat} onChange={e => setForm(p => ({ ...p, repeat: e.target.value }))}>
                <option value="">ללא</option>
                <option value="daily">יומי</option>
                <option value="weekly">שבועי</option>
                <option value="monthly">חודשי</option>
              </select>
            </div>
          </div>
          <div className="form-group">
            <label className="form-label">תוכן ההודעה</label>
            <textarea className="form-textarea" value={form.content} onChange={e => setForm(p => ({ ...p, content: e.target.value }))} />
          </div>
          <button className="btn btn-primary" type="submit">תזמן הודעה</button>
        </form>
      </div>

      <div className="glass-card">
        {loading ? (
          <div className="empty-state">טוען...</div>
        ) : messages.length === 0 ? (
          <div className="empty-state"><div className="empty-state-icon">📨</div><p>אין הודעות מתוזמנות.</p></div>
        ) : (
          <table className="data-table">
            <thead><tr><th>נמען</th><th>תוכן</th><th>מועד</th><th>חזרה</th><th>סטטוס</th><th></th></tr></thead>
            <tbody>
              {messages.map(m => (
                <tr key={m.id}>
                  <td>{m.chat_id}</td>
                  <td style={{ maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.content}</td>
                  <td>{new Date(m.scheduled_at).toLocaleString('he-IL')}</td>
                  <td>{m.repeat || '—'}</td>
                  <td>{statusBadge(m.status)}</td>
                  <td><button className="btn btn-sm btn-danger" onClick={() => handleDelete(m.id)}>מחק</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
