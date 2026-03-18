import { useApi, apiCall } from '../hooks/useApi'
import StatusCard from '../components/StatusCard'
import DataTable from '../components/DataTable'

interface AttachmentMeta {
  id: string
  groupId: string
  sender: string
  contentType: string
  timestamp: number
}

interface AttachmentStats {
  totalSize: number
  countByGroup: Array<{ groupId: string; count: number; size: number }>
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export default function Attachments() {
  const { data: stats } = useApi<AttachmentStats>('/api/attachments/stats')
  const { data: attachments, loading, refetch } = useApi<AttachmentMeta[]>('/api/attachments?limit=100')

  const totalCount = stats?.countByGroup.reduce((sum, g) => sum + g.count, 0) ?? 0

  async function handleDelete(id: string) {
    await apiCall('DELETE', `/api/attachments/${id}`)
    refetch()
  }

  const columns = [
    {
      key: 'preview',
      header: 'Preview',
      render: (a: AttachmentMeta) => (
        <img
          src={`/api/attachments/${a.id}/image`}
          alt=""
          style={{ width: 48, height: 48, objectFit: 'cover', borderRadius: 4, background: '#0d0d1a' }}
          loading="lazy"
        />
      ),
    },
    { key: 'groupId', header: 'Group', render: (a: AttachmentMeta) => a.groupId.slice(0, 8) + '...' },
    { key: 'sender', header: 'Sender', render: (a: AttachmentMeta) => a.sender.slice(-4) },
    { key: 'contentType', header: 'Type' },
    {
      key: 'timestamp',
      header: 'Time',
      render: (a: AttachmentMeta) => new Date(a.timestamp).toLocaleString(),
    },
    {
      key: 'actions',
      header: '',
      render: (a: AttachmentMeta) => (
        <button className="btn btn--danger" onClick={() => handleDelete(a.id)}>
          Delete
        </button>
      ),
    },
  ]

  return (
    <div>
      <h1>Attachments</h1>

      <div className="status-cards">
        <StatusCard
          label="Total Storage"
          value={stats ? formatBytes(stats.totalSize) : '-'}
        />
        <StatusCard
          label="Total Attachments"
          value={totalCount}
        />
        <StatusCard
          label="Groups with Attachments"
          value={stats?.countByGroup.length ?? 0}
        />
      </div>

      {stats && stats.countByGroup.length > 0 && (
        <div style={{ marginBottom: '1.5rem' }}>
          <h2 style={{ marginBottom: '0.75rem' }}>Storage by Group</h2>
          <table className="data-table">
            <thead>
              <tr>
                <th>Group</th>
                <th>Count</th>
                <th>Size</th>
              </tr>
            </thead>
            <tbody>
              {stats.countByGroup.map(g => (
                <tr key={g.groupId}>
                  <td>{g.groupId.slice(0, 8)}...</td>
                  <td>{g.count}</td>
                  <td>{formatBytes(g.size)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h2 style={{ marginBottom: '0.75rem' }}>All Attachments</h2>
      <DataTable<AttachmentMeta>
        columns={columns}
        data={attachments ?? []}
        loading={loading}
        emptyMessage="No attachments"
      />
    </div>
  )
}
