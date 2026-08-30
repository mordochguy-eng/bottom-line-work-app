import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { useToast } from '../components/Toast.jsx';

const defaults = {
  apiUrl: 'https://api.green-api.com',
  idInstance: '',
  apiTokenInstance: '',
  geminiApiKey: '',
  recipientChatId: '',
  digestTime: '21:00',
  briefingTime: '07:30'
};

export default function SettingsPage() {
  const [settings, setSettings] = useState(defaults);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState(null);
  const [checking, setChecking] = useState(false);
  const [syncConfig, setSyncConfig] = useState(null);
  const [syncLog, setSyncLog] = useState([]);
  const [syncing, setSyncing] = useState(false);
  const toast = useToast();

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

  async function handleCheckConnection() {
    setChecking(true);
    try {
      const res = await api.getInstanceStatus();
      setStatus(res);
      toast(res.connected ? 'מחובר בהצלחה ל-Green API' : `לא מחובר: ${res.reason || res.raw?.stateInstance || ''}`, res.connected ? 'success' : 'error');
    } catch (err) { toast(err.message, 'error'); } finally { setChecking(false); }
  }

  async function handleSync() {
    setSyncing(true);
    try {
      const result = await api.runSync();
      toast(`הסנכרון הצליח (${result.repo}). האפליקציה מתאתחלת מחדש...`, 'success');
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
          <h3 style={{ marginBottom: 16 }}>Green API (חיבור וואטסאפ)</h3>
          <div className="form-row">
            <div className="form-group">
              <label className="form-label">כתובת API</label>
              <input className="form-input" value={settings.apiUrl} onChange={e => setSettings(p => ({ ...p, apiUrl: e.target.value }))} />
            </div>
            <div className="form-group">
              <label className="form-label">idInstance</label>
              <input className="form-input" value={settings.idInstance} onChange={e => setSettings(p => ({ ...p, idInstance: e.target.value }))} />
            </div>
            <div className="form-group">
              <label className="form-label">apiTokenInstance</label>
              <input className="form-input" type="password" value={settings.apiTokenInstance} onChange={e => setSettings(p => ({ ...p, apiTokenInstance: e.target.value }))} />
            </div>
          </div>
          <button type="button" className="btn" onClick={handleCheckConnection} disabled={checking}>
            {checking ? 'בודק...' : '🔌 בדוק חיבור'}
          </button>
          {status && (
            <span className={`badge ${status.connected ? 'badge-success' : 'badge-danger'}`} style={{ marginRight: 12 }}>
              {status.connected ? 'מחובר' : 'לא מחובר'}
            </span>
          )}
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
