import { useState } from 'react'
import { useApi, apiCall } from '../hooks/useApi'
import DataTable from '../components/DataTable'

interface Dossier {
  groupId: string
  personId: string
  displayName: string
  notes: string
  createdAt: number
  updatedAt: number
}

export default function Dossiers() {
  const [groupFilter, setGroupFilter] = useState('')
  const [editing, setEditing] = useState<Dossier | null>(null)
  const [editNotes, setEditNotes] = useState('')
  const [editDisplayName, setEditDisplayName] = useState('')

  const { data: dossiers, loading, refetch } =
    useApi<Dossier[]>(`/api/dossiers${groupFilter ? `?groupId=${groupFilter}` : ''}`, [groupFilter])

  const startEdit = (d: Dossier) => {
    setEditing(d)
    setEditDisplayName(d.displayName)
    setEditNotes(d.notes)
  }

  const saveEdit = async () => {
    if (!editing) return
    await apiCall('PUT', `/api/dossiers/${encodeURIComponent(editing.groupId)}/${encodeURIComponent(editing.personId)}`, {
      displayName: editDisplayName,
      notes: editNotes,
    })
    setEditing(null)
    refetch()
  }

  const deleteDossier = async (d: Dossier) => {
    await apiCall('DELETE', `/api/dossiers/${encodeURIComponent(d.groupId)}/${encodeURIComponent(d.personId)}`)
    refetch()
  }

  const columns = [
    { key: 'groupId', header: 'Group', render: (d: Dossier) => d.groupId.slice(0, 8) + '...' },
    { key: 'personId', header: 'Person' },
    { key: 'displayName', header: 'Display Name' },
    { key: 'notes', header: 'Notes', render: (d: Dossier) => (
      <span title={d.notes}>{d.notes.length > 60 ? d.notes.slice(0, 60) + '...' : d.notes}</span>
    )},
    { key: 'actions', header: '', render: (d: Dossier) => (
      <div style={{ display: 'flex', gap: '0.5rem' }}>
        <button onClick={() => startEdit(d)} className="btn-small">Edit</button>
        <button onClick={() => deleteDossier(d)} className="btn-danger">Delete</button>
      </div>
    )},
  ]

  return (
    <div>
      <h1>Dossiers</h1>

      <div style={{ marginBottom: '1rem' }}>
        <input
          type="text"
          placeholder="Filter by group ID..."
          value={groupFilter}
          onChange={e => setGroupFilter(e.target.value)}
          style={{ padding: '0.5rem', width: '300px' }}
        />
      </div>

      {editing && (
        <div style={{ border: '1px solid #444', padding: '1rem', marginBottom: '1rem', borderRadius: '4px' }}>
          <h3>Editing: {editing.personId}</h3>
          <div style={{ marginBottom: '0.5rem' }}>
            <label>Display Name: </label>
            <input
              type="text"
              value={editDisplayName}
              onChange={e => setEditDisplayName(e.target.value)}
              style={{ padding: '0.25rem', width: '200px' }}
            />
          </div>
          <div style={{ marginBottom: '0.5rem' }}>
            <label>Notes: </label>
            <textarea
              value={editNotes}
              onChange={e => setEditNotes(e.target.value)}
              rows={4}
              style={{ width: '100%', padding: '0.25rem' }}
            />
          </div>
          <button onClick={saveEdit} className="btn-small">Save</button>
          <button onClick={() => setEditing(null)} style={{ marginLeft: '0.5rem' }} className="btn-small">Cancel</button>
        </div>
      )}

      <DataTable<Dossier>
        columns={columns}
        data={dossiers ?? []}
        loading={loading}
        emptyMessage="No dossiers found"
      />
    </div>
  )
}
