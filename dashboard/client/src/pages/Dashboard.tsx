import { useCallback } from 'react'
import { Link } from 'react-router-dom'
import { useApi } from '../hooks/useApi'
import { useWebSocket } from '../hooks/useWebSocket'
import StatusCard from '../components/StatusCard'
import DataTable from '../components/DataTable'

interface Health {
  uptime: number
  memory: { rss: number; heapUsed: number; heapTotal: number }
  dbSize: number
  signalCliReachable: boolean
}

interface Stats {
  messages: number
  reminders: number
  attachments: number
  groups: number
}

interface Group {
  id: string
  name: string
  members: number
  messageCount: number
  lastActivity: string | null
  enabled: boolean
}

interface RecurringReminder {
  id: number
  groupId: string
  prompt: string
  cronExpression: string
  nextDueAt: number
  consecutiveFailures: number
}

function formatUptime(ms: number): string {
  const seconds = Math.floor(ms / 1000)
  const days = Math.floor(seconds / 86400)
  const hours = Math.floor((seconds % 86400) / 3600)
  const mins = Math.floor((seconds % 3600) / 60)
  if (days > 0) return `${days}d ${hours}h`
  if (hours > 0) return `${hours}h ${mins}m`
  return `${mins}m`
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function formatRelativeTime(dateStr: string | null): string {
  if (!dateStr) return 'Never'
  const diff = Date.now() - new Date(dateStr).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'Just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

function formatDueTime(timestamp: number): string {
  const diff = timestamp - Date.now()
  if (diff < 0) return 'Overdue'
  const mins = Math.floor(diff / 60000)
  if (mins < 60) return `in ${mins}m`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `in ${hours}h`
  const days = Math.floor(hours / 24)
  return `in ${days}d`
}

const groupColumns = [
  {
    key: 'enabled',
    header: 'Status',
    render: (row: Group) => (
      <span style={{ color: row.enabled ? '#8f8' : '#e74' }}>
        {row.enabled ? 'Active' : 'Disabled'}
      </span>
    ),
  },
  { key: 'name', header: 'Name' },
  {
    key: 'lastActivity',
    header: 'Last Activity',
    render: (row: Group) => formatRelativeTime(row.lastActivity),
  },
  { key: 'messageCount', header: 'Messages' },
  {
    key: 'manage',
    header: '',
    render: (row: Group) => <Link to={`/groups/${row.id}`}>Manage</Link>,
  },
]

const recurringColumns = [
  { key: 'prompt', header: 'Prompt', render: (row: RecurringReminder) => (
    <span title={row.prompt}>{row.prompt.length > 60 ? row.prompt.slice(0, 60) + '...' : row.prompt}</span>
  )},
  { key: 'cronExpression', header: 'Schedule' },
  {
    key: 'nextDueAt',
    header: 'Next Due',
    render: (row: RecurringReminder) => formatDueTime(row.nextDueAt),
  },
  {
    key: 'consecutiveFailures',
    header: 'Failures',
    render: (row: RecurringReminder) => (
      <span style={{ color: row.consecutiveFailures > 0 ? '#e74' : '#aaa' }}>
        {row.consecutiveFailures}
      </span>
    ),
  },
]

export default function Dashboard() {
  const { data: health, error: healthError } = useApi<Health>('/api/health')
  const { data: stats } = useApi<Stats>('/api/stats')
  const { data: groups } = useApi<Group[]>('/api/groups')
  const { data: recurring } = useApi<RecurringReminder[]>('/api/recurring-reminders')

  const onWsEvent = useCallback(() => {
    // WebSocket events could trigger refetches in the future
  }, [])
  const { connected } = useWebSocket(onWsEvent)

  const botStatus = healthError
    ? 'Error'
    : health
      ? health.signalCliReachable ? 'Online' : 'Degraded'
      : 'Loading...'

  const botVariant = healthError
    ? 'error' as const
    : health
      ? health.signalCliReachable ? 'success' as const : 'warning' as const
      : 'default' as const

  return (
    <div>
      <h1>Dashboard</h1>

      <div className="status-cards">
        <StatusCard
          label="Bot Status"
          value={botStatus}
          detail={health ? `Uptime: ${formatUptime(health.uptime)} | DB: ${formatBytes(health.dbSize)}` : undefined}
          variant={botVariant}
        />
        <StatusCard
          label="Active Groups"
          value={stats?.groups ?? '-'}
          variant="default"
        />
        <StatusCard
          label="Pending Reminders"
          value={stats?.reminders ?? '-'}
          variant="default"
        />
        <StatusCard
          label="Attachments"
          value={stats?.attachments ?? '-'}
          variant="default"
        />
      </div>

      {!connected && (
        <div style={{ color: '#e74', fontSize: '0.85rem', marginBottom: '1rem' }}>
          WebSocket disconnected -- reconnecting...
        </div>
      )}

      <h2 style={{ marginBottom: '1rem' }}>Groups</h2>
      <DataTable<Group>
        columns={groupColumns}
        data={groups ?? []}
        loading={!groups}
        emptyMessage="No groups found"
      />

      <h2 style={{ margin: '1.5rem 0 1rem' }}>Recurring Reminders</h2>
      <DataTable<RecurringReminder>
        columns={recurringColumns}
        data={recurring ?? []}
        loading={!recurring}
        emptyMessage="No recurring reminders"
      />
    </div>
  )
}
