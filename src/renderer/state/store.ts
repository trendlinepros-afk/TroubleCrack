import { create } from 'zustand'
import type {
  ChatMessage,
  ConnectionStatus,
  ElevationStatus,
  LogEvent,
  Settings,
  SessionSnapshot,
  UpdateStatus
} from '@shared/types'

const MAX_LOGS = 300

export type View = 'main' | 'settings'

export interface AppState {
  settings: Settings | null
  snapshot: SessionSnapshot | null
  connection: ConnectionStatus
  logs: LogEvent[]
  update: UpdateStatus
  elevation: ElevationStatus | null
  appVersion: string
  idleChat: ChatMessage[]
  view: View

  setSettings: (s: Settings) => void
  setSnapshot: (s: SessionSnapshot | null) => void
  setConnection: (c: ConnectionStatus) => void
  pushLog: (e: LogEvent) => void
  setUpdate: (u: UpdateStatus) => void
  setElevation: (e: ElevationStatus) => void
  setAppVersion: (v: string) => void
  addIdleChat: (m: ChatMessage) => void
  setView: (v: View) => void
}

export const useStore = create<AppState>((set) => ({
  settings: null,
  snapshot: null,
  connection: { phase: 'disconnected', detail: 'Not connected', since: Date.now() },
  logs: [],
  update: { state: 'idle' },
  elevation: null,
  appVersion: '',
  idleChat: [],
  view: 'main',

  setSettings: (s) => set({ settings: s }),
  setSnapshot: (s) => set({ snapshot: s }),
  setConnection: (c) => set({ connection: c }),
  pushLog: (e) =>
    set((state) => ({ logs: [...state.logs.slice(-(MAX_LOGS - 1)), e] })),
  setUpdate: (u) => set({ update: u }),
  setElevation: (e) => set({ elevation: e }),
  setAppVersion: (v) => set({ appVersion: v }),
  addIdleChat: (m) => set((state) => ({ idleChat: [...state.idleChat, m] })),
  setView: (v) => set({ view: v })
}))
