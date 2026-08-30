import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { useToast } from '../components/Toast.jsx';

export default function ApprovalQueuePage() {
  const [queue, setQueue] = useState([]);
  const [contacts, setContacts] = useState([]);
  const [faqs, setFaqs] = useState([]);
  const [settings, setSettings] = useState({});
  const [loading, setLoading] = useState(true);
  const [edits, setEdits] = useState({});
  const [newContact, setNewContact] = useState({ name: '', phone: '' });
  const [newFaq, setNewFaq] = useState({ question: '', answer: '' });
  const toast = useToast();

  async function load() {
    setLoading(true);
    try {
      const [q, c, f, s] = await Promise.all([api.getApprovalQueue(), api.getContacts(), api.getFaqs(), api.getSettings()]);
      setQueue(q);
      setContacts(c);
      setFaqs(f);
      setSettings(s);
    } catch (err) { toast(err.message, 'error'); } finally { setLoading(false); }
  }

  useEffect(() => { load(); }, []);

  const pending = queue.filter(q => q.status === 'pending');

  async function handleApprove(item) {
    try {
      await api.approveQueueItem(item.id, edits[item.id]);
      toast('התשובה נשלחה בוואטסאפ', 'success');
      await load();
    } catch (err) { toast(err.message, 'error'); }
  }

  async function handleReject(item) {
    try { await api.rejectQueueItem(item.id); await load(); } catch (err) { toast(err.message, 'error'); }
  }

  async function handleToggleAutoReply() {
    try {
      const updated = await api.toggleAutoReply(!settings.autoReplyEnabled);
      setSettings(updated);
      toast(updated.autoReplyEnabled ? 'מענה אוטומטי מאושר הופעל' : 'מענה אוטומטי מאושר הושבת', 'info');
    } catch (err) { toast(err.message, 'error'); }
  }

  async function handleAddContact(e) {
    e.preventDefault();
    if (!newContact.name || !newContact.phone) return;
    try {
      await api.createContact(newContact);
      setNewContact({ name: '', phone: '' });
      await load();
    } catch (err) { toast(err.message, 'error'); }
  }

  async function handleDeleteContact(id) {
    try { await api.deleteContact(id); await load(); } catch (err) { toast(err.message, 'error'); }
  }

  async function handleAddFaq(e) {
    e.preventDefault();
    if (!newFaq.question || !newFaq.answer) return;
    try {
      await api.createFaq(newFaq);
      setNewFaq({ question: '', answer: '' });
      await load();
    } catch (err) { toast(err.message, 'error'); }
  }

  async function handleDeleteFaq(id) {
    try { await api.deleteFaq(id); await load(); } catch (err) { toast(err.message, 'error'); }
  }

  return (
    <>
      <div className="page-header">
        <div className="page-title">
          <h2>📥 תור אישור תגובות</h2>
          <p>שום דבר לא נשלח אוטומטית — כל טיוטה ממתינה לאישור שלך</p>
        </div>
        <label style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: '0.88rem', fontWeight: 600 }}>
          מענה אוטומטי מאושר {settings.autoReplyEnabled ? 'פעיל' : 'כבוי'}
          <label className="switch">
            <input type="checkbox" checked={!!settings.autoReplyEnabled} onChange={handleToggleAutoReply} />
            <span className="slider"></span>
          </label>
        </label>
      </div>

      <div className="glass-card">
        <h3 style={{ marginBottom: 14 }}>ממתינות לאישור ({pending.length})</h3>
        {loading ? (
          <div className="empty-state">טוען...</div>
        ) : pending.length === 0 ? (
          <div className="empty-state">
            <div className="empty-state-icon">📭</div>
            <p>אין טיוטות ממתינות כרגע.</p>
          </div>
        ) : (
          pending.map(item => (
            <div key={item.id} className="glass-card queue-card">
              <div className="list-row-title">{item.sender_name}</div>
              <div className="list-row-sub">"{item.incoming_message}"</div>
              <div style={{ fontSize: '0.75rem', color: 'var(--accent-info)', marginTop: 6 }}>סיבת התאמה: {item.match_reason}</div>
              <div className="queue-reply-box">
                <textarea
                  className="form-textarea"
                  value={edits[item.id] ?? item.draft_reply}
                  onChange={(e) => setEdits(prev => ({ ...prev, [item.id]: e.target.value }))}
                />
              </div>
              <div className="queue-actions">
                <button className="btn btn-success" onClick={() => handleApprove(item)}>✅ אשר ושלח</button>
                <button className="btn btn-danger" onClick={() => handleReject(item)}>✖ דחה</button>
              </div>
            </div>
          ))
        )}
      </div>

      <div className="form-row">
        <div className="glass-card">
          <h3 style={{ marginBottom: 14 }}>אנשי קשר מאושרים למענה אוטומטי</h3>
          <form onSubmit={handleAddContact} style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
            <input className="form-input" placeholder="שם" value={newContact.name} onChange={e => setNewContact(p => ({ ...p, name: e.target.value }))} />
            <input className="form-input" placeholder="טלפון" value={newContact.phone} onChange={e => setNewContact(p => ({ ...p, phone: e.target.value }))} />
            <button className="btn btn-primary" type="submit">הוסף</button>
          </form>
          {contacts.map(c => (
            <div key={c.id} className="list-row">
              <div className="list-row-main">
                <div className="list-row-title">{c.name}</div>
                <div className="list-row-sub">{c.phone}</div>
              </div>
              <button className="btn btn-sm btn-danger" onClick={() => handleDeleteContact(c.id)}>הסר</button>
            </div>
          ))}
        </div>

        <div className="glass-card">
          <h3 style={{ marginBottom: 14 }}>שאלות נפוצות (למספרים לא שמורים)</h3>
          <form onSubmit={handleAddFaq} style={{ marginBottom: 14 }}>
            <input className="form-input" placeholder="שאלה" value={newFaq.question} onChange={e => setNewFaq(p => ({ ...p, question: e.target.value }))} style={{ marginBottom: 8 }} />
            <textarea className="form-textarea" placeholder="תשובה" value={newFaq.answer} onChange={e => setNewFaq(p => ({ ...p, answer: e.target.value }))} style={{ marginBottom: 8 }} />
            <button className="btn btn-primary" type="submit">הוסף</button>
          </form>
          {faqs.map(f => (
            <div key={f.id} className="list-row">
              <div className="list-row-main">
                <div className="list-row-title">{f.question}</div>
                <div className="list-row-sub">{f.answer}</div>
              </div>
              <button className="btn btn-sm btn-danger" onClick={() => handleDeleteFaq(f.id)}>הסר</button>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}
