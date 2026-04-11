import { useState } from 'react'
import { useParams } from 'react-router-dom'
import { useApi, apiCall } from '../hooks/useApi'
import StatusCard from '../components/StatusCard'
import DataTable from '../components/DataTable'

interface GroupSettings {
  enabled: boolean
  customTriggers: string | null
  contextWindowSize: number | null
  toolNotifications: boolean
}

interface GroupDetailData {
  id: string
  name: string
  members: string[]
  settings: GroupSettings | null
  activePersona: { name: string; description: string } | null
}

interface Reminder {
  id: number
  groupId: string
  requester: string
  text: string
  dueAt: number
  status: string
}

interface Dossier {
  groupId: string
  personId: string
  displayName: string
  notes: string
}

interface Message {
  id: number
  sender: string
  content: string
  timestamp: number
  isBot: boolean
}

const tabs = ['Overview', 'Reminders', 'Dossiers', 'Messages', 'Settings'] as const
type Tab = typeof tabs[number]

const reminderColumns = [
  { key: 'requester', header: 'Requester' },
  { key: 'text', header: 'Text', render: (r: Reminder) => (
    <span title={r.text}>{r.text.length > 50 ? r.text.slice(0, 50) + '...' : r.text}</span>
  )},
  { key: 'dueAt', header: 'Due', render: (r: Reminder) => new Date(r.dueAt).toLocaleString() },
  { key: 'status', header: 'Status' },
]

const dossierColumns = [
  { key: 'displayName', header: 'Name' },
  { key: 'personId', header: 'Person ID' },
  { key: 'notes', header: 'Notes', render: (d: Dossier) => (
    <span title={d.notes}>{d.notes.length > 60 ? d.notes.slice(0, 60) + '...' : d.notes}</span>
  )},
]

const messageColumns = [
  { key: 'sender', header: 'Sender', render: (m: Message) => m.isBot ? 'Bot' : m.sender.slice(-4) },
  { key: 'content', header: 'Message', render: (m: Message) => (
    <span title={m.content}>{m.content.length > 80 ? m.content.slice(0, 80) + '...' : m.content}</span>
  )},
  { key: 'timestamp', header: 'Time', render: (m: Message) => new Date(m.timestamp).toLocaleString() },
]

