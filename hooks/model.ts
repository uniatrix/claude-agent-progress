import type { AgentRow, RowStatus, Step, StepStatus, TypeStats } from '../types'

export const MAIN = 'main'

/** Tool calls a type takes when no finished run of it was seen yet. */
const DEFAULT_TOOLS: Record<string, number> = {
  Explore: 18,
  Plan: 15,
  'general-purpose': 30,
  'claude-code-guide': 20,
}

/** What the bar shows: `isEstimate` for the history guess, `null` with no basis. */
export type Progress = { ratio: number; isEstimate: boolean } | null

export function isLive(status: RowStatus): boolean {
  return status === 'running' || status === 'waiting'
}

/** Real progress from a checklist; in-progress steps count half. */
export function checklistRatio(steps: readonly Step[]): number | null {
  if (steps.length === 0) return null
  const done = steps.reduce(
    (sum, s) => sum + (s.status === 'completed' ? 1 : s.status === 'in_progress' ? 0.5 : 0),
    0,
  )

  return done / steps.length
}

/**
 * A curve that rises fast and never reaches 100%: at the type's usual tool
 * count (or usual duration, whichever is further along) it reads about 82%.
 */
export function estimateRatio(row: AgentRow, stats: TypeStats | undefined, now: number): number {
  const tools = stats && stats.runs > 0 ? stats.tools : (DEFAULT_TOOLS[row.type] ?? 25)
  const byTools = row.tools / Math.max(1, tools)
  const elapsed = (row.endedAt ?? now) - row.startedAt
  const byTime = stats && stats.runs > 0 && stats.ms > 0 ? elapsed / stats.ms : 0
  const x = Math.max(byTools, byTime)

  return 0.95 * (1 - Math.exp(-2 * x))
}

export function progressOf(
  row: AgentRow,
  stats: Record<string, TypeStats>,
  now: number,
): Progress {
  if (row.status === 'completed') return { ratio: 1, isEstimate: false }
  if (row.kind === 'task') {
    // Background work has no checklist and no comparable history: only what it printed.
    return row.outputRatio === undefined ? null : { ratio: row.outputRatio, isEstimate: false }
  }
  const real = checklistRatio(row.steps)
  if (real !== null) return { ratio: real, isEstimate: false }
  // The main conversation varies too much per prompt for a guess to mean anything.
  if (row.id === MAIN) return null

  return { ratio: estimateRatio(row, stats[row.type], now), isEstimate: true }
}

const PERCENT = /(\d{1,3}(?:[.,]\d+)?)\s?%/g
const FRACTION = /\b(\d+)\s?\/\s?(\d+)\b/g

/**
 * The last progress a program printed: `Rendered 13914/16638` or `84%`, the
 * one nearest the end winning. Fractions need a whole of 10 or more, so a
 * date or a `1/2` is not read as progress.
 */
export function parseOutputProgress(text: string): number | undefined {
  let best: { at: number; ratio: number } | undefined
  for (const m of text.matchAll(PERCENT)) {
    const n = Number((m[1] ?? '').replace(',', '.'))
    if (n >= 0 && n <= 100) best = { at: m.index ?? 0, ratio: n / 100 }
  }
  for (const m of text.matchAll(FRACTION)) {
    const done = Number(m[1])
    const whole = Number(m[2])
    const at = m.index ?? 0
    if (whole >= 10 && done <= whole && (!best || at > best.at)) best = { at, ratio: done / whole }
  }

  return best?.ratio
}

