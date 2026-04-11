import { useState, useCallback, useEffect } from 'react'
import { useApi } from '../hooks/useApi'
import { useWebSocket } from '../hooks/useWebSocket'

const STAGE_ORDER = ['plan', 'build', 'test', 'simplify', 'pr', 'integration-test', 'review'] as const
const STAGE_LABELS: Record<string, string> = {
  'plan': 'Plan',
  'build': 'Build',
  'test': 'Test',
  'simplify': 'Simplify',
  'pr': 'PR',
  'integration-test': 'Int-Test',
  'review': 'Review',
}

type StageStatus = 'pending' | 'in-progress' | 'complete' | 'deferred' | 'abandoned'

interface StatusFile {
  runId: string
  currentStage: string
  stages: Partial<Record<typeof STAGE_ORDER[number], StageStatus>>
  updatedAt?: string
}

interface EventFile {
  title: string
  issueNumber?: number
  createdAt?: string
}

interface Run {
  runId: string
  event: EventFile
  status: StatusFile
  diary: string
}

function formatTime(iso: string | undefined): string | null {
  if (!iso) return null
  try {
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) return null
    const diffMs = Date.now() - d.getTime()
    const diffMins = Math.floor(diffMs / 60000)
    const diffHrs = Math.floor(diffMs / 3600000)
    const diffDays = Math.floor(diffMs / 86400000)
    if (diffMins < 1) return 'just now'
    if (diffMins < 60) return `${diffMins}m ago`
    if (diffHrs < 24) return `${diffHrs}h ago`
    if (diffDays < 7) return `${diffDays}d ago`
    return d.toLocaleDateString('en-AU', { day: 'numeric', month: 'short' })
  } catch { return null }
}

function isRunComplete(run: Run): boolean {
  const cs = run.status?.currentStage?.toLowerCase()
  if (cs === 'complete') return true
  const stages = run.status?.stages || {}
  return STAGE_ORDER.every(s => {
    const v = stages[s]
    return v === 'complete' || v === 'deferred'
  }) && Object.keys(stages).length > 0
}

function isRunActive(run: Run): boolean {
  const stages = run.status?.stages || {}
  return STAGE_ORDER.some(s => stages[s] === 'in-progress')
}

function getCurrentStageLabel(run: Run): string {
  const cs = run.status?.currentStage
  if (!cs) return 'Unknown'
  if (cs === 'complete') return 'Complete'
  if (cs === 'unknown') return 'Initializing'
  const stages = run.status?.stages || {}
  for (const s of STAGE_ORDER) {
    if (stages[s] === 'in-progress') return STAGE_LABELS[s] || s
  }
  return STAGE_LABELS[cs] || cs
}

function getStageStatusClass(run: Run): string {
  const cs = run.status?.currentStage
  if (cs === 'complete' || isRunComplete(run)) return 'status-complete'
  const stages = run.status?.stages || {}
  for (const s of STAGE_ORDER) {
    if (stages[s] === 'in-progress') return 'status-in-progress'
  }
  for (const s of STAGE_ORDER) {
    if (stages[s] === 'abandoned') return 'status-abandoned'
  }
  return 'status-pending'
}

function sortRuns(runs: Record<string, Run>): Run[] {
  return Object.values(runs).sort((a, b) => {
    const ka = a.status?.updatedAt ? new Date(a.status.updatedAt).getTime() : (a.event?.createdAt ? new Date(a.event.createdAt).getTime() : 0)
    const kb = b.status?.updatedAt ? new Date(b.status.updatedAt).getTime() : (b.event?.createdAt ? new Date(b.event.createdAt).getTime() : 0)
    if (ka === 0 && kb === 0) return a.runId.localeCompare(b.runId)
    return kb - ka
  })
}

