import { useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import { useToast } from '../components/Toast.jsx';
import Modal from '../components/Modal.jsx';
import BulkExcelModal from '../components/BulkExcelModal.jsx';
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
  query: '', recipients: [], // { chat_id, label }[] — supports sending the same message to several people/groups at once
  type: 'text', mediaKind: null,
  content: '', media_url: '', media_filename: '',
  location: { lat: '', lng: '', name: '', address: '' },
  poll_options: ['', ''], poll_multiple: false,
  contact: { phone: '', firstName: '', lastName: '' },
  scheduled_at: '', repeat: '', send_now: false
};

export default function ScheduledMessagesPage({ prefill, onConsumePrefill } = {}) {
  const [messages, setMessages] = useState([]);
  const [chats, setChats] = useState([]);
  const [contacts, setContacts] = useState([]);
  const [statusFilter, setStatusFilter] = useState('all');
  const [modalOpen, setModalOpen] = useState(false);
  const [bulkModalOpen, setBulkModalOpen] = useState(false);
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
      const [m, c, ct] = await Promise.all([api.getScheduledMessages(), api.getChats(), api.getWhatsappContacts()]);
      setMessages(m);
      setChats(c);
      setContacts(ct);
    } catch (err) { toast(err.message, 'error'); } finally { setLoading(false); }
  }

  useEffect(() => { load(); }, []);

  // Arriving here via a group's "✉️ הודעה" shortcut — open straight into a
  // pre-filled compose modal instead of making the user search for the
  // recipient again.
  useEffect(() => {
    if (!prefill) return;
    setForm({ ...emptyForm, recipients: [{ chat_id: prefill.chat_id, label: prefill.display_name || prefill.chat_id }] });
    setModalOpen(true);
    onConsumePrefill?.();
  }, [prefill]);

  const suggestions = useMemo(() => {
    const q = form.query.trim().toLowerCase();
    if (!q) return [];
    const selectedIds = new Set(form.recipients.map(r => r.chat_id));
    const fromContacts = contacts.map(c => ({ label: c.name, chat_id: c.chat_id, tag: 'איש קשר' }));
    const fromChats = chats.map(c => ({ label: c.name, chat_id: c.chat_id, tag: c.chat_id.endsWith('@g.us') ? 'קבוצה' : "צ'אט" }));
    return [...fromContacts, ...fromChats]
      .filter(s => !selectedIds.has(s.chat_id))
      .filter(s => s.label?.toLowerCase().includes(q) || s.chat_id.includes(q))
      .slice(0, 8);
  }, [form.query, chats, contacts, form.recipients]);

  function addRecipient(chat_id, label) {
    setForm(p => p.recipients.some(r => r.chat_id === chat_id)
      ? { ...p, query: '' }
      : { ...p, recipients: [...p.recipients, { chat_id, label }], query: '' });
    setSuggestOpen(false);
    setCheckResult(null);
  }

  function removeRecipient(chat_id) {
    setForm(p => ({ ...p, recipients: p.recipients.filter(r => r.chat_id !== chat_id) }));
  }

  function selectSuggestion(s) { addRecipient(s.chat_id, s.label); }

  async function handleCheckPhone() {
    const raw = form.query.trim();
    if (!raw) return;
    setChecking(true);
    setCheckResult(null);
    try {
      const res = await api.checkPhone(raw);
      setCheckResult(res);
      if (res.existsWhatsapp) {
        addRecipient(res.chatId || raw, raw);
        toast('הנמען נוסף', 'success');
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
    if (form.recipients.length === 0) { toast('לא נבחר אף נמען', 'error'); return; }
    if (!form.send_now && !form.scheduled_at) { toast('חסר מועד שליחה', 'error'); return; }

    const base = {
      type: form.type,
      // "שלח מיד" reuses the exact same scheduling path — scheduling for
      // right now means the existing per-minute dispatcher picks it up
      // within the next minute, well inside the 1-hour expiry window.
      scheduled_at: form.send_now ? new Date().toISOString() : new Date(form.scheduled_at).toISOString(),
      repeat: form.send_now ? null : (form.repeat || null)
    };
    if (form.type === 'text') {
      if (!form.content.trim()) { toast('חסר תוכן ההודעה', 'error'); return; }
      base.content = form.content;
    } else if (form.type === 'media') {
      if (!form.media_url.trim()) { toast('חסר קישור למדיה', 'error'); return; }
      base.media_url = form.media_url;
      base.media_filename = form.media_filename || null;
      base.content = form.content || '';
    } else if (form.type === 'location') {
      if (!form.location.lat || !form.location.lng) { toast('חסרות קואורדינטות מיקום', 'error'); return; }
      base.location = { ...form.location, lat: Number(form.location.lat), lng: Number(form.location.lng) };
    } else if (form.type === 'poll') {
      const options = form.poll_options.map(o => o.trim()).filter(Boolean);
      if (!form.content.trim() || options.length < 2) { toast('סקר דורש שאלה ולפחות שתי אפשרויות', 'error'); return; }
      base.content = form.content;
      base.poll_options = options;
      base.poll_multiple = form.poll_multiple;
    } else if (form.type === 'contact') {
      if (!form.contact.phone || !form.contact.firstName) { toast('חסר טלפון או שם פרטי לאיש הקשר', 'error'); return; }
      base.contact = form.contact;
    }

    setSubmitting(true);
    try {
      // One scheduled-message row per recipient — same content and timing, sent independently.
      await Promise.all(form.recipients.map(r =>
        api.createScheduledMessage({ ...base, chat_id: r.chat_id, display_name: r.label || null })
      ));
      toast(form.recipients.length > 1 ? `ההודעה תוזמנה ל-${form.recipients.length} נמענים` : 'ההודעה תוזמנה', 'success');
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
          <button className="btn" onClick={() => setBulkModalOpen(true)}>📊 הודעה מרובה מאקסל</button>
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
              <label className="form-label">נמענים {form.recipients.length > 1 && `(${form.recipients.length})`}</label>
              {form.recipients.length > 0 && (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
                  {form.recipients.map(r => (
                    <span key={r.chat_id} className="badge badge-info" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '4px 8px' }}>
                      {r.label || r.chat_id}
                      <button
                        type="button"
                        onClick={() => removeRecipient(r.chat_id)}
                        style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'inherit', fontWeight: 'bold', padding: 0, lineHeight: 1 }}
                        aria-label="הסר נמען"
                      >
                        ×
                      </button>
                    </span>
                  ))}
                </div>
              )}
              <div style={{ display: 'flex', gap: 8 }}>
                <input
                  className="form-input"
                  placeholder="חפש לפי שם, כינוי, מספר, או שם קבוצה... אפשר להוסיף כמה נמענים"
                  value={form.query}
                  onChange={(e) => { setForm(p => ({ ...p, query: e.target.value })); setSuggestOpen(true); setCheckResult(null); }}
                  onFocus={() => setSuggestOpen(true)}
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); handleCheckPhone(); } }}
                />
                <button type="button" className="btn btn-sm" onClick={handleCheckPhone} disabled={checking || !form.query.trim()}>
                  {checking ? '...' : '+ הוסף'}
                </button>
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
              {checkResult && !checkResult.existsWhatsapp && (
                <div style={{ marginTop: 6 }}>
                  <span className="badge badge-danger">המספר לא נמצא בוואטסאפ</span>
                </div>
              )}
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

            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: '0.88rem', marginBottom: 14 }}>
              <input type="checkbox" checked={form.send_now} onChange={(e) => setForm(p => ({ ...p, send_now: e.target.checked }))} />
              🚀 שלח מיד (בתוך כדקה, בלי לתזמן)
            </label>

            <div className="form-row" style={form.send_now ? { opacity: 0.5, pointerEvents: 'none' } : undefined}>
              <div className="form-group">
                <label className="form-label">מתי לשלוח</label>
                <div style={{ display: 'flex', gap: 8 }}>
                  <input
                    className="form-input"
                    type="date"
                    dir="ltr"
                    disabled={form.send_now}
                    value={form.scheduled_at.slice(0, 10)}
                    onChange={(e) => setForm(p => ({ ...p, scheduled_at: `${e.target.value}T${p.scheduled_at.slice(11, 16) || '09:00'}` }))}
                  />
                  <input
                    className="form-input"
                    type="time"
                    dir="ltr"
                    style={{ maxWidth: 120 }}
                    disabled={form.send_now}
                    value={form.scheduled_at.slice(11, 16)}
                    onChange={(e) => setForm(p => ({ ...p, scheduled_at: `${p.scheduled_at.slice(0, 10) || new Date().toISOString().slice(0, 10)}T${e.target.value}` }))}
                  />
                </div>
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
              <button className="btn btn-primary" type="submit" disabled={submitting}>
                {submitting ? (form.send_now ? 'שולח...' : 'מתזמן...') : (form.send_now ? '🚀 שלח עכשיו' : '📆 תזמן')}
              </button>
              <button className="btn" type="button" onClick={() => setModalOpen(false)}>ביטול</button>
            </div>
          </form>
        </Modal>
      )}

      {bulkModalOpen && (
        <BulkExcelModal
          onClose={() => setBulkModalOpen(false)}
          onDone={() => { setBulkModalOpen(false); load(); }}
        />
      )}
    </>
  );
}
