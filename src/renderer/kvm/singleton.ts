import { KvmClient } from './KvmClient'
import { useStore } from '../state/store'

/**
 * The single renderer-wide KVM client. It reports connection status both to the
 * main process (for the orchestrator to gate on) and to the local store (for the
 * connection badge), and handles bridge commands from the orchestrator.
 */
export const kvmClient = new KvmClient((status) => {
  window.api.reportKvmStatus(status)
  useStore.getState().setConnection(status)
})

export function setupKvmBridge(): void {
  window.api.onKvmCommand((env) => {
    void kvmClient.handleCommand(env.cmd).then((result) => {
      window.api.replyKvmCommand({ id: env.id, result })
    })
  })
}
