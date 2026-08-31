import { useEffect, useState } from 'react';
import { ToastProvider } from './components/Toast.jsx';
import { api } from './api.js';
import HomePage from './pages/HomePage.jsx';
import GroupsPage from './pages/GroupsPage.jsx';
import TasksPage from './pages/TasksPage.jsx';
import ApprovalQueuePage from './pages/ApprovalQueuePage.jsx';
import ScheduledMessagesPage from './pages/ScheduledMessagesPage.jsx';
import ActivityLogPage from './pages/ActivityLogPage.jsx';
import SettingsPage from './pages/SettingsPage.jsx';

const NAV_ITEMS = [
  { key: 'home', label: 'דף הבית', icon: '🏠' },
  { key: 'groups', label: 'קבוצות מעקב', icon: '💬' },
  { key: 'tasks', label: 'משימות', icon: '✅' },
  { key: 'queue', label: 'תור אישור תגובות', icon: '📥' },
  { key: 'scheduled', label: 'הודעות מתוזמנות', icon: '📨' },
  { key: 'activity', label: 'יומן פעולות', icon: '🕘' },
  { key: 'settings', label: 'הגדרות', icon: '⚙️' }
];

function AppInner() {
  const [activeTab, setActiveTab] = useState('home');
  const [pendingCount, setPendingCount] = useState(0);

  useEffect(() => {
    let cancelled = false;
    async function pollQueue() {
      try {
        const queue = await api.getApprovalQueue();
        if (!cancelled) setPendingCount(queue.filter(q => q.status === 'pending').length);
      } catch { /* silent — polled in the background */ }
    }
    pollQueue();
    const interval = setInterval(pollQueue, 15000);
    return () => { cancelled = true; clearInterval(interval); };
  }, []);

  const Page = {
    home: HomePage,
    groups: GroupsPage,
    tasks: TasksPage,
    queue: ApprovalQueuePage,
    scheduled: ScheduledMessagesPage,
    activity: ActivityLogPage,
    settings: SettingsPage
  }[activeTab];

  return (
    <div className="app-container">
      <aside className="sidebar">
        <div className="sidebar-logo">
          <div className="sidebar-logo-icon">📊</div>
          <div className="sidebar-logo-text">
            <h1>בשורה התחתונה</h1>
            <span>עבודה</span>
          </div>
        </div>
        <ul className="sidebar-menu">
          {NAV_ITEMS.map(item => (
            <li key={item.key} className={`sidebar-item ${activeTab === item.key ? 'active' : ''}`}>
              <button onClick={() => setActiveTab(item.key)}>
                <span className="icon">{item.icon}</span>
                <span>{item.label}</span>
                {item.key === 'queue' && pendingCount > 0 && <span className="sidebar-badge">{pendingCount}</span>}
              </button>
            </li>
          ))}
        </ul>
        <div className="sidebar-footer">דשבורד וואטסאפ אישי לעבודה</div>
      </aside>
      <main className="main-content">
        <Page />
      </main>
    </div>
  );
}

export default function App() {
  return (
    <ToastProvider>
      <AppInner />
    </ToastProvider>
  );
}
