import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { AgentRow, RowStatus, Step, TypeStats } from '../types'
import {
  MAIN,
  countRows,
  describeCall,
  duration,
  foldStats,
  isLive,
  lastLine,
  logTargets,
  mapListStatus,
  parseOutputProgress,
  percent,
  polledLogs,
  progressOf,
  stepsFromList,
  textBar,
  treeOrder,
  viewOf,
  liveSummary,
  withDone,
} from './model'
import type { Item, Progress } from './model'

const P = 'agent-progress'
const PANE = 'agentes'
const TOOL = 'progress'
const TOOL_NAME = `mcp__${P}__${TOOL}`
/** Finished rows stay in the band this long, then only the pane lists them. */
const LINGER_MS = 20_000
/** Finished rows older than this are dropped altogether. */
const KEEP_MS = 30 * 60_000

const rows = atom({ plugin: 'agent-progress', key: 'rows' } as const, {})
const now = atom({ plugin: 'agent-progress', key: 'now' } as const, 0)
const isPaneDismissed = atom({ plugin: 'agent-progress', key: 'isPaneDismissed' } as const, false)
const isBandExpanded = atom({ plugin: 'agent-progress', key: 'isBandExpanded' } as const, false)
const stats = atom({ plugin: 'agent-progress', key: 'stats' } as const, {})

const TOOL_DESCRIPTION = [
  'Reports progress on your current multi-step task so the user sees a progress bar in their UI.',
  'Call it once at the start with `steps` (3 to 8 short items, in the language the user writes in) and `done: 0`;',
  'then call it again with only `done` (how many steps are finished) and optionally `current` (a few words on what you are doing) each time you finish a step.',
  'It returns nothing useful; do not use it for single-step work.',
].join(' ')

const SUBAGENT_NOTE = [
  '',
  '',
  '---',
  `Progresso: o usuário acompanha este trabalho numa barra de progresso. Se a tarefa tiver mais de uma etapa, chame a ferramenta ${TOOL_NAME} logo no início com \`steps\` (3 a 8 etapas curtas) e \`done: 0\`, e de novo com \`done\` atualizado a cada etapa concluída. Não use TaskCreate nem TodoWrite para isso.`,
].join('\n')

const NAME_RULE =
  'write 2 or 3 words, the key one first, 16 characters at most (e.g. "Render ep. 1", "Busca deploy"), in the language the user writes in.'
const AGENT_NAME_NOTE = `Naming: \`description\` is the name the user reads in a narrow list of running work that cuts it at about 16 characters: ${NAME_RULE}`
const SHELL_NAME_NOTE = `Naming: when \`run_in_background\` is true, \`description\` is the name the user reads in a narrow list of running work that cuts it at about 16 characters: ${NAME_RULE}`

const MAIN_NOTE = [
  '# Painel de progresso',
  'O usuário acompanha o trabalho por barras de progresso num painel. Em tarefas com 3 ou mais etapas, mantenha uma checklist enquanto trabalha:',
  `use TaskCreate/TaskUpdate se estiverem disponíveis, senão a ferramenta ${TOOL_NAME} (steps + done: 0 no início, done atualizado a cada etapa).`,
  `Subagentes usam só ${TOOL_NAME}. Em respostas curtas ou de uma etapa, não crie checklist.`,
].join('\n')

type Engine = EngineInterface

function fresh(id: string, t: number): AgentRow {
  return {
    id,
    label: id === MAIN ? 'Conversa principal' : 'agente',
    type: id === MAIN ? 'main' : '?',
    status: 'running',
    startedAt: t,
    tools: 0,
    steps: [],
    isWorkflow: false,
  }
}

async function patch(
  $: Engine,
  id: string,
  change: (row: AgentRow | undefined) => AgentRow | undefined,
): Promise<void> {
  await update($, rows, all => {
    const next = change(all[id])

    return next ? { ...all, [id]: next } : all
  })
}

function clip(text: string, n: number): string {
  const one = text.replace(/\s+/g, ' ').trim()

  return one.length > n ? `${one.slice(0, n - 1)}…` : one
}

