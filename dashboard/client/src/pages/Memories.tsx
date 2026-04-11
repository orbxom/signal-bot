import { useState } from 'react'
import { useApi, apiCall } from '../hooks/useApi'
import DataTable from '../components/DataTable'

interface Memory {
  groupId: string
  topic: string
  content: string
  createdAt: number
  updatedAt: number
}

export default function Memories() {
  const [groupFilter, setGroupFilter] = useState('')
  const [editing, setEditing] = useState<Memory | null>(null)
  const [editContent, setEditContent] = useState('')

  const { data: memories, loading, refetch } =
    useApi<Memory[]>(`/api/memories${groupFilter ? `?groupId=${encodeURIComponent(groupFilter)}` : ''}`, [groupFilter])

  const startEdit = (m: Memory) => {
    setEditing(m)
    setEditContent(m.content)
  }

  const saveEdit = async () => {
    if (!editing) return
    try {
      await apiCall('PUT', `/api/memories/${encodeURIComponent(editing.groupId)}/${encodeURIComponent(editing.topic)}`, {
        content: editContent,
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
      await apiCall('DELETE', `/api/memories/${encodeURIComponent(m.groupId)}/${encodeURIComponent(m.topic)}`)
      refetch()
    } catch (err) {
      alert(`Failed to delete memory: ${(err as Error).message}`)
    }
  }

  const columns = [
    { key: 'groupId', header: 'Group', render: (m: Memory) => m.groupId.slice(0, 8) + '...' },
    { key: 'topic', header: 'Topic' },
    { key: 'content', header: 'Content', render: (m: Memory) => (
      <span title={m.content}>{m.content.length > 60 ? m.content.slice(0, 60) + '...' : m.content}</span>
    )},
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
          <h3>Editing: {editing.topic}</h3>
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
