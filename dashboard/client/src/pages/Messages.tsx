import { useState } from 'react'
import { useApi } from '../hooks/useApi'
import DataTable from '../components/DataTable'

interface Group {
  id: string
  name: string
}

interface Message {
  id: number
  sender: string
  content: string
  timestamp: number
  isBot: boolean
}

const columns = [
  {
    key: 'sender',
    header: 'Sender',
    render: (m: Message) => (
      <span>
        {m.isBot ? 'Bot' : m.sender.slice(-4)}
        {m.isBot && <span className="badge">bot</span>}
      </span>
    ),
  },
  {
    key: 'content',
    header: 'Message',
    render: (m: Message) => (
      <span title={m.content}>
        {m.content.length > 100 ? m.content.slice(0, 100) + '...' : m.content}
      </span>
    ),
  },
  {
    key: 'timestamp',
    header: 'Time',
    render: (m: Message) => new Date(m.timestamp).toLocaleString(),
  },
]

export default function Messages() {
  const [groupId, setGroupId] = useState('')
  const [search, setSearch] = useState('')
  const [searchQuery, setSearchQuery] = useState('')
  const { data: groups } = useApi<Group[]>('/api/groups')

  const url = groupId
    ? `/api/messages?groupId=${encodeURIComponent(groupId)}${searchQuery ? `&search=${encodeURIComponent(searchQuery)}` : ''}&limit=100`
    : null

  const { data: messages, loading } = useApi<Message[]>(url, [groupId, searchQuery])

  function handleSearch(e: React.FormEvent) {
    e.preventDefault()
    setSearchQuery(search)
  }

  return (
    <div>
      <h1>Messages</h1>

      <div className="filter-bar">
        <select
          className="form-input"
          value={groupId}
          onChange={e => setGroupId(e.target.value)}
          style={{ width: 'auto', minWidth: '200px' }}
        >
          <option value="">Select a group...</option>
          {groups?.map(g => (
            <option key={g.id} value={g.id}>{g.name || g.id}</option>
          ))}
        </select>

        <form onSubmit={handleSearch} style={{ display: 'flex', gap: '0.5rem', flex: 1 }}>
          <input
            type="text"
            className="form-input"
            placeholder="Search messages..."
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
          <button type="submit" className="btn" disabled={!groupId}>
            Search
          </button>
        </form>
      </div>

      {!groupId ? (
        <div className="empty">Select a group to view messages</div>
      ) : (
        <DataTable<Message>
          columns={columns}
          data={messages ?? []}
          loading={loading}
          emptyMessage="No messages found"
        />
      )}
    </div>
  )
}
