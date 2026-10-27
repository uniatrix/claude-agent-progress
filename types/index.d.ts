export type StepStatus = 'pending' | 'in_progress' | 'completed'

export type Step = { id: string; subject: string; status: StepStatus }

export type RowStatus = 'running' | 'waiting' | 'completed' | 'failed' | 'killed'

/** One loop of the session: the main conversation (`id: 'main'`) or an agent. */
export type AgentRow = {
  id: string
  label: string
  type: string
  parentId?: string
  status: RowStatus
  startedAt: number
  endedAt?: number
  tools: number
  lastTool?: string
  current?: string
  steps: Step[]
  isWorkflow: boolean
  /** `task` for background work (a shell, monitor or workflow), `agent` otherwise. */
  kind?: 'agent' | 'task'
  /** A background shell's output file, read for progress it prints. */
  outputPath?: string
  /** Logs the command writes to (`> work/render.log`), or that the agent read to check on it. */
  logPaths?: string[]
  /** The file last read for progress, and its size then. */
  watched?: string
  outputSize?: number
  /** Progress the work printed itself (`13914/16638`, `84%`), 0 to 1. */
  outputRatio?: number
}

/** Running averages of finished agents of one type, for the estimated bar. */
export type TypeStats = { runs: number; tools: number; ms: number }

declare module 'claude-code' {
  interface PluginState {
    'agent-progress': {
      rows: Record<string, AgentRow>
      now: number
      isPaneDismissed: boolean
      isBandExpanded: boolean
      stats: Record<string, TypeStats>
    }
  }
}
