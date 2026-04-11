import { Component, type ReactNode, type ErrorInfo } from 'react'

interface Props {
  children: ReactNode
}

interface State {
  hasError: boolean
}

export default class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false }

  static getDerivedStateFromError(): State {
    return { hasError: true }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('ErrorBoundary caught:', error, info.componentStack)
  }

  render() {
    if (this.state.hasError) {
      return (
        <div style={{ padding: '2rem', textAlign: 'center', color: '#f85149' }}>
          <h2>Something went wrong</h2>
          <p style={{ color: '#8b949e' }}>An error occurred while rendering this page.</p>
          <button
            className="btn"
            onClick={() => this.setState({ hasError: false })}
            style={{ marginRight: '0.5rem' }}
          >
            Try Again
          </button>
          <a href="/" className="btn">Return to Dashboard</a>
        </div>
      )
    }
    return this.props.children
  }
}