function StageBar({ stages }: { stages: Partial<Record<string, StageStatus>> | undefined }) {
  return (
    <div style={{ display: 'flex', gap: '4px', marginBottom: '0.75rem' }}>
      {STAGE_ORDER.map(stage => {
        const status = stages?.[stage] || 'pending'
        const colors: Record<string, string> = {
          'pending': '#484f58',
          'in-progress': '#58a6ff',
          'complete': '#3fb950',
          'deferred': '#d29922',
          'abandoned': '#f85149',
        }
        return (
          <div
            key={stage}
            title={`${STAGE_LABELS[stage]}: ${status}`}
            style={{
              flex: 1,
              height: '6px',
              borderRadius: '3px',
              background: colors[status] || colors.pending,
              transition: 'background 0.3s',
            }}
          />
        )
      })}
    </div>
  )
}

function StageLabels({ stages }: { stages: Partial<Record<string, StageStatus>> | undefined }) {
  return (
    <div style={{ display: 'flex', gap: '4px', marginBottom: '0.75rem' }}>
      {STAGE_ORDER.map(stage => {
        const status = stages?.[stage] || 'pending'
        const isActive = status !== 'pending'
        return (
          <span
            key={stage}
            style={{
              flex: 1,
              textAlign: 'center',
              fontFamily: 'monospace',
              fontSize: '0.6rem',
              color: isActive ? '#8b949e' : '#484f58',
              textTransform: 'uppercase',
            }}
          >
            {STAGE_LABELS[stage]}
          </span>
        )
      })}
    </div>
  )
}

