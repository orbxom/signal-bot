import { NavLink } from 'react-router-dom'

const navItems = [
  { path: '/', label: 'Dashboard' },
  { path: '/groups', label: 'Groups' },
  { path: '/reminders', label: 'Reminders' },
  { path: '/dossiers', label: 'Dossiers' },
  { path: '/personas', label: 'Personas' },
  { path: '/memories', label: 'Memories' },
  { path: '/messages', label: 'Messages' },
  { path: '/attachments', label: 'Attachments' },
  { path: '/factory', label: 'Factory', separator: true },
]

export default function Sidebar() {
  return (
    <nav className="sidebar">
      <div className="sidebar-header">Signal Bot</div>
      {navItems.map(item => (
        <div key={item.path}>
          {item.separator && <div className="sidebar-separator" />}
          <NavLink
            to={item.path}
            className={({ isActive }) => `sidebar-link ${isActive ? 'active' : ''}`}
            end={item.path === '/'}
          >
            {item.label}
          </NavLink>
        </div>
      ))}
    </nav>
  )
}
