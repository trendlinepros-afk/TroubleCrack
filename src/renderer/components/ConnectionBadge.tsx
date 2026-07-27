import type { ConnectionStatus } from '@shared/types'

export function ConnectionBadge({ status }: { status: ConnectionStatus }): React.JSX.Element {
  return (
    <div className="badge" title={status.detail}>
      <span className={`dot ${status.phase}`} />
      <span>{status.detail}</span>
    </div>
  )
}
