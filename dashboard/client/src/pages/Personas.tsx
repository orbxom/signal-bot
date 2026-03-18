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
        <button onClick={() => startEdit(p)} className="btn-small">Edit</button>
        {!p.isDefault && (
          <button onClick={() => deletePersona(p.id)} className="btn-danger">Delete</button>
        )}
      </div>
    )},
  ]

  return (
    <div>
      <h1>Personas</h1>

      <div style={{ border: '1px solid #444', padding: '1rem', marginBottom: '1rem', borderRadius: '4px' }}>
        <h3>Create Persona</h3>
        <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <div>
            <label>Name: </label>
            <input type="text" value={newName} onChange={e => setNewName(e.target.value)} style={{ padding: '0.25rem' }} />
          </div>
          <div>
            <label>Description: </label>
            <input type="text" value={newDescription} onChange={e => setNewDescription(e.target.value)} style={{ padding: '0.25rem', width: '300px' }} />
          </div>
          <div>
            <label>Tags: </label>
            <input type="text" value={newTags} onChange={e => setNewTags(e.target.value)} style={{ padding: '0.25rem' }} />
          </div>
          <button onClick={createPersona} className="btn-small">Create</button>
        </div>
      </div>

      {editing && (
        <div style={{ border: '1px solid #444', padding: '1rem', marginBottom: '1rem', borderRadius: '4px' }}>
          <h3>Editing: {editing.name}</h3>
          <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'flex-end', flexWrap: 'wrap' }}>
            <div>
              <label>Name: </label>
              <input type="text" value={editName} onChange={e => setEditName(e.target.value)} style={{ padding: '0.25rem' }} />
            </div>
            <div>
              <label>Description: </label>
              <input type="text" value={editDescription} onChange={e => setEditDescription(e.target.value)} style={{ padding: '0.25rem', width: '300px' }} />
            </div>
            <div>
              <label>Tags: </label>
              <input type="text" value={editTags} onChange={e => setEditTags(e.target.value)} style={{ padding: '0.25rem' }} />
            </div>
            <button onClick={saveEdit} className="btn-small">Save</button>
            <button onClick={() => setEditing(null)} className="btn-small">Cancel</button>
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