const LEADING_CD = /^\s*cd\s+(?:"([^"]+)"|'([^']+)'|([^\s&;|]+))\s*(?:&&|;)/
const REDIRECT = /(?:^|[^\d&<>])(?:\d|&)?>>?\s*(?:"([^"]+)"|'([^']+)'|([^\s"'&|;<>]+))/g
const TEE = /\|\s*(?:tee|Tee-Object)\s+(?:-a\s+|-FilePath\s+|-Append\s+)*(?:"([^"]+)"|'([^']+)'|([^\s"'&|;<>]+))/gi
const READS = /\b(?:tail|cat|head|less|type|Get-Content|gc)\b/
const LOG_NAME = /(?:"([^"]+\.(?:log|txt|out))"|'([^']+\.(?:log|txt|out))'|([^\s"'&|;<>]+\.(?:log|txt|out)))(?![\w.])/gi
const NOT_A_LOG = /^(?:\/dev\/null|nul)$|\.(?:mp4|mov|mkv|webm|png|jpe?g|gif|webp|wav|mp3|ogg|zip|7z|tar|gz|exe|dll|bin)$/i

/** `/c/Users/x` (Git Bash) and `C:\Users\x` both as `C:/Users/x`. */
export function toHostPath(path: string): string {
  const slashed = path.replace(/\\/g, '/')
  const drive = /^\/([a-zA-Z])\//.exec(slashed)

  return drive ? `${(drive[1] ?? '').toUpperCase()}:/${slashed.slice(3)}` : slashed
}

function isAbsolute(path: string): boolean {
  return /^(?:[a-zA-Z]:\/|\/)/.test(path)
}

function resolveIn(base: string, path: string): string {
  const p = toHostPath(path)
  if (isAbsolute(p)) return p

  return `${toHostPath(base).replace(/\/+$/, '')}/${p.replace(/^\.\//, '')}`
}

/** The directory a command runs in: its leading `cd`, else the session's. */
export function commandDir(command: string, cwd: string): string {
  const m = LEADING_CD.exec(command)
  const dir = m?.[1] ?? m?.[2] ?? m?.[3]

  return dir === undefined ? toHostPath(cwd) : resolveIn(cwd, dir)
}

function collect(pattern: RegExp, command: string, dir: string, out: string[]): void {
  for (const m of command.matchAll(pattern)) {
    const target = m[1] ?? m[2] ?? m[3]
    // A file looks like one (`run.log`, `work/x`): a bare `b` is `a > b` in some code.
    if (target === undefined || NOT_A_LOG.test(target) || !/[./\\]/.test(target)) continue
    const path = resolveIn(dir, target)
    if (!out.includes(path)) out.push(path)
  }
}

/** The files a command sends its output to: `> work/render.log`, `| tee run.log`. */
export function logTargets(command: string, cwd: string): string[] {
  const dir = commandDir(command, cwd)
  const out: string[] = []
  collect(REDIRECT, command, dir, out)
  collect(TEE, command, dir, out)

  return out
}

/** The logs a command reads (`tail -c 400 work/render.log`), when it reads any. */
export function polledLogs(command: string, cwd: string): string[] {
  if (!READS.test(command)) return []
  const dir = commandDir(command, cwd)
  const out: string[] = []
  collect(LOG_NAME, command, dir, out)

  return out
}

/** The last non-empty line of a program's output, for the row's detail. */
export function lastLine(text: string): string | undefined {
  // Terminal colors (`\x1b[34m`) are noise outside a terminal.
  const plain = text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
  const lines = plain.split(/[\r\n]+/).map(l => l.trim()).filter(Boolean)

  return lines[lines.length - 1]
}

/** Folds one finished run into its type's running averages. */
export function foldStats(prev: TypeStats | undefined, tools: number, ms: number): TypeStats {
  if (!prev || prev.runs === 0) return { runs: 1, tools, ms }
  const a = prev.runs < 5 ? 1 / (prev.runs + 1) : 0.25

  return {
    runs: prev.runs + 1,
    tools: prev.tools + a * (tools - prev.tools),
    ms: prev.ms + a * (ms - prev.ms),
  }
}

/** Steps from the `progress` tool: the first `done` finished, the next one running. */
export function stepsFromList(subjects: readonly string[], done: number): Step[] {
  return subjects.map((subject, i) => ({
    id: `p${i}`,
    subject,
    status: (i < done ? 'completed' : i === done ? 'in_progress' : 'pending') as StepStatus,
  }))
}

