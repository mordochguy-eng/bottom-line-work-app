export const CATEGORIES = {
  info: { label: 'קבוצות לידיעה', icon: '🔔', color: '#0891b2', badge: 'badge-info' },
  customers: { label: 'קבוצות לקוחות', icon: '🤝', color: '#b45309', badge: 'badge-warning' },
  distribution: { label: 'קבוצות הפצה', icon: '📢', color: '#7e22ce', badge: 'badge-purple' },
  general: { label: 'כללי', icon: '📂', color: '#475569', badge: 'badge-muted' }
};

export const CATEGORY_ORDER = ['customers', 'distribution', 'info', 'general'];

export function categoryInfo(key) {
  return CATEGORIES[key] || CATEGORIES.general;
}
