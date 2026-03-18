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
    useApi<Memory[]>(`/api/memories${groupFilter ? `?groupId=${groupFilter}` : ''}`, [groupFilter])

  const startEdit = (m: Memory) => {
    setEditing(m)
    setEditContent(m.content)
  }

  const saveEdit = async () => {
    if (!editing) return
    await apiCall('PUT', `/api/memories/${encodeURIComponent(editing.groupId)}/${encodeURIComponent(editing.topic)}`, {
      content: editContent,
    })
    setEditing(null)
    refetch()
  }

  const deleteMemory = async (m: Memory) => {
    await apiCall('DELETE', `/api/memories/${encodeURIComponent(m.groupId)}/${encodeURIComponent(m.topic)}`)
    refetch()
  }

  const columns = [
    { key: 'groupId', header: 'Group', render: (m: Memory) => m.groupId.slice(0, 8) + '...' },
    { key: 'topic', header: 'Topic' },
    { key: 'content', header: 'Content', render: (m: Memory) => (
      <span title={m.content}>{m.content.length > 60 ? m.content.slice(0, 60) + '...' : m.content}</span>
    )},
    { key: 'actions', header: '', render: (m: Memory) => (
      <div style={{ display: 'flex', gap: '0.5rem' }}>
        <button onClick={() => startEdit(m)} className="btn-small">Edit</button>
        <button onClick={() => deleteMemory(m)} className="btn-danger">Delete</button>
      </div>
    )},
  ]

  return (
    <div>
      <h1>Memories</h1>

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
          <h3>Editing: {editing.topic}</h3>
          <div style={{ marginBottom: '0.5rem' }}>
            <textarea
              value={editContent}
              onChange={e => setEditContent(e.target.value)}
              rows={4}
              style={{ width: '100%', padding: '0.25rem' }}
            />
          </div>
          <button onClick={saveEdit} className="btn-small">Save</button>
          <button onClick={() => setEditing(null)} style={{ marginLeft: '0.5rem' }} className="btn-small">Cancel</button>
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
