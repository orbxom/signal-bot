interface StatusCardProps {
  label: string
  value: string | number
  detail?: string
  variant?: 'default' | 'success' | 'warning' | 'error'
}

export default function StatusCard({ label, value, detail, variant = 'default' }: StatusCardProps) {
  return (
    <div className={`status-card status-card--${variant}`}>
      <div className="status-card__label">{label}</div>
      <div className="status-card__value">{value}</div>
      {detail && <div className="status-card__detail">{detail}</div>}
    </div>
  )
}
