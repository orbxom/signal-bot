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
        <button onClick={() => startEdit(d)} className="btn">Edit</button>
        <button onClick={() => deleteDossier(d)} className="btn btn--danger">Delete</button>
      </div>
    )},
  ]

  return (
    <div>
      <h1>Dossiers</h1>

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

      {editing && (
        <div className="edit-panel">
          <h3>Editing: {editing.personId}</h3>
          <div className="form-group">
            <label>Display Name</label>
            <input
              type="text"
              className="form-input"
              value={editDisplayName}
              onChange={e => setEditDisplayName(e.target.value)}
            />
          </div>
          <div className="form-group">
            <label>Notes</label>
            <textarea
              className="form-input"
              value={editNotes}
              onChange={e => setEditNotes(e.target.value)}
              rows={4}
            />
          </div>
          <div style={{ display: 'flex', gap: '0.5rem' }}>
            <button onClick={saveEdit} className="btn">Save</button>
            <button onClick={() => setEditing(null)} className="btn">Cancel</button>
          </div>
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
