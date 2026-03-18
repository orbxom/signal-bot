import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useApi, apiCall } from '../hooks/useApi'
import DataTable from '../components/DataTable'

interface Group {
  id: string
  name: string
  members: string[]
  enabled: boolean
  activePersona: string
}

const columns = [
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
    key: 'members',
    header: 'Members',
    render: (row: Group) => row.members?.length ?? 0,
  },
  { key: 'activePersona', header: 'Persona' },
]

export default function Groups() {
  const { data: groups, loading, setData: setGroups, refetch } = useApi<Group[]>('/api/groups')
  const navigate = useNavigate()
  const [uri, setUri] = useState('')
  const [joining, setJoining] = useState(false)
  const [joinError, setJoinError] = useState<string | null>(null)
  const [joinSuccess, setJoinSuccess] = useState<string | null>(null)

  async function handleJoin(e: React.FormEvent) {
    e.preventDefault()
    if (!uri.trim() || joining) return
    setJoining(true)
    setJoinError(null)
    setJoinSuccess(null)
    try {
      const result = await apiCall('POST', '/api/groups/join', { uri: uri.trim() }) as
        | { groups: Group[] }
        | { message: string }
      if ('groups' in result) {
        setGroups(result.groups)
      } else {
        // 202 admin approval — show message
        setJoinSuccess(result.message)
      }
      setUri('')
    } catch (err) {
      setJoinError((err as Error).message)
    } finally {
      setJoining(false)
    }
  }

  return (
    <div>
      <h1>Groups</h1>
      <form onSubmit={handleJoin} style={{ display: 'flex', gap: '8px', marginBottom: '16px' }}>
        <input
          type="text"
          value={uri}
          onChange={(e) => setUri(e.target.value)}
          placeholder="Paste Signal group invite link..."
          disabled={joining}
          style={{ flex: 1, padding: '8px' }}
        />
        <button type="submit" disabled={joining || !uri.trim()}>
          {joining ? 'Joining...' : 'Join'}
        </button>
      </form>
      {joinError && (
        <div style={{ color: '#e74c3c', marginBottom: '12px' }}>{joinError}</div>
      )}
      {joinSuccess && (
        <div style={{ color: '#f39c12', marginBottom: '12px' }}>{joinSuccess}</div>
      )}
      <DataTable<Group>
        columns={columns}
        data={groups ?? []}
        loading={loading}
        onRowClick={(row) => navigate(`/groups/${row.id}`)}
        emptyMessage="No groups found"
      />
    </div>
  )
}
