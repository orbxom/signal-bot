interface Column<T> {
  key: string
  header: string
  render?: (row: T) => React.ReactNode
}

interface DataTableProps<T> {
  columns: Column<T>[]
  data: T[]
  onRowClick?: (row: T) => void
  loading?: boolean
  emptyMessage?: string
}

export default function DataTable<T extends Record<string, unknown>>({
  columns, data, onRowClick, loading, emptyMessage = 'No data'
}: DataTableProps<T>) {
  if (loading) return <div className="loading">Loading...</div>
  if (data.length === 0) return <div className="empty">{emptyMessage}</div>

  return (
    <table className="data-table">
      <thead>
        <tr>
          {columns.map(col => <th key={col.key}>{col.header}</th>)}
        </tr>
      </thead>
      <tbody>
        {data.map((row, i) => (
          <tr key={i} onClick={() => onRowClick?.(row)} className={onRowClick ? 'clickable' : ''}>
            {columns.map(col => (
              <td key={col.key}>
                {col.render ? col.render(row) : String(row[col.key] ?? '')}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  )
}
