import { useState } from 'react'
import { useApi, apiCall } from '../hooks/useApi'
import DataTable from '../components/DataTable'

interface Persona {
  id: number
  name: string
  description: string
  tags: string
  isDefault: boolean
}

export default function Personas() {
  const { data: personas, loading, refetch } = useApi<Persona[]>('/api/personas')
  const [newName, setNewName] = useState('')
  const [newDescription, setNewDescription] = useState('')
  const [newTags, setNewTags] = useState('')
  const [editing, setEditing] = useState<Persona | null>(null)
  const [editName, setEditName] = useState('')
  const [editDescription, setEditDescription] = useState('')
  const [editTags, setEditTags] = useState('')

  const createPersona = async () => {
    if (!newName.trim()) return
    await apiCall('POST', '/api/personas', {
      name: newName, description: newDescription, tags: newTags,
    })
    setNewName('')
    setNewDescription('')
    setNewTags('')
    refetch()
  }

  const startEdit = (p: Persona) => {
    setEditing(p)
    setEditName(p.name)
    setEditDescription(p.description)
    setEditTags(p.tags)
  }

  const saveEdit = async () => {
    if (!editing) return
    await apiCall('PUT', `/api/personas/${editing.id}`, {
      name: editName, description: editDescription, tags: editTags,
    })
    setEditing(null)
    refetch()
  }

  const deletePersona = async (id: number) => {
    await apiCall('DELETE', `/api/personas/${id}`)
    refetch()
  }

  const columns = [
    { key: 'name', header: 'Name' },
    { key: 'description', header: 'Description', render: (p: Persona) => (
      <span title={p.description}>{p.description.length > 60 ? p.description.slice(0, 60) + '...' : p.description}</span>
    )},
    { key: 'tags', header: 'Tags' },
    { key: 'isDefault', header: 'Default', render: (p: Persona) => p.isDefault ? 'Yes' : '' },
    { key: 'actions', header: '', render: (p: Persona) => (
      <div style={{ display: 'flex', gap: '0.5rem' }}>
        <button onClick={() => startEdit(p)} className="btn">Edit</button>
        {!p.isDefault && (
          <button onClick={() => deletePersona(p.id)} className="btn btn--danger">Delete</button>
        )}
      </div>
    )},
  ]

  return (
    <div>
      <h1>Personas</h1>

      <div className="edit-panel">
        <h3>Create Persona</h3>
        <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <div className="form-group" style={{ marginBottom: 0 }}>
            <label>Name</label>
            <input type="text" className="form-input" value={newName} onChange={e => setNewName(e.target.value)} />
          </div>
          <div className="form-group" style={{ marginBottom: 0, flex: 1 }}>
            <label>Description</label>
            <input type="text" className="form-input" value={newDescription} onChange={e => setNewDescription(e.target.value)} />
          </div>
          <div className="form-group" style={{ marginBottom: 0 }}>
            <label>Tags</label>
            <input type="text" className="form-input" value={newTags} onChange={e => setNewTags(e.target.value)} />
          </div>
          <button onClick={createPersona} className="btn">Create</button>
        </div>
      </div>

      {editing && (
        <div className="edit-panel">
          <h3>Editing: {editing.name}</h3>
          <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'flex-end', flexWrap: 'wrap' }}>
            <div className="form-group" style={{ marginBottom: 0 }}>
              <label>Name</label>
              <input type="text" className="form-input" value={editName} onChange={e => setEditName(e.target.value)} />
            </div>
            <div className="form-group" style={{ marginBottom: 0, flex: 1 }}>
              <label>Description</label>
              <input type="text" className="form-input" value={editDescription} onChange={e => setEditDescription(e.target.value)} />
            </div>
            <div className="form-group" style={{ marginBottom: 0 }}>
              <label>Tags</label>
              <input type="text" className="form-input" value={editTags} onChange={e => setEditTags(e.target.value)} />
            </div>
            <button onClick={saveEdit} className="btn">Save</button>
            <button onClick={() => setEditing(null)} className="btn">Cancel</button>
          </div>
        </div>
      )}

      <DataTable<Persona>
        columns={columns}
        data={personas ?? []}
        loading={loading}
        emptyMessage="No personas found"
      />
    </div>
  )
}
