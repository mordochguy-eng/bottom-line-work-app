import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { useToast } from '../components/Toast.jsx';

const defaults = {
  geminiApiKey: '',
  recipientChatId: '',
  digestTime: '21:00',
  briefingTime: '07:30'
};

export default function SettingsPage() {
  const [settings, setSettings] = useState(defaults);
  const [saving, setSaving] = useState(false);
  const [syncConfig, setSyncConfig] = useState(null);
  const [syncLog, setSyncLog] = useState([]);
  const [syncing, setSyncing] = useState(false);
  const [wa, setWa] = useState(null);
  const [waBusy, setWaBusy] = useState(false);
  const toast = useToast();

  async function loadWa() {
    try { setWa(await api.getWhatsappConnection()); } catch { /* backend not ready yet */ }
  }

  async function handleWaRestart() {
    setWaBusy(true);
    try { setWa(await api.whatsappRestart()); } catch (err) { toast(err.message, 'error'); } finally { setWaBusy(false); }
  }
  async function handleWaLogout() {
    if (!window.confirm('זה ינתק את החיבור הנוכחי וידרוש סריקת QR חדשה. להמשיך?')) return;
    setWaBusy(true);
    try { setWa(await api.whatsappLogout()); } catch (err) { toast(err.message, 'error'); } finally { setWaBusy(false); }
  }
  // While pairing / reconnecting, poll the connection state so the QR and status stay fresh.
  useEffect(() => {
    loadWa();
    const t = setInterval(loadWa, 3000);
    return () => clearInterval(t);
  }, []);

  async function load() {
    try {
      const [s, sc, sl] = await Promise.all([api.getSettings(), api.getSyncConfig(), api.getSyncLog()]);
      setSettings({ ...defaults, ...s });
      setSyncConfig(sc);
      setSyncLog(sl);
    } catch (err) { toast(err.message, 'error'); }
  }

  useEffect(() => { load(); }, []);

  async function handleSave(e) {
    e.preventDefault();
    setSaving(true);
    try {
      await api.saveSettings(settings);
      toast('ההגדרות נשמרו', 'success');
    } catch (err) { toast(err.message, 'error'); } finally { setSaving(false); }
  }

  async function handleSync() {
    setSyncing(true);
    try {
      const result = await api.runSync();
      if (result.npmInstallError) {
        toast(`הסנכרון הצליח אך התקנת החבילות נכשלה — ייתכן שהאפליקציה לא תעלה. פרטים: ${result.npmInstallError}`, 'error');
      } else {
        toast(`הסנכרון הצליח (${result.repo}). האפליקציה מתאתחלת מחדש...`, 'success');
      }
      setTimeout(load, 1500);
    } catch (err) { toast(err.message, 'error'); } finally { setSyncing(false); }
  }

  return (
    <>
      <div className="page-header">
        <div className="page-title">
          <h2>⚙️ הגדרות</h2>
          <p>חיבור לוואטסאפ, מפתחות API ותזמונים</p>
        </div>
      </div>

      <form onSubmit={handleSave}>
        <div className="glass-card">
          <h3 style={{ marginBottom: 8 }}>חיבור וואטסאפ</h3>
          <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem', marginBottom: 12 }}>
            החיבור רץ על המחשב הזה, ישירות מול וואטסאפ. כשהמחשב כבוי לא יישלחו הודעות מתוזמנות ולא יאספו הודעות חדשות.
          </p>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
            {wa && (
              <span className={`badge ${wa.connected ? 'badge-success' : 'badge-danger'}`}>
                {wa.connected ? `מחובר${wa.user ? ' — ' + String(wa.user.id).split(':')[0].split('@')[0] : ''}` : ({ qr: 'ממתין לסריקת QR', starting: 'מתחבר...', reconnecting: 'מתחבר מחדש...', loggedOut: 'מנותק מהטלפון', replaced: 'הוחלף בתהליך אחר', error: 'שגיאה', idle: 'לא פעיל' }[wa.status] || wa.status)}
              </span>
            )}
          </div>
          {wa && wa.hasQr && wa.qrDataUrl && (
            <div style={{ marginBottom: 12 }}>
              <p style={{ fontSize: '0.9rem', marginBottom: 6 }}>בטלפון: וואטסאפ ← מכשירים מקושרים ← קישור מכשיר, וסרוק:</p>
              <img src={wa.qrDataUrl} alt="QR" style={{ width: 240, height: 240, background: '#fff', padding: 8, borderRadius: 8 }} />
            </div>
          )}
          {wa && wa.hasQr && !wa.qrDataUrl && <p style={{ color: 'var(--text-muted)' }}>QR מוכן אך חבילת qrcode לא מותקנת — הרץ npm install ב-backend.</p>}
          {wa && wa.error && <p style={{ color: 'var(--danger, #dc2626)', fontSize: '0.85rem', marginBottom: 8 }}>{wa.error}</p>}
          {wa && wa.store && <p style={{ color: 'var(--text-muted)', fontSize: '0.8rem', marginBottom: 8 }}>נשמרו {wa.store.chats} שיחות ו-{wa.store.contacts} אנשי קשר מקומית</p>}
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button type="button" className="btn" onClick={handleWaRestart} disabled={waBusy}>🔄 התחבר מחדש</button>
            <button type="button" className="btn" onClick={handleWaLogout} disabled={waBusy}>🔑 חבר מספר אחר / QR חדש</button>
          </div>
        </div>

        <div className="glass-card">
          <h3 style={{ marginBottom: 16 }}>Gemini AI</h3>
          <div className="form-group">
            <label className="form-label">מפתח Gemini API</label>
            <input className="form-input" type="password" value={settings.geminiApiKey} onChange={e => setSettings(p => ({ ...p, geminiApiKey: e.target.value }))} />
          </div>
        </div>

        <div className="glass-card">
          <h3 style={{ marginBottom: 16 }}>יעד הודעות ותזמונים</h3>
          <div className="form-row">
            <div className="form-group">
              <label className="form-label">מספר הוואטסאפ שלך (לקבלת סיכומים ותדרוך)</label>
              <input className="form-input" value={settings.recipientChatId} onChange={e => setSettings(p => ({ ...p, recipientChatId: e.target.value }))} placeholder="972521234567@c.us" />
            </div>
            <div className="form-group">
              <label className="form-label">שעת סיכום יומי</label>
              <input className="form-input" type="time" value={settings.digestTime} onChange={e => setSettings(p => ({ ...p, digestTime: e.target.value }))} />
            </div>
            <div className="form-group">
              <label className="form-label">שעת תדרוך בוקר</label>
              <input className="form-input" type="time" value={settings.briefingTime} onChange={e => setSettings(p => ({ ...p, briefingTime: e.target.value }))} />
            </div>
          </div>
        </div>

        <button className="btn btn-primary" type="submit" disabled={saving}>{saving ? 'שומר...' : '💾 שמור הגדרות'}</button>
      </form>

      <div className="glass-card" style={{ marginTop: 24 }}>
        <h3 style={{ marginBottom: 8 }}>🔄 סנכרון גרסה בין מחשבים</h3>
        <p style={{ color: 'var(--text-secondary)', fontSize: '0.88rem', marginBottom: 14 }}>
          מושך את הקוד העדכני ביותר מהריפו הציבורי ומעדכן את המחשב הזה. הנתונים שלך (settings, קבוצות, משימות) לא נגעים.
        </p>
        <div style={{ marginBottom: 14, fontSize: '0.85rem', color: 'var(--text-muted)' }}>
          {syncConfig?.repo ? `ריפו: ${syncConfig.repo} (${syncConfig.branch})` : 'ריפו הסנכרון עדיין לא הוגדר (sync-config.json).'}
        </div>
        <button className="btn btn-primary" onClick={handleSync} disabled={syncing || !syncConfig?.repo}>
          {syncing ? 'מסנכרן...' : '🔄 סנכרן גרסה עכשיו'}
        </button>

        {syncLog.length > 0 && (
          <div style={{ marginTop: 18 }}>
            <div className="form-label">היסטוריית סנכרון</div>
            {syncLog.slice().reverse().slice(0, 5).map(entry => (
              <div key={entry.id} className="list-row">
                <div className="list-row-main">
                  <div className="list-row-title">{entry.status === 'success' ? '✅ הצלחה' : '❌ שגיאה'}</div>
                  <div className="list-row-sub">{new Date(entry.at).toLocaleString('he-IL')} {entry.error ? `— ${entry.error}` : ''}</div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}
