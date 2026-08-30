import { useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import { useToast } from '../components/Toast.jsx';
import Modal from '../components/Modal.jsx';
import SortTh from '../components/SortTh.jsx';
import { useSort } from '../hooks/useSort.js';

const TYPE_BUTTONS = [
  { key: 'text', mediaKind: null, label: 'טקסט', icon: '💬' },
  { key: 'media', mediaKind: 'image', label: 'תמונה', icon: '🖼️' },
  { key: 'media', mediaKind: 'video', label: 'וידאו', icon: '🎬' },
  { key: 'media', mediaKind: 'audio', label: 'אודיו', icon: '🎵' },
  { key: 'media', mediaKind: 'file', label: 'קובץ', icon: '📎' },
  { key: 'location', mediaKind: null, label: 'מיקום', icon: '📍' },
  { key: 'poll', mediaKind: null, label: 'סקר', icon: '📊' },
  { key: 'contact', mediaKind: null, label: 'איש קשר', icon: '👤' }
];

const TYPE_LABEL = { text: '💬 טקסט', media: '📎 מדיה', location: '📍 מיקום', poll: '📊 סקר', contact: '👤 איש קשר' };

const emptyForm = {
  query: '', chat_id: '', display_name: '',
  type: 'text', mediaKind: null,
  content: '', media_url: '', media_filename: '',
  location: { lat: '', lng: '', name: '', address: '' },
  poll_options: ['', ''], poll_multiple: false,
  contact: { phone: '', firstName: '', lastName: '' },
  scheduled_at: '', repeat: ''
};

export default function ScheduledMessagesPage() {
  const [messages, setMessages] = useState([]);
  const [chats, setChats] = useState([]);
  const [contacts, setContacts] = useState([]);
  const [statusFilter, setStatusFilter] = useState('all');
  const [modalOpen, setModalOpen] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const [suggestOpen, setSuggestOpen] = useState(false);
  const [checking, setChecking] = useState(false);
  const [checkResult, setCheckResult] = useState(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const toast = useToast();

  async function load() {
    setLoading(true);
    try {
      const [m, c, ct] = await Promise.all([api.getScheduledMessages(), api.getChats(), api.getContacts()]);
      setMessages(m);
      setChats(c);
      setContacts(ct);
    } catch (err) { toast(err.message, 'error'); } finally { setLoading(false); }
  }

  useEffect(() => { load(); }, []);

  const suggestions = useMemo(() => {
    const q = form.query.trim().toLowerCase();
    if (!q) return [];
    const fromContacts = contacts.map(c => ({ label: c.name, chat_id: c.chat_id, tag: 'איש קשר' }));
    const fromChats = chats.map(c => ({ label: c.name, chat_id: c.chat_id, tag: c.chat_id.endsWith('@g.us') ? 'קבוצה' : "צ'אט" }));
    return [...fromContacts, ...fromChats]
      .filter(s => s.label?.toLowerCase().includes(q) || s.chat_id.includes(q))
      .slice(0, 8);
  }, [form.query, chats, contacts]);

  function selectSuggestion(s) {
    setForm(p => ({ ...p, query: s.label, chat_id: s.chat_id, display_name: p.display_name || s.label }));
    setSuggestOpen(false);
    setCheckResult(null);
  }

  async function handleCheckPhone() {
    setChecking(true);
    setCheckResult(null);
    try {
      const res = await api.checkPhone(form.query.trim());
      setCheckResult(res);
      if (res.existsWhatsapp) {
        setForm(p => ({ ...p, chat_id: res.chatId || p.query.trim() }));
        toast('המספר קיים בוואטסאפ', 'success');
      } else {
        toast('המספר לא נמצא בוואטסאפ', 'error');
      }
    } catch (err) { toast(err.message, 'error'); } finally { setChecking(false); }
  }

  function selectType(btn) {
    setForm(p => ({ ...p, type: btn.key, mediaKind: btn.mediaKind }));
  }

  function updatePollOption(i, value) {
    setForm(p => { const opts = [...p.poll_options]; opts[i] = value; return { ...p, poll_options: opts }; });
  }
  function addPollOption() { setForm(p => ({ ...p, poll_options: [...p.poll_options, ''] })); }
  function removePollOption(i) { setForm(p => ({ ...p, poll_options: p.poll_options.filter((_, idx) => idx !== i) })); }

  function resetForm() { setForm(emptyForm); setCheckResult(null); }

  async function handleSubmit(e) {
    e.preventDefault();
    const recipient = form.chat_id || form.query.trim();
    if (!recipient || !form.scheduled_at) { toast('חסר נמען או מועד שליחה', 'error'); return; }

    const payload = {
      chat_id: recipient,
      display_name: form.display_name || null,
      type: form.type,
      scheduled_at: new Date(form.scheduled_at).toISOString(),
      repeat: form.repeat || null
    };
    if (form.type === 'text') {
      if (!form.content.trim()) { toast('חסר תוכן ההודעה', 'error'); return; }
      payload.content = form.content;
    } else if (form.type === 'media') {
      if (!form.media_url.trim()) { toast('חסר קישור למדיה', 'error'); return; }
      payload.media_url = form.media_url;
      payload.media_filename = form.media_filename || null;
      payload.content = form.content || '';
    } else if (form.type === 'location') {
      if (!form.location.lat || !form.location.lng) { toast('חסרות קואורדינטות מיקום', 'error'); return; }
      payload.location = { ...form.location, lat: Number(form.location.lat), lng: Number(form.location.lng) };
    } else if (form.type === 'poll') {
      const options = form.poll_options.map(o => o.trim()).filter(Boolean);
      if (!form.content.trim() || options.length < 2) { toast('סקר דורש שאלה ולפחות שתי אפשרויות', 'error'); return; }
      payload.content = form.content;
      payload.poll_options = options;
      payload.poll_multiple = form.poll_multiple;
    } else if (form.type === 'contact') {
      if (!form.contact.phone || !form.contact.firstName) { toast('חסר טלפון או שם פרטי לאיש הקשר', 'error'); return; }
      payload.contact = form.contact;
    }

    setSubmitting(true);
    try {
      await api.createScheduledMessage(payload);
      toast('ההודעה תוזמנה', 'success');
      setModalOpen(false);
      resetForm();
      await load();
    } catch (err) { toast(err.message, 'error'); } finally { setSubmitting(false); }
  }

  async function handleDelete(id) {
    try { await api.deleteScheduledMessage(id); await load(); } catch (err) { toast(err.message, 'error'); }
  }

  const counts = useMemo(() => ({
    all: messages.length,
    pending: messages.filter(m => m.status === 'pending').length,
    sent: messages.filter(m => m.status === 'sent').length,
    failed: messages.filter(m => m.status === 'failed').length
  }), [messages]);

  const filteredMessages = statusFilter === 'all' ? messages : messages.filter(m => m.status === statusFilter);
  const { sorted, sortKey, sortDir, requestSort } = useSort(filteredMessages, 'scheduled_at', 'desc');

  function statusBadge(status) {
    if (status === 'sent') return <span className="badge badge-success">נשלח</span>;
    if (status === 'failed') return <span className="badge badge-danger">נכשל</span>;
    return <span className="badge badge-info">ממתין</span>;
  }

  function summarizeContent(m) {
    if (m.type === 'location') return m.location?.name || m.location?.address || 'מיקום';
    if (m.type === 'contact') return `${m.contact?.firstName || ''} ${m.contact?.lastName || ''}`.trim() || m.contact?.phone;
    return m.content || (m.type === 'media' ? '(מדיה ללא כיתוב)' : '—');
  }

  return (
    <>
      <div className="page-header">
        <div className="page-title">
          <h2>📨 הודעות מתוזמנות</h2>
          <p>תזמן הודעות WhatsApp לשליחה אוטומטית בשעות מדויקות</p>
        </div>
        <div style={{ display: 'flex', gap: 10 }}>
          <button className="btn" onClick={load}>🔄 רענן</button>
          <button className="btn btn-primary" onClick={() => { resetForm(); setModalOpen(true); }}>+ הודעה חדשה</button>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 8, marginBottom: 18, flexWrap: 'wrap' }}>
        {[['all', 'הכל'], ['pending', 'ממתינות'], ['sent', 'נשלחו'], ['failed', 'נכשלו']].map(([key, label]) => (
          <button
            key={key}
            className="btn btn-sm"
            style={statusFilter === key ? { background: 'var(--accent-primary-glow)', color: 'var(--accent-primary)', borderColor: 'rgba(79,70,229,0.2)' } : {}}
            onClick={() => setStatusFilter(key)}
          >
            {label} ({counts[key]})
          </button>
        ))}
      </div>

      <div className="glass-card">
        {loading ? (
          <div className="empty-state">טוען...</div>
        ) : sorted.length === 0 ? (
          <div className="empty-state"><div className="empty-state-icon">📨</div><p>אין הודעות בקטגוריה זו.</p></div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table className="data-table">
              <thead>
                <tr>
                  <SortTh label="#" sortKey="id" currentKey={sortKey} currentDir={sortDir} onSort={requestSort} />
                  <SortTh label="נמען" sortKey="display_name" currentKey={sortKey} currentDir={sortDir} onSort={requestSort} />
                  <SortTh label="סוג" sortKey="type" currentKey={sortKey} currentDir={sortDir} onSort={requestSort} />
                  <th>תוכן</th>
                  <SortTh label="מועד" sortKey="scheduled_at" currentKey={sortKey} currentDir={sortDir} onSort={requestSort} />
                  <SortTh label="חזרה" sortKey="repeat" currentKey={sortKey} currentDir={sortDir} onSort={requestSort} />
                  <SortTh label="סטטוס" sortKey="status" currentKey={sortKey} currentDir={sortDir} onSort={requestSort} />
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {sorted.map(m => (
                  <tr key={m.id}>
                    <td className="row-id">#{m.id}</td>
                    <td>{m.display_name || m.chat_id}</td>
                    <td>{TYPE_LABEL[m.type] || m.type}</td>
                    <td style={{ maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{summarizeContent(m)}</td>
                    <td>{new Date(m.scheduled_at).toLocaleString('he-IL')}</td>
                    <td>{m.repeat || '—'}</td>
                    <td>{statusBadge(m.status)}</td>
                    <td><button className="btn btn-sm btn-danger" onClick={() => handleDelete(m.id)}>מחק</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {modalOpen && (
        <Modal title="📨 הודעה מתוזמנת חדשה" onClose={() => setModalOpen(false)}>
          <form onSubmit={handleSubmit}>
            <div className="form-group autocomplete-wrap">
              <label className="form-label">נמען</label>
              <div style={{ display: 'flex', gap: 8 }}>
                <input
                  className="form-input"
                  placeholder="חפש לפי שם, כינוי, מספר, או שם קבוצה..."
                  value={form.query}
                  onChange={(e) => { setForm(p => ({ ...p, query: e.target.value, chat_id: '' })); setSuggestOpen(true); setCheckResult(null); }}
                  onFocus={() => setSuggestOpen(true)}
                />
                {!form.chat_id && (
                  <button type="button" className="btn btn-sm" onClick={handleCheckPhone} disabled={checking || !form.query.trim()}>
                    {checking ? '...' : '✓ בדוק'}
                  </button>
                )}
              </div>
              {suggestOpen && suggestions.length > 0 && (
                <div className="autocomplete-list">
                  {suggestions.map(s => (
                    <div key={s.chat_id} className="autocomplete-item" onClick={() => selectSuggestion(s)}>
                      <span>{s.label}</span>
                      <span className="tag">{s.tag}</span>
                    </div>
                  ))}
                </div>
              )}
              {checkResult && (
                <div style={{ marginTop: 6 }}>
                  <span className={`badge ${checkResult.existsWhatsapp ? 'badge-success' : 'badge-danger'}`}>
                    {checkResult.existsWhatsapp ? 'המספר קיים בוואטסאפ' : 'המספר לא נמצא'}
                  </span>
                </div>
              )}
            </div>

            <div className="form-group">
              <label className="form-label">שם לתצוגה (אופציונלי)</label>
              <input className="form-input" value={form.display_name} onChange={(e) => setForm(p => ({ ...p, display_name: e.target.value }))} />
            </div>

            <div className="form-group">
              <label className="form-label">סוג הודעה</label>
              <div className="type-btn-group">
                {TYPE_BUTTONS.map(btn => (
                  <button
                    key={btn.label}
                    type="button"
                    className={`type-btn ${form.type === btn.key && form.mediaKind === btn.mediaKind ? 'active' : ''}`}
                    onClick={() => selectType(btn)}
                  >
                    {btn.icon} {btn.label}
                  </button>
                ))}
              </div>
            </div>

            {form.type === 'text' && (
              <div className="form-group">
                <label className="form-label">תוכן ההודעה</label>
                <textarea className="form-textarea" value={form.content} onChange={(e) => setForm(p => ({ ...p, content: e.target.value }))} />
              </div>
            )}

            {form.type === 'media' && (
              <>
                <div className="form-group">
                  <label className="form-label">
                    קישור ל{form.mediaKind === 'image' ? 'תמונה' : form.mediaKind === 'video' ? 'וידאו' : form.mediaKind === 'audio' ? 'קובץ שמע' : 'קובץ'} (URL)
                  </label>
                  <input className="form-input" value={form.media_url} onChange={(e) => setForm(p => ({ ...p, media_url: e.target.value }))} placeholder="https://..." />
                </div>
                <div className="form-group">
                  <label className="form-label">שם קובץ (אופציונלי)</label>
                  <input className="form-input" value={form.media_filename} onChange={(e) => setForm(p => ({ ...p, media_filename: e.target.value }))} />
                </div>
                <div className="form-group">
                  <label className="form-label">כיתוב (אופציונלי)</label>
                  <textarea className="form-textarea" value={form.content} onChange={(e) => setForm(p => ({ ...p, content: e.target.value }))} />
                </div>
              </>
            )}

            {form.type === 'location' && (
              <div className="form-row">
                <div className="form-group">
                  <label className="form-label">קו רוחב (lat)</label>
                  <input className="form-input" value={form.location.lat} onChange={(e) => setForm(p => ({ ...p, location: { ...p.location, lat: e.target.value } }))} />
                </div>
                <div className="form-group">
                  <label className="form-label">קו אורך (lng)</label>
                  <input className="form-input" value={form.location.lng} onChange={(e) => setForm(p => ({ ...p, location: { ...p.location, lng: e.target.value } }))} />
                </div>
                <div className="form-group">
                  <label className="form-label">שם המיקום</label>
                  <input className="form-input" value={form.location.name} onChange={(e) => setForm(p => ({ ...p, location: { ...p.location, name: e.target.value } }))} />
                </div>
                <div className="form-group">
                  <label className="form-label">כתובת</label>
                  <input className="form-input" value={form.location.address} onChange={(e) => setForm(p => ({ ...p, location: { ...p.location, address: e.target.value } }))} />
                </div>
              </div>
            )}

            {form.type === 'poll' && (
              <>
                <div className="form-group">
                  <label className="form-label">שאלת הסקר</label>
                  <input className="form-input" value={form.content} onChange={(e) => setForm(p => ({ ...p, content: e.target.value }))} />
                </div>
                <div className="form-group">
                  <label className="form-label">אפשרויות</label>
                  {form.poll_options.map((opt, i) => (
                    <div key={i} style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
                      <input className="form-input" value={opt} onChange={(e) => updatePollOption(i, e.target.value)} placeholder={`אפשרות ${i + 1}`} />
                      {form.poll_options.length > 2 && (
                        <button type="button" className="btn btn-sm btn-danger" onClick={() => removePollOption(i)}>הסר</button>
                      )}
                    </div>
                  ))}
                  <button type="button" className="btn btn-sm" onClick={addPollOption}>+ אפשרות</button>
                </div>
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: '0.88rem', marginBottom: 18 }}>
                  <input type="checkbox" checked={form.poll_multiple} onChange={(e) => setForm(p => ({ ...p, poll_multiple: e.target.checked }))} />
                  לאפשר בחירת מספר תשובות
                </label>
              </>
            )}

            {form.type === 'contact' && (
              <div className="form-row">
                <div className="form-group">
                  <label className="form-label">טלפון</label>
                  <input className="form-input" value={form.contact.phone} onChange={(e) => setForm(p => ({ ...p, contact: { ...p.contact, phone: e.target.value } }))} />
                </div>
                <div className="form-group">
                  <label className="form-label">שם פרטי</label>
                  <input className="form-input" value={form.contact.firstName} onChange={(e) => setForm(p => ({ ...p, contact: { ...p.contact, firstName: e.target.value } }))} />
                </div>
                <div className="form-group">
                  <label className="form-label">שם משפחה (אופציונלי)</label>
                  <input className="form-input" value={form.contact.lastName} onChange={(e) => setForm(p => ({ ...p, contact: { ...p.contact, lastName: e.target.value } }))} />
                </div>
              </div>
            )}

            <div className="form-row">
              <div className="form-group">
                <label className="form-label">מתי לשלוח</label>
                <input className="form-input" type="datetime-local" value={form.scheduled_at} onChange={(e) => setForm(p => ({ ...p, scheduled_at: e.target.value }))} />
              </div>
              <div className="form-group">
                <label className="form-label">חזרה</label>
                <select className="form-select" value={form.repeat} onChange={(e) => setForm(p => ({ ...p, repeat: e.target.value }))}>
                  <option value="">ללא חזרה</option>
                  <option value="daily">יומי</option>
                  <option value="weekly">שבועי</option>
                  <option value="monthly">חודשי</option>
                </select>
              </div>
            </div>

            <div style={{ display: 'flex', gap: 10 }}>
              <button className="btn btn-primary" type="submit" disabled={submitting}>{submitting ? 'מתזמן...' : '📆 תזמן'}</button>
              <button className="btn" type="button" onClick={() => setModalOpen(false)}>ביטול</button>
            </div>
          </form>
        </Modal>
      )}
    </>
  );
}
