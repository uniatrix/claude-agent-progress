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
}

/** Running averages of finished agents of one type, for the estimated bar. */
export type TypeStats = { runs: number; tools: number; ms: number }

declare module 'claude-code' {
  interface PluginState {
    'agent-progress': {
      rows: Record<string, AgentRow>
      now: number
      isBandHidden: boolean
      stats: Record<string, TypeStats>
    }
  }
}