function RunCard({ run }: { run: Run }) {
  const [expanded, setExpanded] = useState(false)
  const complete = isRunComplete(run)
  const active = isRunActive(run)
  const title = run.event?.title || run.runId
  const issueNum = run.event?.issueNumber
  const stageLabel = getCurrentStageLabel(run)
  const statusClass = getStageStatusClass(run)
  const createdAt = formatTime(run.event?.createdAt)
  const updatedAt = formatTime(run.status?.updatedAt)

  const statusColors: Record<string, { color: string; bg: string }> = {
    'status-in-progress': { color: '#58a6ff', bg: 'rgba(88, 166, 255, 0.15)' },
    'status-complete': { color: '#3fb950', bg: 'rgba(63, 185, 80, 0.15)' },
    'status-pending': { color: '#8b949e', bg: 'rgba(139, 148, 158, 0.1)' },
    'status-abandoned': { color: '#f85149', bg: 'rgba(248, 81, 73, 0.12)' },
  }
  const statusStyle = statusColors[statusClass] || statusColors['status-pending']

  return (
    <div
      onClick={() => setExpanded(!expanded)}
      style={{
        background: '#161b22',
        border: '1px solid #30363d',
        borderRadius: '10px',
        cursor: 'pointer',
        opacity: complete ? 0.55 : 1,
        position: 'relative',
        overflow: 'hidden',
      }}
    >
      {active && (
        <div style={{
          position: 'absolute', top: 0, left: 0, right: 0, height: '2px',
          background: 'linear-gradient(90deg, transparent, #58a6ff, transparent)',
        }} />
      )}
      <div style={{ padding: '18px 20px 14px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '12px', marginBottom: '14px' }}>
          <div style={{ fontWeight: 600, fontSize: '0.95rem' }}>
            {issueNum && <span style={{ fontFamily: 'monospace', color: '#8b949e', fontWeight: 500, fontSize: '0.85rem' }}>#{issueNum}</span>}
            {issueNum && ' -- '}
            {title}
          </div>
          <span style={{
            fontFamily: 'monospace', fontSize: '0.72rem', fontWeight: 500,
            textTransform: 'uppercase', letterSpacing: '0.8px',
            padding: '3px 8px', borderRadius: '4px', whiteSpace: 'nowrap',
            color: statusStyle.color, background: statusStyle.bg,
          }}>
            {stageLabel}
          </span>
        </div>

        <StageBar stages={run.status?.stages} />
        <StageLabels stages={run.status?.stages} />

        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div style={{ fontFamily: 'monospace', fontSize: '0.7rem', color: '#484f58', display: 'flex', gap: '14px' }}>
            {createdAt && <span>Started {createdAt}</span>}
            {updatedAt && <span>Updated {updatedAt}</span>}
          </div>
          <span style={{ fontFamily: 'monospace', fontSize: '0.65rem', color: '#484f58' }}>
            {expanded ? 'collapse' : 'diary'}
          </span>
        </div>
      </div>

      {run.diary && (
        <div style={{
          maxHeight: expanded ? '2000px' : '0',
          overflow: 'hidden',
          transition: 'max-height 0.35s ease',
        }}>
          <div style={{ borderTop: '1px solid #30363d', padding: '16px 20px', maxHeight: '400px', overflowY: 'auto' }}>
            <pre style={{
              fontFamily: 'monospace', fontSize: '0.78rem', lineHeight: 1.65,
              color: '#8b949e', whiteSpace: 'pre-wrap', wordBreak: 'break-word', margin: 0,
            }}>
              {run.diary}
            </pre>
          </div>
        </div>
      )}
    </div>
  )
}

export default function Factory() {
  const { data: initialRuns } = useApi<Record<string, Run>>('/api/factory/runs')
  const [runs, setRuns] = useState<Record<string, Run> | null>(null)

  useEffect(() => {
    if (initialRuns && !runs) setRuns(initialRuns)
  }, [initialRuns])

  const onWsEvent = useCallback((event: { type: string; data: unknown }) => {
    if (event.type === 'factory:update') {
      const update = event.data as { runId: string; file: string; data: unknown }
      setRuns(prev => {
        if (!prev) return prev
        const existing = prev[update.runId] || {
          runId: update.runId,
          event: { title: update.runId },
          status: { runId: update.runId, currentStage: 'unknown', stages: {} },
          diary: '',
        }
        const updated = { ...existing }
        if (update.file === 'status') updated.status = update.data as StatusFile
        else if (update.file === 'event') updated.event = update.data as EventFile
        else if (update.file === 'diary') updated.diary = update.data as string
        return { ...prev, [update.runId]: updated }
      })
    }
  }, [])

  const { connected } = useWebSocket(onWsEvent)

  const runList = runs ? sortRuns(runs) : []
  const totalCount = runList.length
  const activeCount = runList.filter(isRunActive).length
  const completeCount = runList.filter(isRunComplete).length

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem' }}>
        <div>
          <h1 style={{ marginBottom: '0.25rem' }}>Dark Factory</h1>
          {runs && (
            <div style={{ fontFamily: 'monospace', fontSize: '0.85rem', color: '#8b949e' }}>
              <span style={{ fontWeight: 600, color: '#e6edf3' }}>{totalCount}</span> runs:{' '}
              <span style={{ color: '#58a6ff' }}>{activeCount}</span> active,{' '}
              <span style={{ color: '#3fb950' }}>{completeCount}</span> complete
            </div>
          )}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '7px', fontFamily: 'monospace', fontSize: '0.75rem', color: '#8b949e' }}>
          <div style={{
            width: '8px', height: '8px', borderRadius: '50%',
            background: connected ? '#3fb950' : '#f85149',
            boxShadow: connected ? '0 0 6px #3fb950' : 'none',
          }} />
          {connected ? 'Live' : 'Offline'}
        </div>
      </div>

      {!runs && (
        <div style={{ textAlign: 'center', padding: '80px 24px', color: '#484f58', fontFamily: 'monospace' }}>
          Loading factory runs...
        </div>
      )}

      {runs && totalCount === 0 && (
        <div style={{ textAlign: 'center', padding: '80px 24px', color: '#484f58', fontFamily: 'monospace' }}>
          No factory runs found
        </div>
      )}

      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fill, minmax(380px, 1fr))',
        gap: '16px',
      }}>
        {runList.map(run => (
          <RunCard key={run.runId} run={run} />
        ))}
      </div>
    </div>
  )
}
