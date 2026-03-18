import { useEffect, useRef, useCallback, useState } from 'react'

interface WsEvent {
  type: string
  data: unknown
}

export function useWebSocket(onEvent: (event: WsEvent) => void) {
  const [connected, setConnected] = useState(false)
  const wsRef = useRef<WebSocket | null>(null)
  const retryRef = useRef(1000)

  const connect = useCallback(() => {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const ws = new WebSocket(`${protocol}//${window.location.host}/ws`)

    ws.onopen = () => {
      setConnected(true)
      retryRef.current = 1000
    }

    ws.onmessage = (e) => {
      try {
        const event = JSON.parse(e.data) as WsEvent
        onEvent(event)
      } catch { /* ignore parse errors */ }
    }

    ws.onclose = () => {
      setConnected(false)
      setTimeout(connect, Math.min(retryRef.current, 10000))
      retryRef.current *= 2
    }

    wsRef.current = ws
  }, [onEvent])

  useEffect(() => {
    connect()
    return () => wsRef.current?.close()
  }, [connect])

  return { connected }
}
