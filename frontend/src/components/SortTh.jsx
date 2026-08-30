export default function SortTh({ label, sortKey, currentKey, currentDir, onSort }) {
  const active = sortKey === currentKey;
  return (
    <th className="sortable-th" onClick={() => onSort(sortKey)}>
      {label}
      {active && <span className="sort-icon">{currentDir === 'asc' ? '▲' : '▼'}</span>}
    </th>
  );
}
