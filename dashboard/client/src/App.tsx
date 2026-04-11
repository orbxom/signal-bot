import { Routes, Route } from 'react-router-dom'
import Sidebar from './components/Sidebar'
import ErrorBoundary from './components/ErrorBoundary'
import Dashboard from './pages/Dashboard'
import Groups from './pages/Groups'
import GroupDetail from './pages/GroupDetail'
import Reminders from './pages/Reminders'
import Dossiers from './pages/Dossiers'
import Personas from './pages/Personas'
import Memories from './pages/Memories'
import Messages from './pages/Messages'
import Attachments from './pages/Attachments'
import Factory from './pages/Factory'

export default function App() {
  return (
    <div className="app">
      <Sidebar />
      <main className="main-content">
        <ErrorBoundary>
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/groups" element={<Groups />} />
            <Route path="/groups/:id" element={<GroupDetail />} />
            <Route path="/reminders" element={<Reminders />} />
            <Route path="/dossiers" element={<Dossiers />} />
            <Route path="/personas" element={<Personas />} />
            <Route path="/memories" element={<Memories />} />
            <Route path="/messages" element={<Messages />} />
            <Route path="/attachments" element={<Attachments />} />
            <Route path="/factory" element={<Factory />} />
          </Routes>
        </ErrorBoundary>
      </main>
    </div>
  )
}