export function withDone(steps: readonly Step[], done: number): Step[] {
  return stepsFromList(
    steps.map(s => s.subject),
    done,
  )
}

export function textBar(ratio: number, width: number, isEstimate: boolean): string {
  const filled = Math.round(Math.min(1, Math.max(0, ratio)) * width)

  return (isEstimate ? '▒' : '█').repeat(filled) + '░'.repeat(width - filled)
}

export function percent(p: Progress): string {
  if (p === null) return '  …'
  const n = `${Math.round(p.ratio * 100)}%`

  return (p.isEstimate ? `~${n}` : n).padStart(4)
}

export function duration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m${String(s % 60).padStart(2, '0')}s`

  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`
}

const BASENAME = /[^\\/]+$/

function base(path: unknown): string {
  return typeof path === 'string' ? (BASENAME.exec(path)?.[0] ?? path) : ''
}

function clip(text: unknown, n: number): string {
  if (typeof text !== 'string') return ''
  const one = text.replace(/\s+/g, ' ').trim()

  return one.length > n ? `${one.slice(0, n - 1)}…` : one
}

/** A few words on what a tool call is doing, for the row's "current" column. */
export function describeCall(tool: string, input: Record<string, unknown>): string {
  switch (tool) {
    case 'Read':
      return `Lendo ${base(input.file_path)}`
    case 'Edit':
    case 'Write':
    case 'NotebookEdit':
      return `Editando ${base(input.file_path ?? input.notebook_path)}`
    case 'Grep':
      return `Buscando "${clip(input.pattern, 30)}"`
    case 'Glob':
      return `Listando ${clip(input.pattern, 30)}`
    case 'Bash':
    case 'PowerShell':
      return `$ ${clip(input.command, 40)}`
    case 'WebFetch':
      return `Abrindo ${clip(input.url, 40)}`
    case 'WebSearch':
      return `Pesquisando "${clip(input.query, 30)}"`
    case 'Agent':
      return `Delegando: ${clip(input.description, 30)}`
    default:
      return tool.startsWith('mcp__') ? tool.split('__').slice(1).join(' ') : tool
  }
}

/** Rows in tree order: main first, each agent under its parent, oldest first. */
export function treeOrder(rows: Record<string, AgentRow>): { row: AgentRow; depth: number }[] {
  const all = Object.values(rows)
  const children = new Map<string, AgentRow[]>()
  for (const row of all) {
    if (row.id === MAIN) continue
    const parent = row.parentId && rows[row.parentId] ? row.parentId : MAIN
    const list = children.get(parent) ?? []
    list.push(row)
    children.set(parent, list)
  }
  const out: { row: AgentRow; depth: number }[] = []
  const walk = (id: string, depth: number) => {
    const list = (children.get(id) ?? []).sort((a, b) => a.startedAt - b.startedAt)
    for (const row of list) {
      out.push({ row, depth })
      walk(row.id, depth + 1)
    }
  }
  const main = rows[MAIN]
  if (main) out.push({ row: main, depth: 0 })
  walk(MAIN, main ? 1 : 0)

  return out
}

export type Counts = { running: number; waiting: number; done: number; failed: number }

export function countRows(rows: Record<string, AgentRow>): Counts {
  const c: Counts = { running: 0, waiting: 0, done: 0, failed: 0 }
  for (const row of Object.values(rows)) {
    if (row.id === MAIN) continue
    if (row.status === 'running') c.running += 1
    else if (row.status === 'waiting') c.waiting += 1
    else if (row.status === 'completed') c.done += 1
    else c.failed += 1
  }

  return c
}

export function mapListStatus(status: string): RowStatus | undefined {
  switch (status) {
    case 'pending':
    case 'running':
      return 'running'
    case 'waiting':
    case 'idle':
      return 'waiting'
    case 'completed':
    case 'failed':
    case 'killed':
      return status
    default:
      return undefined
  }
}
