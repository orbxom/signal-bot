import { useState } from 'react'
import { useApi, apiCall } from '../hooks/useApi'
import DataTable from '../components/DataTable'

interface Reminder {
  id: number
  groupId: string
  requester: string
  reminderText: string
  dueAt: number
  status: string
  retryCount: number
  mode: string
}

interface RecurringReminder {
  id: number
  groupId: string
  prompt: string
  cronExpression: string
  nextDueAt: number
  consecutiveFailures: number
  status: string
}

function formatTimestamp(ts: number): string {
  return new Date(ts).toLocaleString()
}

export default function Reminders() {
  const [groupFilter, setGroupFilter] = useState('')
  const { data: reminders, loading: loadingReminders, refetch: refetchReminders } =
    useApi<Reminder[]>(`/api/reminders${groupFilter ? `?groupId=${groupFilter}` : ''}`, [groupFilter])
  const { data: recurring, loading: loadingRecurring, refetch: refetchRecurring } =
    useApi<RecurringReminder[]>(`/api/recurring-reminders${groupFilter ? `?groupId=${groupFilter}` : ''}`, [groupFilter])

  const cancelReminder = async (id: number, groupId: string) => {
    await apiCall('DELETE', `/api/reminders/${id}?groupId=${encodeURIComponent(groupId)}`)
    refetchReminders()
  }

  const cancelRecurring = async (id: number, groupId: string) => {
    await apiCall('DELETE', `/api/recurring-reminders/${id}?groupId=${encodeURIComponent(groupId)}`)
    refetchRecurring()
  }

  const resetFailures = async (id: number) => {
    await apiCall('POST', `/api/recurring-reminders/${id}/reset-failures`)
    refetchRecurring()
  }

  const reminderColumns = [
    { key: 'groupId', header: 'Group', render: (r: Reminder) => r.groupId.slice(0, 8) + '...' },
    { key: 'requester', header: 'Requester' },
    { key: 'reminderText', header: 'Text', render: (r: Reminder) => (
      <span title={r.reminderText}>{r.reminderText.length > 50 ? r.reminderText.slice(0, 50) + '...' : r.reminderText}</span>
    )},
    { key: 'dueAt', header: 'Due', render: (r: Reminder) => formatTimestamp(r.dueAt) },
    { key: 'status', header: 'Status', render: (r: Reminder) => (
      <span style={{ color: r.status === 'pending' ? '#8f8' : r.status === 'sent' ? '#aaa' : '#e74' }}>{r.status}</span>
    )},
    { key: 'actions', header: '', render: (r: Reminder) => r.status === 'pending' ? (
      <button onClick={() => cancelReminder(r.id, r.groupId)} className="btn btn--danger">Cancel</button>
    ) : null },
  ]

  const recurringColumns = [
    { key: 'groupId', header: 'Group', render: (r: RecurringReminder) => r.groupId.slice(0, 8) + '...' },
    { key: 'prompt', header: 'Prompt', render: (r: RecurringReminder) => (
      <span title={r.prompt}>{r.prompt.length > 50 ? r.prompt.slice(0, 50) + '...' : r.prompt}</span>
    )},
    { key: 'cronExpression', header: 'Schedule' },
    { key: 'nextDueAt', header: 'Next Due', render: (r: RecurringReminder) => formatTimestamp(r.nextDueAt) },
    { key: 'consecutiveFailures', header: 'Failures', render: (r: RecurringReminder) => (
      <span style={{ color: r.consecutiveFailures > 0 ? '#e74' : '#aaa' }}>
        {r.consecutiveFailures}
        {r.consecutiveFailures > 0 && (
          <button onClick={() => resetFailures(r.id)} className="btn btn--small" style={{ marginLeft: '0.5rem' }}>Reset</button>
        )}
      </span>
    )},
    { key: 'actions', header: '', render: (r: RecurringReminder) => r.status === 'active' ? (
      <button onClick={() => cancelRecurring(r.id, r.groupId)} className="btn btn--danger">Cancel</button>
    ) : null },
  ]

  return (
    <div>
      <h1>Reminders</h1>

      <div className="filter-bar">
        <input
          type="text"
          className="form-input"
          placeholder="Filter by group ID..."
          value={groupFilter}
          onChange={e => setGroupFilter(e.target.value)}
          style={{ width: '300px' }}
        />
      </div>

      <h2 style={{ marginBottom: '0.75rem' }}>One-off Reminders</h2>
      <DataTable<Reminder>
        columns={reminderColumns}
        data={reminders ?? []}
        loading={loadingReminders}
        emptyMessage="No reminders found"
      />

      <h2 style={{ margin: '1.5rem 0 0.75rem' }}>Recurring Reminders</h2>
      <DataTable<RecurringReminder>
        columns={recurringColumns}
        data={recurring ?? []}
        loading={loadingRecurring}
        emptyMessage="No recurring reminders"
      />
    </div>
  )
}
