import { useNavigate } from 'react-router-dom'
import { useApi } from '../hooks/useApi'
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
  const { data: groups, loading } = useApi<Group[]>('/api/groups')
  const navigate = useNavigate()

  return (
    <div>
      <h1>Groups</h1>
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