export default function GroupDetail() {
  const { id } = useParams<{ id: string }>()
  const [activeTab, setActiveTab] = useState<Tab>('Overview')
  const encodedId = encodeURIComponent(id!)
  const { data: group, loading, error, refetch } = useApi<GroupDetailData>(`/api/groups/${encodedId}`)
  const { data: reminders } = useApi<Reminder[]>(`/api/reminders?groupId=${encodedId}`)
  const { data: dossiers } = useApi<Dossier[]>(`/api/dossiers?groupId=${encodedId}`)
  const { data: messages } = useApi<Message[]>(`/api/messages?groupId=${encodedId}`)

  const [settingsForm, setSettingsForm] = useState<Partial<GroupSettings>>({})
  const [saving, setSaving] = useState(false)
  const [leaveConfirm, setLeaveConfirm] = useState(false)

  if (loading) return <div className="loading">Loading...</div>
  if (error || !group) return <div className="error">{error || 'Group not found'}</div>

  const settings = group.settings ?? { enabled: true, customTriggers: null, contextWindowSize: null, toolNotifications: true }

  async function handleSaveSettings() {
    setSaving(true)
    try {
      await apiCall('PATCH', `/api/groups/${encodedId}/settings`, {
        ...settings,
        ...settingsForm,
      })
      refetch()
    } catch (err) {
      alert(`Failed to save settings: ${(err as Error).message}`)
    } finally {
      setSaving(false)
    }
  }

  async function handleLeave() {
    try {
      await apiCall('POST', `/api/groups/${encodedId}/leave`)
      refetch()
      setLeaveConfirm(false)
    } catch (err) {
      alert(`Failed to leave group: ${(err as Error).message}`)
    }
  }

  async function handleToggleEnabled() {
    try {
      await apiCall('PATCH', `/api/groups/${encodedId}/settings`, {
        enabled: !settings.enabled,
      })
      refetch()
    } catch (err) {
      alert(`Failed to update group: ${(err as Error).message}`)
    }
  }

  return (
    <div>
      <h1>{group.name || id}</h1>

      <div className="tab-bar">
        {tabs.map(tab => (
          <button
            key={tab}
            className={`tab-button ${activeTab === tab ? 'active' : ''}`}
            onClick={() => setActiveTab(tab)}
          >
            {tab}
          </button>
        ))}
      </div>

      {activeTab === 'Overview' && (
        <div>
          <div className="status-cards">
            <StatusCard
              label="Status"
              value={settings.enabled ? 'Enabled' : 'Disabled'}
              variant={settings.enabled ? 'success' : 'error'}
            />
            <StatusCard
              label="Members"
              value={group.members?.length ?? 0}
            />
            <StatusCard
              label="Active Persona"
              value={group.activePersona?.name ?? 'Default'}
            />
            <StatusCard
              label="Tool Notifications"
              value={settings.toolNotifications ? 'On' : 'Off'}
            />
          </div>

          <div className="action-buttons">
            <button className="btn" onClick={handleToggleEnabled}>
              {settings.enabled ? 'Disable Group' : 'Enable Group'}
            </button>
            {!leaveConfirm ? (
              <button className="btn btn--danger" onClick={() => setLeaveConfirm(true)}>
                Leave Group
              </button>
            ) : (
              <span>
                Are you sure?{' '}
                <button className="btn btn--danger" onClick={handleLeave}>Yes, leave</button>{' '}
                <button className="btn" onClick={() => setLeaveConfirm(false)}>Cancel</button>
              </span>
            )}
          </div>
        </div>
      )}

      {activeTab === 'Reminders' && (
        <DataTable<Reminder>
          columns={reminderColumns}
          data={reminders ?? []}
          loading={!reminders}
          emptyMessage="No reminders for this group"
        />
      )}

      {activeTab === 'Dossiers' && (
        <DataTable<Dossier>
          columns={dossierColumns}
          data={dossiers ?? []}
          loading={!dossiers}
          emptyMessage="No dossiers for this group"
        />
      )}

      {activeTab === 'Messages' && (
        <DataTable<Message>
          columns={messageColumns}
          data={messages ?? []}
          loading={!messages}
          emptyMessage="No messages for this group"
        />
      )}

      {activeTab === 'Settings' && (
        <div className="settings-form">
          <div className="form-group">
            <label>
              <input
                type="checkbox"
                checked={settingsForm.enabled ?? settings.enabled}
                onChange={e => setSettingsForm(s => ({ ...s, enabled: e.target.checked }))}
              />
              {' '}Enabled
            </label>
          </div>
          <div className="form-group">
            <label>Custom Triggers</label>
            <input
              type="text"
              className="form-input"
              placeholder="e.g. @bot,bot:,claude:"
              value={settingsForm.customTriggers ?? settings.customTriggers ?? ''}
              onChange={e => setSettingsForm(s => ({ ...s, customTriggers: e.target.value || null }))}
            />
          </div>
          <div className="form-group">
            <label>Context Window Size</label>
            <input
              type="number"
              className="form-input"
              placeholder="Default"
              value={settingsForm.contextWindowSize ?? settings.contextWindowSize ?? ''}
              onChange={e => setSettingsForm(s => ({ ...s, contextWindowSize: e.target.value ? Number(e.target.value) : null }))}
            />
          </div>
          <div className="form-group">
            <label>
              <input
                type="checkbox"
                checked={settingsForm.toolNotifications ?? settings.toolNotifications}
                onChange={e => setSettingsForm(s => ({ ...s, toolNotifications: e.target.checked }))}
              />
              {' '}Tool Notifications
            </label>
          </div>
          <button className="btn" onClick={handleSaveSettings} disabled={saving}>
            {saving ? 'Saving...' : 'Save Settings'}
          </button>
        </div>
      )}
    </div>
  )
}
