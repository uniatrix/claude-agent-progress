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
  mapListStatus,
  percent,
  progressOf,
  stepsFromList,
  textBar,
  treeOrder,
  withDone,
} from './model'
import type { Progress } from './model'

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
const isBandHidden = atom({ plugin: 'agent-progress', key: 'isBandHidden' } as const, false)
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

const STEP_ICON: Record<Step['status'], string> = {
  completed: '✓',
  in_progress: '◐',
  pending: '○',
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

function stepNow(row: AgentRow): string | undefined {
  const running = row.steps.find(s => s.status === 'in_progress')

  return running?.subject
}

function summary(all: Record<string, AgentRow>): string {
  const c = countRows(all)
  const parts = [
    c.running > 0 ? `${c.running} rodando` : '',
    c.waiting > 0 ? `${c.waiting} aguardando` : '',
    c.done > 0 ? `${c.done} concluído${c.done > 1 ? 's' : ''}` : '',
    c.failed > 0 ? `${c.failed} com falha` : '',
  ].filter(Boolean)

  return parts.length > 0 ? parts.join(' · ') : 'nenhum agente'
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

let ticks = 0

/** Debug only: what each site last drew, read by the `snapshot` tool. */
const renders: Record<string, { count: number; last: string }> = {}

function noteRender(site: string, outcome: string): void {
  const seen = renders[site] ?? { count: 0, last: '' }
  renders[site] = { count: seen.count + 1, last: outcome }
}

async function tick($: Engine): Promise<void> {
  ticks += 1
  const t = await $.clock.now()
  const all = await read($, rows)
  const isActive = Object.values(all).some(
    r => isLive(r.status) || (r.endedAt !== undefined && t - r.endedAt < LINGER_MS + 2000),
  )
  if (isActive) await update($, now, () => t)
  if (isActive || ticks % 10 === 0) await syncList($, t)
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
    $.clock.every(1000, () => void tick($))

    return next(e)
  })

  on('command.run', { command: 'agentes' }, async $ => {
    await update($, isBandHidden, () => false)
    const opened = await $.ui.open({ id: PANE, title: 'Agentes' })

    return {
      text: opened.isPlaced
        ? 'Painel de agentes aberto.'
        : `Painel de agentes aguardando espaço na tela: ${opened.reason}`,
    }
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
        isBandHidden: await read($, isBandHidden),
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
    if (ran.deny !== undefined || ran.isError) return ran

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

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || (await read($, isBandHidden))) {
      noteRender(`band:${e.surface}`, e.props.hasSurvey ? 'passed: survey' : 'passed: hidden')

      return next(e)
    }
    const all = await read($, rows)
    const t = Math.max(await read($, now), ...Object.values(all).map(r => r.startedAt))
    const known = await read($, stats)
    const hasAgents = Object.values(all).some(r => r.id !== MAIN && isLive(r.status))
    const shown = treeOrder(all).filter(({ row }) =>
      row.id === MAIN
        ? row.status === 'running' && (row.steps.length > 0 || hasAgents)
        : isLive(row.status) || (row.endedAt !== undefined && t - row.endedAt < LINGER_MS),
    )
    if (shown.length === 0) {
      noteRender(`band:${e.surface}`, 'passed: nothing live')

      return next(e)
    }
    noteRender(`band:${e.surface}`, `drew ${shown.length} rows (${e.props.bodyColumns} cols, ${e.props.maxRows} rows)`)

    const room = Math.max(1, e.props.maxRows - 1)
    const visible = shown.slice(0, room)
    const hidden = shown.length - visible.length
    const cols = e.props.bodyColumns
    const barWidth = cols >= 110 ? 16 : 10
    const labelWidth = cols >= 110 ? 28 : 18

    if (e.surface === 'terminal') {
      const { Box, Text, Button } = $.ui.resolve(e)

      return (
        <Box flexDirection="column">
          <Box flexDirection="row" gap={1}>
            <Text bold>Agentes</Text>
            <Text dimColor>{summary(all)}</Text>
            <Button key="open" plain label="detalhes" onPress={() => $.ui.open({ id: PANE, title: 'Agentes' })} />
            <Button key="hide" plain label="ocultar" onPress={() => update($, isBandHidden, () => true)} />
          </Box>
          {visible.map(({ row, depth }) => {
            const p = progressOf(row, known, t)
            const label = `${'  '.repeat(depth)}${clip(row.label, labelWidth - depth * 2)}`.padEnd(labelWidth)
            const bar = p === null ? '·'.repeat(barWidth) : textBar(p.ratio, barWidth, p.isEstimate)
            const elapsed = duration((row.endedAt ?? t) - row.startedAt).padStart(6)
            const step = stepNow(row)
            const detail = [step, row.current].filter(Boolean).join(' · ')

            return (
              <Text key={row.id} wrap="truncate-end">
                <Text color={THEME[row.status]}>{ICON[row.status]}</Text> {label}{' '}
                <Text color={THEME[row.status]}>{bar}</Text> {percent(p)} <Text dimColor>{elapsed}  {detail}</Text>
              </Text>
            )
          })}
          {hidden > 0 && <Text dimColor>+{hidden} (veja /agentes)</Text>}
        </Box>
      )
    }

    const { Box, Text, Button, Svg } = $.ui.resolve(e)

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" gap={1}>
          <Text bold>Agentes</Text>
          <Text dimColor>{summary(all)}</Text>
          <Button key="open" plain label="detalhes" onPress={() => $.ui.open({ id: PANE, title: 'Agentes' })} />
          <Button key="hide" plain label="ocultar" onPress={() => update($, isBandHidden, () => true)} />
        </Box>
        {visible.map(({ row, depth }) => {
          const p = progressOf(row, known, t)
          const step = stepNow(row)
          const detail = [step, row.current].filter(Boolean).join(' · ')

          return (
            <Box key={row.id} flexDirection="row" gap={1} alignItems="center" marginLeft={depth * 2}>
              <Text color={THEME[row.status]}>{ICON[row.status]}</Text>
              <Text wrap="truncate-end">{clip(row.label, 40)}</Text>
              <Svg
                source={svgBar(p, row.status)}
                alt={p === null ? 'sem checklist' : `${Math.round(p.ratio * 100)}%${p.isEstimate ? ' estimado' : ''}`}
                width={120}
                height={8}
              />
              <Text>{percent(p).trim()}</Text>
              <Text dimColor>{duration((row.endedAt ?? t) - row.startedAt)}</Text>
              <Text dimColor wrap="truncate-end">{detail}</Text>
            </Box>
          )
        })}
        {hidden > 0 && <Text dimColor>+{hidden} (veja /agentes)</Text>}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const all = await read($, rows)
    const t = Math.max(await read($, now), ...Object.values(all).map(r => r.startedAt))
    const known = await read($, stats)
    const list = treeOrder(all)
    noteRender(`pane:${e.surface}`, `drew ${list.length} rows (${e.props.placement})`)
    const { Box, Text, Button } = $.ui.resolve(e)
    const barWidth = Math.max(8, Math.min(20, e.props.bodyColumns - 40))

    const clear = () =>
      update($, rows, current => {
        const out: Record<string, AgentRow> = {}
        for (const [id, row] of Object.entries(current)) if (isLive(row.status)) out[id] = row

        return out
      })

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" gap={1}>
          <Text dimColor>{summary(all)}</Text>
          <Button key="clear" plain label="limpar concluídos" onPress={clear} />
        </Box>
        {list.length === 0 && <Text dimColor>Nenhum agente nesta sessão ainda.</Text>}
        {list.map(({ row, depth }) => {
          const p = progressOf(row, known, t)
          const pad = '  '.repeat(depth)
          const bar = p === null ? '·'.repeat(barWidth) : textBar(p.ratio, barWidth, p.isEstimate)
          const seen = known[row.type]
          const basis =
            p === null
              ? 'sem checklist'
              : p.isEstimate
                ? seen && seen.runs > 0
                  ? `estimado: ${row.tools} de ~${Math.round(seen.tools)} ferramentas (${seen.runs} execuções de ${row.type})`
                  : `estimado: ${row.tools} ferramentas, sem histórico de ${row.type}`
                : row.steps.length > 0
                  ? `checklist ${row.steps.filter(s => s.status === 'completed').length}/${row.steps.length}`
                  : ''

          return (
            <Box key={row.id} flexDirection="column" marginTop={depth === 0 ? 1 : 0}>
              <Text wrap="truncate-end">
                {pad}
                <Text color={THEME[row.status]}>{ICON[row.status]}</Text> <Text bold>{row.label}</Text>{' '}
                <Text dimColor>({row.type})</Text>
              </Text>
              <Text wrap="truncate-end">
                {pad}  <Text color={THEME[row.status]}>{bar}</Text> {percent(p)}{' '}
                <Text dimColor>
                  {duration((row.endedAt ?? t) - row.startedAt)} · {basis}
                </Text>
              </Text>
              {row.current && isLive(row.status) && (
                <Text dimColor wrap="truncate-end">
                  {pad}  {row.current}
                </Text>
              )}
              {row.steps.map(s => (
                <Text key={`${row.id}:${s.id}`} wrap="truncate-end" dimColor={s.status === 'completed'}>
                  {pad}    {STEP_ICON[s.status]} {s.subject}
                </Text>
              ))}
            </Box>
          )
        })}
      </Box>
    )
  })
}