const COLORS: Record<RowStatus, string> = {
  running: '#D97757',
  waiting: '#D29922',
  completed: '#3FB950',
  failed: '#F85149',
  killed: '#F85149',
}

const THEME: Record<RowStatus, 'claude' | 'warning' | 'success' | 'error'> = {
  running: 'claude',
  waiting: 'warning',
  completed: 'success',
  failed: 'error',
  killed: 'error',
}

const ICON: Record<RowStatus, string> = {
  running: '●',
  waiting: '◌',
  completed: '✓',
  failed: '✗',
  killed: '✗',
}

/** The remote surfaces' bar: solid for a checklist, striped for an estimate. */
function svgBar(p: Progress, status: RowStatus): string {
  const W = 120
  const H = 8
  const color = COLORS[status]
  const w = p === null ? 0 : Math.round(W * Math.min(1, Math.max(0, p.ratio)))
  const fill = p?.isEstimate ? 'url(#s)' : color

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`,
    '<defs><pattern id="s" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">',
    `<rect width="6" height="6" fill="${color}" fill-opacity="0.35"/><rect width="3" height="6" fill="${color}"/>`,
    '</pattern></defs>',
    `<rect width="${W}" height="${H}" rx="4" fill="#888888" fill-opacity="0.25"/>`,
    w > 0 ? `<rect width="${w}" height="${H}" rx="4" fill="${fill}"/>` : '',
    '</svg>',
  ].join('')
}

async function syncList($: Engine, t: number): Promise<void> {
  const list = await $.agent.list()
  await update($, rows, all => {
    const out: Record<string, AgentRow> = {}
    for (const [id, row] of Object.entries(all)) {
      const isStale = !isLive(row.status) && t - (row.endedAt ?? t) > KEEP_MS
      if (!isStale) out[id] = row
    }
    for (const info of list) {
      const status = mapListStatus(info.status)
      if (status === undefined) continue
      const row = out[info.id]
      if (row) {
        if (row.status !== status) {
          out[info.id] = {
            ...row,
            status,
            endedAt: isLive(status) ? undefined : (row.endedAt ?? t),
          }
        }
      } else if (isLive(status)) {
        // An agent started before this mod loaded: known from here on.
        out[info.id] = {
          ...fresh(info.id, t),
          label: info.description || info.name || 'agente',
          type: info.type,
          parentId: info.parentId ?? MAIN,
          status,
        }
      }
    }

    return out
  })
}

/** `62%`, or `≈62%` for an estimate. */
function pct(i: Item): string {
  return `${i.isEstimate ? '≈' : ''}${Math.round((i.ratio ?? 0) * 100)}%`
}

/** Opens the panel; `asked` is the person's own ask, which also undoes a close. */
async function openPane($: Engine, asked: boolean) {
  if (asked) await update($, isPaneDismissed, () => false)

  return $.ui.open({ id: PANE, title: 'Agentes' })
}

async function isPaneShown($: Engine): Promise<boolean> {
  try {
    return (await $.ui.panes()).some(p => p.id === PANE && p.isShown)
  } catch {
    return false
  }
}

/** The clock as the last tick saw it, never before the newest row started. */
async function nowOf($: Engine): Promise<number> {
  const all = await read($, rows)

  return Math.max(await read($, now), ...Object.values(all).map(r => r.startedAt))
}

let wasBusy = false

/** Work began: open the panel beside the chat, unless the person closed it. */
async function openOnWork($: Engine): Promise<void> {
  const view = viewOf(await read($, rows), await read($, stats), await nowOf($))
  const isBusy = view.live.length > 0
  const began = isBusy && !wasBusy
  wasBusy = isBusy
  if (!began || (await read($, isPaneDismissed)) || (await isPaneShown($))) return
  const opened = await openPane($, false)
  noteRender('pane:open', opened.isPlaced ? 'placed' : `waits: ${opened.reason}`)
}

let ticks = 0
let isTicking = false

/** The one-second refresh; started at session start, or by the first tool call when the mod came later. */
function startTicking($: Engine): void {
  if (isTicking) return
  isTicking = true
  $.clock.every(1000, () => void tick($).catch(() => undefined))
}

/** Debug only: what each site last drew, read by the `snapshot` tool. */
const renders: Record<string, { count: number; last: string }> = {}

function noteRender(site: string, outcome: string): void {
  const seen = renders[site] ?? { count: 0, last: '' }
  renders[site] = { count: seen.count + 1, last: outcome }
}

/** What a backgrounded command's result says about where its output goes. */
const OUTPUT_PATH = /Output is being written to: (.+?\.output)/
/** `$.fs.read` refuses past 4 MiB; a log that long is left unread. */
const READ_LIMIT = 4 * 1024 * 1024
const TAIL = 4000

function taskKey(id: string): string {
  return `task:${id}`
}

type TaskSummary = { id: string; type: string; status: string; description: string }

/**
 * Background work as a Stop hook lists it: each one listed is running, and a
 * tracked one no longer listed has finished.
 */
async function reconcileTasks($: Engine, listed: readonly TaskSummary[] | undefined, t: number): Promise<void> {
  if (listed === undefined) return
  const tasks = listed.filter(task => task.type !== 'subagent')
  await update($, rows, all => {
    const out = { ...all }
    const seen = new Set<string>()
    for (const task of tasks) {
      const id = taskKey(task.id)
      seen.add(id)
      const prev = out[id]
      out[id] = {
        ...(prev ?? fresh(id, t)),
        label: prev?.label ?? clip(task.description || task.type, 60),
        type: prev?.type ?? task.type,
        kind: 'task',
        parentId: prev?.parentId ?? MAIN,
        status: 'running',
        endedAt: undefined,
      }
    }
    for (const row of Object.values(all)) {
      if (row.kind === 'task' && isLive(row.status) && !seen.has(row.id)) {
        out[row.id] = { ...row, status: 'completed', endedAt: t }
      }
    }

    return out
  })
}

/** The file a task is writing now: of its output and logs, the last one touched. */
async function liveFile($: Engine, row: AgentRow): Promise<{ path: string; size: number } | undefined> {
  const paths = [row.outputPath, ...(row.logPaths ?? [])].filter((p): p is string => p !== undefined)
  let best: { path: string; size: number; mtimeMs: number } | undefined
  for (const path of paths) {
    try {
      const { size, mtimeMs, kind } = await $.fs.stat(path)
      if (kind === 'file' && size > 0 && (!best || mtimeMs > best.mtimeMs)) best = { path, size, mtimeMs }
    } catch {
      // Not written yet (a later stage's log), or gone.
    }
  }

  return best
}

/**
 * Reads what running background shells print, for progress they report: the
 * file being written now, so a chain (render, then master) follows each stage.
 */
async function readTaskOutputs($: Engine): Promise<void> {
  const all = await read($, rows)
  for (const row of Object.values(all)) {
    if (row.kind !== 'task' || !isLive(row.status)) continue
    const file = await liveFile($, row)
    if (file === undefined || file.size > READ_LIMIT) continue
    if (file.path === row.watched && file.size === row.outputSize) continue
    try {
      const text = await $.fs.read(file.path)
      const tail = typeof text === 'string' ? text.slice(-TAIL) : ''
      const ratio = parseOutputProgress(tail)
      const line = lastLine(tail)
      await patch($, row.id, prev =>
        prev && {
          ...prev,
          watched: file.path,
          outputSize: file.size,
          // A new stage's log without a number has no progress of its own yet.
          outputRatio: ratio ?? (file.path === prev.watched ? prev.outputRatio : undefined),
          current: line ? clip(line, 80) : prev.current,
        },
      )
    } catch {
      // The file is gone or unreadable: the row keeps what it had.
    }
  }
}

async function tick($: Engine): Promise<void> {
  ticks += 1
  const t = await $.clock.now()
  const all = await read($, rows)
  const isActive = Object.values(all).some(
    r => isLive(r.status) || (r.endedAt !== undefined && t - r.endedAt < LINGER_MS + 2000),
  )
  if (isActive) await update($, now, () => t)
  // Each step on its own: one that fails (no agent list, say) leaves the others running.
  if (isActive || ticks % 10 === 0) await syncList($, t).catch(() => undefined)
  if (isActive && ticks % 2 === 0) await readTaskOutputs($).catch(() => undefined)
  await openOnWork($).catch(() => undefined)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const saved = await $.store.get('stats')
    if (saved && typeof saved === 'object') {
      await update($, stats, () => saved as Record<string, TypeStats>)
    }
    await $.tool.register({
      name: TOOL,
      description: TOOL_DESCRIPTION,
      isDeferred: false,
      inputSchema: {
        type: 'object',
        properties: {
          steps: {
            type: 'array',
            items: { type: 'string' },
            description: 'The full list of steps (send on the first call, or to replace the list).',
          },
          done: { type: 'integer', minimum: 0, description: 'How many steps are finished.' },
          current: { type: 'string', description: 'A few words on what you are doing now.' },
        },
      },
    })
    await $.tool.register({
      name: 'snapshot',
      description:
        'Debug for the agent-progress mod: returns, as JSON, the rows it tracks, the attached surfaces, the open panes and what the band and pane last drew. Only when asked to debug the progress panel.',
      isDeferred: true,
    })
    await $.command.register({
      name: 'agentes',
      description: 'Abre o painel de progresso dos agentes desta sessão',
    })
    startTicking($)

    return next(e)
  })

  on('command.run', { command: 'agentes' }, async $ => {
    const opened = await openPane($, true)

    return {
      text: opened.isPlaced
        ? 'Painel de agentes aberto.'
        : `Painel de agentes aguardando espaço na tela: ${opened.reason}`,
    }
  })

  // The app lists running work in a narrow column that cuts names at about 16
  // characters: the name is the call's `description`, so ask for one that fits.
  on('tool.describe', async ($, e, next) => {
    const out = await next(e)
    const note = e.tool === 'Agent' ? AGENT_NAME_NOTE : e.tool === 'Bash' || e.tool === 'PowerShell' ? SHELL_NAME_NOTE : ''

    return note ? { ...out, description: `${out.description}\n\n${note}` } : out
  })

  on('prompt.context', ($, e, next) =>
    next({ ...e, blocks: [...e.blocks, { name: `${P}:checklist`, text: MAIN_NOTE }] }),
  )

  on('turn.start', async ($, e, next) => {
    const t = await $.clock.now()
    await patch($, MAIN, prev => ({
      ...fresh(MAIN, t),
      // Tasks outlive a turn; keep the list while any of it is still open.
      steps: prev && prev.steps.some(s => s.status !== 'completed') ? prev.steps : [],
    }))

    return next(e)
  })

  on('agent.spawn', async ($, e, next) => {
    const isWorkflow = e.workflow !== undefined
    // A workflow agent's prompt is the script's; a rewrite there is ignored.
    const started = await next(isWorkflow ? e : { ...e, prompt: e.prompt + SUBAGENT_NOTE })
    const id = started.agentId
    if (id !== undefined) {
      const t = await $.clock.now()
      await patch($, id, prev => ({
        ...(prev ?? fresh(id, t)),
        label: e.description || e.name || 'agente',
        type: e.subagentType,
        parentId: e.parentAgentId ?? MAIN,
        status: 'running',
        startedAt: prev?.startedAt ?? t,
        isWorkflow,
      }))
    }

    return started
  })

  on('tool.call', async ($, e, next) => {
    startTicking($)
    const key = e.agentId ?? MAIN
    const tool = String(e.tool)
    const t = await $.clock.now()

    if (tool === `mcp__${P}__snapshot`) {
      const all = await read($, rows)
      const known = await read($, stats)
      const t = await $.clock.now()
      const report = {
        surfaces: await $.session.surfaces(),
        panes: await $.ui.panes(),
        isPaneDismissed: await read($, isPaneDismissed),
        renders,
        rows: treeOrder(all).map(({ row, depth }) => ({
          depth,
          id: row.id.slice(0, 8),
          label: row.label,
          type: row.type,
          status: row.status,
          tools: row.tools,
          steps: `${row.steps.filter(s => s.status === 'completed').length}/${row.steps.length}`,
          progress: percent(progressOf(row, known, t)).trim(),
          current: row.current,
        })),
        stats: known,
      }

      return { result: JSON.stringify(report, null, 1) }
    }

    if (tool === TOOL_NAME) {
      const input = e as unknown as Record<string, unknown>
      const list = Array.isArray(input.steps)
        ? input.steps.filter((s): s is string => typeof s === 'string').slice(0, 20)
        : undefined
      const done =
        typeof input.done === 'number' && Number.isFinite(input.done)
          ? Math.max(0, Math.floor(input.done))
          : undefined
      const current = typeof input.current === 'string' ? clip(input.current, 60) : undefined
      await patch($, key, prev => {
        const row = prev ?? fresh(key, t)
        const steps = list
          ? stepsFromList(list, done ?? 0)
          : done !== undefined
            ? withDone(row.steps, done)
            : row.steps

        return { ...row, status: 'running', steps, current: current ?? row.current }
      })

      return { result: 'ok' }
    }

    await patch($, key, prev => {
      const row = prev ?? fresh(key, t)

      return {
        ...row,
        status: 'running',
        endedAt: undefined,
        tools: row.tools + 1,
        lastTool: tool,
        current: describeCall(tool, e as unknown as Record<string, unknown>),
      }
    })
    const ran = await next(e)
    if (ran.deny !== undefined) return ran

    // PowerShell is Windows' alone: compared as a string so every build types it.
    if (tool === 'Bash' || tool === 'PowerShell') {
      const shell = e as unknown as { command?: unknown; description?: unknown }
      const command = typeof shell.command === 'string' ? shell.command : ''
      const description = typeof shell.description === 'string' ? shell.description : ''
      const out = ran.result as { backgroundTaskId?: unknown } | undefined
      const bg = typeof out?.backgroundTaskId === 'string' ? out.backgroundTaskId : undefined
      const text = ran.text ?? ''
      // Only resolves relative log paths: without it they are left relative.
      const cwd = await $.session.cwd().catch(() => '')
      if (bg !== undefined) {
        const id = taskKey(bg)
        const path = OUTPUT_PATH.exec(text)?.[1]
        await patch($, id, prev => ({
          ...(prev ?? fresh(id, t)),
          label: clip(description || command, 60),
          type: 'shell',
          kind: 'task',
          parentId: key,
          status: 'running',
          outputPath: path ?? prev?.outputPath,
          // Where the command sends its own output (`> work/render.log`): read from now on.
          logPaths: logTargets(command, cwd),
        }))
      } else {
        // A check on background work's own log (`tail work/render.log`, printing
        // "Rendered 13914/16638"): when this loop runs exactly one background
        // task, the log and the progress are its, and the log is read from now on.
        const tail = text.slice(-TAIL)
        const ratio = parseOutputProgress(tail)
        const logs = polledLogs(command, cwd)
        if (ratio !== undefined || logs.length > 0) {
          const line = lastLine(tail)
          await update($, rows, all => {
            const mine = Object.values(all).filter(
              r => r.kind === 'task' && isLive(r.status) && (r.parentId ?? MAIN) === key,
            )
            const only = mine.length === 1 ? mine[0] : undefined
            if (only === undefined) return all
            const known = only.logPaths ?? []

            return {
              ...all,
              [only.id]: {
                ...only,
                logPaths: [...known, ...logs.filter(l => !known.includes(l))],
                outputRatio: ratio ?? only.outputRatio,
                current: ratio !== undefined && line ? clip(line, 80) : only.current,
              },
            }
          })
        }
      }
    }
    if (ran.isError) return ran

    if (e.tool === 'TaskCreate') {
      const made = ran.result as { task?: { id?: string } } | undefined
      const id = made?.task?.id
      if (id !== undefined) {
        const step: Step = { id, subject: e.subject, status: 'pending' }
        await patch($, key, prev => {
          const row = prev ?? fresh(key, t)

          return { ...row, steps: [...row.steps.filter(s => s.id !== id), step] }
        })
      }
    } else if (e.tool === 'TaskUpdate') {
      const { taskId, status, subject } = e
      await update($, rows, all => {
        const owner = all[key]?.steps.some(s => s.id === taskId)
          ? key
          : Object.keys(all).find(k => all[k]?.steps.some(s => s.id === taskId))
        const row = owner === undefined ? undefined : all[owner]
        if (owner === undefined || row === undefined) return all
        const steps =
          status === 'deleted'
            ? row.steps.filter(s => s.id !== taskId)
            : row.steps.map(s =>
                s.id === taskId
                  ? { ...s, status: status ?? s.status, subject: subject ?? s.subject }
                  : s,
              )

        return { ...all, [owner]: { ...row, steps } }
      })
    } else if (e.tool === 'TodoWrite') {
      const steps: Step[] = e.todos.map((todo, i) => ({
        id: `todo${i}`,
        subject: todo.content,
        status: todo.status,
      }))
      await patch($, key, prev => ({ ...(prev ?? fresh(key, t)), steps }))
    }

    return ran
  })

  on('classic.Stop', async ($, e, next) => {
    await reconcileTasks($, e.background_tasks, await $.clock.now())

    return next(e)
  })

  on('classic.SubagentStop', async ($, e, next) => {
    await reconcileTasks($, e.background_tasks, await $.clock.now())

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const key = e.agentId ?? MAIN
    const t = await $.clock.now()
    const status: RowStatus = e.isAborted
      ? 'killed'
      : e.reason === 'error'
        ? 'failed'
        : 'completed'
    let finished: AgentRow | undefined
    await patch($, key, prev => {
      if (prev === undefined) return undefined
      finished = { ...prev, status, endedAt: t }

      return finished
    })
    const done = finished
    if (key !== MAIN && status === 'completed' && done !== undefined && done.type !== '?') {
      const all = await update($, stats, s => ({
        ...s,
        [done.type]: foldStats(s[done.type], done.tools, t - done.startedAt),
      }))
      await $.store.set('stats', all)
    }

    return next(e)
  })

  on('ui.close', async ($, e, next) => {
    // Closed by the person: stays closed this session, the chat keeps one line.
    if (e.id === PANE && e.origin.kind === 'person') await update($, isPaneDismissed, () => true)

    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const view = viewOf(await read($, rows), await read($, stats), await nowOf($))
    // While the panel shows, the chat stays clean.
    if (view.live.length === 0 || (await isPaneShown($))) {
      noteRender(`band:${e.surface}`, view.live.length === 0 ? 'passed: nothing live' : 'passed: pane shown')

      return next(e)
    }
    const isOpen = await read($, isBandExpanded)
    noteRender(`band:${e.surface}`, `drew ${isOpen ? 'list' : 'line'} (${view.live.length} live)`)
    const first = view.live.find(i => i.id !== MAIN) ?? view.live[0]
    const lead = first === undefined ? '' : `${first.name}${first.ratio === null ? '' : ` ${pct(first)}`}`
    const toggle = () => update($, isBandExpanded, v => !v)
    const room = Math.max(1, e.props.maxRows - 2)
    const shown = view.live.slice(0, room)
    const more = view.live.length - shown.length
    const nameWidth = Math.max(16, Math.min(26, Math.floor(e.props.bodyColumns / 4)))

    if (e.surface === 'terminal') {
      const { Box, Text, Button } = $.ui.resolve(e)
      const barWidth = e.props.bodyColumns >= 100 ? 14 : 8

      return (
        <Box flexDirection="column">
          <Box flexDirection="row" gap={1}>
            <Text color="claude">●</Text>
            {/* Grows to the edge, so the arrow keeps its place at the far right. */}
            <Box flexGrow={1} flexShrink={1}>
              <Text wrap="truncate-end">
                {liveSummary(view.live)}
                <Text dimColor>{!isOpen && lead ? `  ·  ${lead}` : ''}</Text>
              </Text>
            </Box>
            <Button key="more" plain label={isOpen ? '▴' : '▾'} onPress={toggle} />
          </Box>
          {isOpen &&
            shown.map(i => (
              <Text key={i.id} wrap="truncate-end">
                {'  '.repeat(i.depth)}
                <Text color={THEME[i.status]}>{ICON[i.status]}</Text>{' '}
                {/* The indent counts inside the name's width: the next columns line up. */}
                {i.name.slice(0, nameWidth - i.depth * 2).padEnd(nameWidth - i.depth * 2)}{' '}
                <Text dimColor>{i.kind.padEnd(8)}</Text>
                {i.ratio === null ? ' '.repeat(barWidth + 6) : (
                  <Text>
                    <Text color={THEME[i.status]}>{textBar(i.ratio, barWidth, i.isEstimate)}</Text> {pct(i).padStart(4)}{' '}
                  </Text>
                )}
                <Text dimColor>
                  {i.elapsed.padStart(6)}  {i.step ?? i.action ?? ''}
                </Text>
              </Text>
            ))}
          {isOpen && more > 0 && <Text dimColor>  +{more} (/agentes)</Text>}
        </Box>
      )
    }

    const { Box, Text, Button, Svg } = $.ui.resolve(e)

    return (
      <Box flexDirection="column" gap={isOpen ? 1 : 0}>
        <Box flexDirection="row" gap={1} alignItems="center">
          <Text color="claude">●</Text>
          {/* Grows to the edge, so the arrow keeps its place at the far right. */}
          <Box flexGrow={1} flexShrink={1}>
            <Text wrap="truncate-end">
              {liveSummary(view.live)}
              <Text dimColor>{!isOpen && lead ? `  ·  ${lead}` : ''}</Text>
            </Text>
          </Box>
          <Button key="more" plain label={isOpen ? '▴' : '▾'} onPress={toggle} />
        </Box>
        {isOpen &&
          shown.map(i => (
            // Fixed columns that never shrink, the indent inside the name's: every bar starts at one place.
            <Box key={i.id} flexDirection="row" gap={2} alignItems="center">
              <Box width={nameWidth} flexShrink={0} paddingLeft={1 + i.depth * 2} flexDirection="row" gap={1}>
                <Text color={THEME[i.status]}>{ICON[i.status]}</Text>
                <Text bold wrap="truncate-end">
                  {i.name}
                </Text>
              </Box>
              <Box width={8} flexShrink={0}>
                <Text dimColor>{i.kind}</Text>
              </Box>
              <Box width={14} flexShrink={0} flexDirection="row" alignItems="center">
                {i.ratio !== null && (
                  <Svg
                    source={svgBar({ ratio: i.ratio, isEstimate: i.isEstimate }, i.status)}
                    alt={pct(i)}
                    width={110}
                    height={8}
                  />
                )}
              </Box>
              <Box width={5} flexShrink={0} justifyContent="flex-end">
                <Text>{i.ratio === null ? '' : pct(i)}</Text>
              </Box>
              <Box width={6} flexShrink={0} justifyContent="flex-end">
                <Text dimColor>{i.elapsed}</Text>
              </Box>
              <Box flexGrow={1} flexShrink={1}>
                <Text dimColor wrap="truncate-end">
                  {i.step ?? i.action ?? ''}
                </Text>
              </Box>
            </Box>
          ))}
        {isOpen && more > 0 && <Text dimColor>+{more} (/agentes)</Text>}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const view = viewOf(await read($, rows), await read($, stats), await nowOf($))
    noteRender(`pane:${e.surface}`, `drew ${view.live.length} live, ${view.done.length} done (${e.props.placement})`)
    const cols = Math.max(24, e.props.bodyColumns)
    const barWidth = Math.max(8, Math.min(24, cols - 14))

    const clear = () =>
      update($, rows, current => {
        const out: Record<string, AgentRow> = {}
        for (const [id, row] of Object.entries(current)) if (isLive(row.status)) out[id] = row

        return out
      })

    if (e.surface === 'terminal') {
      const { Box, Text, Button } = $.ui.resolve(e)
      const bar = (i: Item) => (
        <Text>
          <Text color={THEME[i.status]}>{textBar(i.ratio ?? 0, barWidth, i.isEstimate)}</Text>
          {` ${i.isEstimate ? '≈' : ''}${Math.round((i.ratio ?? 0) * 100)}%`}
        </Text>
      )
      const card = (i: Item) => (
        <Box key={i.id} flexDirection="column" marginLeft={i.depth * 2} marginBottom={1}>
          <Box flexDirection="row" justifyContent="space-between">
            <Text wrap="truncate-end">
              <Text color={THEME[i.status]}>{ICON[i.status]}</Text> <Text bold>{i.name}</Text>
            </Text>
            <Text dimColor>
              {i.kind} · {i.elapsed}
            </Text>
          </Box>
          {i.ratio !== null && bar(i)}
          {i.step && <Text wrap="truncate-end">{i.step}</Text>}
          {i.action && (
            <Text dimColor wrap="truncate-end">
              {i.action}
            </Text>
          )}
        </Box>
      )

      return (
        <Box flexDirection="column">
          <Text dimColor>{liveSummary(view.live)}</Text>
          <Text> </Text>
          {view.live.map(card)}
          {view.done.length > 0 && (
            <Box flexDirection="column">
              <Box flexDirection="row" gap={1}>
                <Text dimColor bold>
                  Concluídos
                </Text>
                <Button key="clear" plain label="✕" onPress={clear} />
              </Box>
              {view.done.map(i => (
                <Text key={i.id} dimColor wrap="truncate-end">
                  <Text color={THEME[i.status]}>{ICON[i.status]}</Text> {i.name} · {i.kind} · {i.elapsed}
                </Text>
              ))}
            </Box>
          )}
        </Box>
      )
    }

    const { Box, Text, Button, Svg } = $.ui.resolve(e)
    const card = (i: Item) => (
      <Box key={i.id} flexDirection="column" marginLeft={i.depth * 2} marginBottom={1}>
        <Box flexDirection="row" justifyContent="space-between" gap={1}>
          <Text wrap="truncate-end">
            <Text color={THEME[i.status]}>{ICON[i.status]}</Text> <Text bold>{i.name}</Text>
          </Text>
          <Text dimColor>
            {i.kind} · {i.elapsed}
          </Text>
        </Box>
        {i.ratio !== null && (
          <Box flexDirection="row" gap={1} alignItems="center">
            <Svg
              source={svgBar({ ratio: i.ratio, isEstimate: i.isEstimate }, i.status)}
              alt={`${Math.round(i.ratio * 100)}%${i.isEstimate ? ' estimado' : ''}`}
              width={160}
              height={8}
            />
            <Text>{`${i.isEstimate ? '≈' : ''}${Math.round(i.ratio * 100)}%`}</Text>
          </Box>
        )}
        {i.step && <Text wrap="truncate-end">{i.step}</Text>}
        {i.action && (
          <Text dimColor wrap="truncate-end">
            {i.action}
          </Text>
        )}
      </Box>
    )

    return (
      <Box flexDirection="column">
        <Text dimColor>{liveSummary(view.live)}</Text>
        <Text> </Text>
        {view.live.map(card)}
        {view.done.length > 0 && (
          <Box flexDirection="column">
            <Box flexDirection="row" gap={1}>
              <Text dimColor bold>
                Concluídos
              </Text>
              <Button key="clear" plain label="✕" onPress={clear} />
            </Box>
            {view.done.map(i => (
              <Text key={i.id} dimColor wrap="truncate-end">
                <Text color={THEME[i.status]}>{ICON[i.status]}</Text> {i.name} · {i.kind} · {i.elapsed}
              </Text>
            ))}
          </Box>
        )}
      </Box>
    )
  })
}
