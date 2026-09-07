import { useMemo, useState } from 'react';
import * as XLSX from 'xlsx';
import Modal from './Modal.jsx';
import { api } from '../api.js';
import { useToast } from './Toast.jsx';

const PLACEHOLDER_RE = /\{([^}]+)\}/g;

function mergeTemplate(template, row) {
  return template.replace(PLACEHOLDER_RE, (match, field) => {
    const value = row[field.trim()];
    return value !== undefined && value !== null && String(value).trim() !== '' ? String(value) : match;
  });
}

export default function BulkExcelModal({ onClose, onDone }) {
  const [fileName, setFileName] = useState('');
  const [headers, setHeaders] = useState([]);
  const [rows, setRows] = useState([]);
  const [phoneField, setPhoneField] = useState('');
  const [nameField, setNameField] = useState('');
  const [template, setTemplate] = useState('');
  const [minGap, setMinGap] = useState(30);
  const [maxGap, setMaxGap] = useState(90);
  const [startMode, setStartMode] = useState('now'); // 'now' | 'custom'
  const [startAt, setStartAt] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [progress, setProgress] = useState(0);
  const toast = useToast();

  async function handleFile(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    setFileName(file.name);
    try {
      const buf = await file.arrayBuffer();
      const wb = XLSX.read(buf, { type: 'array' });
      const sheet = wb.Sheets[wb.SheetNames[0]];
      const json = XLSX.utils.sheet_to_json(sheet, { defval: '' });
      if (json.length === 0) { toast('הקובץ ריק או שאין בו שורות נתונים', 'error'); return; }
      const hdrs = Object.keys(json[0]);
      setHeaders(hdrs);
      setRows(json);
      const phoneGuess = hdrs.find(h => /טלפון|נייד|phone|מספר/i.test(h)) || hdrs[0];
      setPhoneField(phoneGuess);
      const nameGuess = hdrs.find(h => h !== phoneGuess && /שם|name/i.test(h));
      setNameField(nameGuess || '');
    } catch {
      toast('שגיאה בקריאת הקובץ — ודא שזה קובץ Excel תקין (xlsx/xls)', 'error');
    }
  }

  const validRows = useMemo(
    () => (phoneField ? rows.filter(r => String(r[phoneField] || '').trim()) : []),
    [rows, phoneField]
  );

  const preview = useMemo(() => validRows.slice(0, 3).map(r => mergeTemplate(template, r)), [validRows, template]);

  const estimatedSeconds = validRows.length > 1 ? (validRows.length - 1) * ((minGap + maxGap) / 2) : 0;
  const estimatedLabel = estimatedSeconds >= 60 ? `${Math.round(estimatedSeconds / 60)} דקות` : `${Math.round(estimatedSeconds)} שניות`;

  async function handleSend() {
    if (validRows.length === 0) { toast('אין שורות עם מספר טלפון בעמודה שנבחרה', 'error'); return; }
    if (!template.trim()) { toast('חסרה תבנית הודעה', 'error'); return; }
    if (minGap < 0 || maxGap < minGap) { toast('טווח המרווח בין הודעות לא תקין', 'error'); return; }
    if (startMode === 'custom' && !startAt) { toast('חסר מועד התחלה', 'error'); return; }

    setSubmitting(true);
    setProgress(0);
    let sentCount = 0;
    try {
      let cursor = startMode === 'custom' ? new Date(startAt) : new Date();
      for (let i = 0; i < validRows.length; i++) {
        const row = validRows[i];
        if (i > 0) {
          const gapSec = minGap + Math.random() * (maxGap - minGap);
          cursor = new Date(cursor.getTime() + gapSec * 1000);
        }
        await api.createScheduledMessage({
          chat_id: String(row[phoneField]).trim(),
          display_name: nameField ? (String(row[nameField] || '').trim() || null) : null,
          type: 'text',
          content: mergeTemplate(template, row),
          scheduled_at: cursor.toISOString(),
          repeat: null
        });
        sentCount++;
        setProgress(sentCount);
      }
      toast(`תוזמנו ${sentCount} הודעות בהצלחה, פרוסות על פני ${estimatedLabel}`, 'success');
      onDone?.();
    } catch (err) {
      toast(`שגיאה אחרי ${sentCount} מתוך ${validRows.length}: ${err.message}`, 'error');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal title="📊 הודעה מרובה מאקסל" onClose={onClose} maxWidth={640}>
      <div className="form-group">
        <label className="form-label">קובץ אקסל (עם עמודת טלפון, ושדות נוספים לפי הצורך)</label>
        <input className="form-input" type="file" accept=".xlsx,.xls" onChange={handleFile} />
        {fileName && <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginTop: 6 }}>{fileName} — {rows.length} שורות נמצאו</div>}
      </div>

      {headers.length > 0 && (
        <>
          <div className="form-row">
            <div className="form-group">
              <label className="form-label">עמודת הטלפון</label>
              <select className="form-select" value={phoneField} onChange={(e) => setPhoneField(e.target.value)}>
                {headers.map(h => <option key={h} value={h}>{h}</option>)}
              </select>
            </div>
            <div className="form-group">
              <label className="form-label">עמודת שם לתצוגה (אופציונלי)</label>
              <select className="form-select" value={nameField} onChange={(e) => setNameField(e.target.value)}>
                <option value="">— ללא —</option>
                {headers.map(h => <option key={h} value={h}>{h}</option>)}
              </select>
            </div>
          </div>

          <div className="form-group">
            <label className="form-label">תבנית ההודעה</label>
            <textarea
              className="form-textarea"
              placeholder="לדוגמה: שלום {שם}, מאחלים לך ולמשפחתך חג שמח!"
              value={template}
              onChange={(e) => setTemplate(e.target.value)}
            />
            <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)', marginTop: 6 }}>
              שדות זמינים מהקובץ: {headers.map(h => `{${h}}`).join('  ')}
            </div>
          </div>

          {validRows.length > 0 && template.trim() && (
            <div className="form-group">
              <label className="form-label">תצוגה מקדימה ({validRows.length} נמענים תקינים)</label>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {preview.map((p, i) => (
                  <div key={i} style={{ fontSize: '0.82rem', padding: '8px 10px', background: 'var(--bg-secondary, rgba(0,0,0,0.03))', borderRadius: 6, whiteSpace: 'pre-wrap' }}>{p}</div>
                ))}
              </div>
            </div>
          )}

          <div className="form-row">
            <div className="form-group">
              <label className="form-label">מרווח מינימלי בין הודעות (שניות)</label>
              <input className="form-input" type="number" min="0" value={minGap} onChange={(e) => setMinGap(Number(e.target.value))} />
            </div>
            <div className="form-group">
              <label className="form-label">מרווח מקסימלי בין הודעות (שניות)</label>
              <input className="form-input" type="number" min="0" value={maxGap} onChange={(e) => setMaxGap(Number(e.target.value))} />
            </div>
          </div>
          {validRows.length > 1 && (
            <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginBottom: 14 }}>
              הזמן הכולל המשוער לפריסת כל ההודעות: כ-{estimatedLabel} (מרווח אקראי בטווח שנקבע, כדי שהשליחה לא תיראה כמו הודעה גורפת חשודה)
            </div>
          )}

          <div className="form-group">
            <label className="form-label">מתי להתחיל</label>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <select className="form-select" style={{ maxWidth: 160 }} value={startMode} onChange={(e) => setStartMode(e.target.value)}>
                <option value="now">מיד</option>
                <option value="custom">מועד מסוים</option>
              </select>
              {startMode === 'custom' && (
                <input
                  className="form-input"
                  type="datetime-local"
                  dir="ltr"
                  value={startAt}
                  onChange={(e) => setStartAt(e.target.value)}
                />
              )}
            </div>
          </div>

          {submitting && (
            <div style={{ fontSize: '0.85rem', marginBottom: 12 }}>מתזמן... {progress} / {validRows.length}</div>
          )}

          <div style={{ display: 'flex', gap: 10 }}>
            <button className="btn btn-primary" type="button" onClick={handleSend} disabled={submitting || validRows.length === 0}>
              {submitting ? 'מתזמן...' : `🚀 תזמן ${validRows.length ? `(${validRows.length})` : ''}`}
            </button>
            <button className="btn" type="button" onClick={onClose} disabled={submitting}>ביטול</button>
          </div>
        </>
      )}
    </Modal>
  );
}
