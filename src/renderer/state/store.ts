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
import { lsGet, lsSet } from '../util'

const MAX_LOGS = 300
const VIEW_KEY = 'tc.view'

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
  /** Bumped when the operator asks for a fresh session (menu / shortcut) so the
   *  session bar can pull focus to the problem field. */
  focusProblemNonce: number

  setSettings: (s: Settings) => void
  setSnapshot: (s: SessionSnapshot | null) => void
  setConnection: (c: ConnectionStatus) => void
  pushLog: (e: LogEvent) => void
  setUpdate: (u: UpdateStatus) => void
  setElevation: (e: ElevationStatus) => void
  setAppVersion: (v: string) => void
  addIdleChat: (m: ChatMessage) => void
  setView: (v: View) => void
  requestNewSession: () => void
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
  view: lsGet<View>(VIEW_KEY, 'main'),
  focusProblemNonce: 0,

  setSettings: (s) => set({ settings: s }),
  setSnapshot: (s) => set({ snapshot: s }),
  setConnection: (c) => set({ connection: c }),
  pushLog: (e) =>
    set((state) => ({ logs: [...state.logs.slice(-(MAX_LOGS - 1)), e] })),
  setUpdate: (u) => set({ update: u }),
  setElevation: (e) => set({ elevation: e }),
  setAppVersion: (v) => set({ appVersion: v }),
  addIdleChat: (m) => set((state) => ({ idleChat: [...state.idleChat, m] })),
  setView: (v) => {
    lsSet(VIEW_KEY, v)
    set({ view: v })
  },
  requestNewSession: () =>
    set((state) => {
      lsSet(VIEW_KEY, 'main')
      return { view: 'main', focusProblemNonce: state.focusProblemNonce + 1 }
    })
}))
