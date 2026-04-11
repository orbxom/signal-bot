import { useState } from 'react'
import { useApi, apiCall } from '../hooks/useApi'
import DataTable from '../components/DataTable'

interface Memory {
  id: number
  groupId: string
  title: string
  description: string | null
  content: string | null
  type: string
  tags: string[]
  createdAt: number
  updatedAt: number
}

export default function Memories() {
  const [groupFilter, setGroupFilter] = useState('')
  const [editing, setEditing] = useState<Memory | null>(null)
  const [editTitle, setEditTitle] = useState('')
  const [editDescription, setEditDescription] = useState('')
  const [editContent, setEditContent] = useState('')
  const [editType, setEditType] = useState('')

  const { data: memories, loading, refetch } =
    useApi<Memory[]>(`/api/memories${groupFilter ? `?groupId=${encodeURIComponent(groupFilter)}` : ''}`, [groupFilter])

  const startEdit = (m: Memory) => {
    setEditing(m)
    setEditTitle(m.title)
    setEditDescription(m.description ?? '')
    setEditContent(m.content ?? '')
    setEditType(m.type)
  }

  const saveEdit = async () => {
    if (!editing) return
    try {
      await apiCall('PUT', `/api/memories/${editing.id}`, {
        title: editTitle,
        description: editDescription || undefined,
        content: editContent || undefined,
        type: editType,
      })
      setEditing(null)
      refetch()
    } catch (err) {
      alert(`Failed to save memory: ${(err as Error).message}`)
    }
  }

  const deleteMemory = async (m: Memory) => {
    if (!confirm('Delete this memory?')) return
    try {
      await apiCall('DELETE', `/api/memories/${m.id}`)
      refetch()
    } catch (err) {
      alert(`Failed to delete memory: ${(err as Error).message}`)
    }
  }

  const columns = [
    { key: 'groupId', header: 'Group', render: (m: Memory) => m.groupId.slice(0, 8) + '...' },
    { key: 'title', header: 'Title' },
    { key: 'type', header: 'Type' },
    { key: 'tags', header: 'Tags', render: (m: Memory) => m.tags.length > 0 ? m.tags.join(', ') : '' },
    { key: 'content', header: 'Content', render: (m: Memory) => {
      const text = m.content ?? ''
      return <span title={text}>{text.length > 60 ? text.slice(0, 60) + '...' : text}</span>
    }},
    { key: 'actions', header: '', render: (m: Memory) => (
      <div style={{ display: 'flex', gap: '0.5rem' }}>
        <button onClick={() => startEdit(m)} className="btn">Edit</button>
        <button onClick={() => deleteMemory(m)} className="btn btn--danger">Delete</button>
      </div>
    )},
  ]

  return (
    <div>
      <h1>Memories</h1>

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
          <h3>Editing: {editing.title}</h3>
          <div className="form-group">
            <label>Title</label>
            <input
              className="form-input"
              value={editTitle}
              onChange={e => setEditTitle(e.target.value)}
            />
          </div>
          <div className="form-group">
            <label>Type</label>
            <input
              className="form-input"
              value={editType}
              onChange={e => setEditType(e.target.value)}
            />
          </div>
          <div className="form-group">
            <label>Description</label>
            <textarea
              className="form-input"
              value={editDescription}
              onChange={e => setEditDescription(e.target.value)}
              rows={2}
            />
          </div>
          <div className="form-group">
            <label>Content</label>
            <textarea
              className="form-input"
              value={editContent}
              onChange={e => setEditContent(e.target.value)}
              rows={4}
            />
          </div>
          <div style={{ display: 'flex', gap: '0.5rem' }}>
            <button onClick={saveEdit} className="btn">Save</button>
            <button onClick={() => setEditing(null)} className="btn">Cancel</button>
          </div>
        </div>
      )}

      <DataTable<Memory>
        columns={columns}
        data={memories ?? []}
        loading={loading}
        emptyMessage="No memories found"
      />
    </div>
  )
}
