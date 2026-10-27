import { expect, mock, test } from 'claude-code/testing'

import type { AgentRow } from '../types'
import {
  checklistRatio,
  estimateRatio,
  foldStats,
  kindLabel,
  shortLabel,
  lastLine,
  logTargets,
  parseOutputProgress,
  polledLogs,
  progressOf,
  stepsFromList,
  textBar,
} from '../hooks/model'

const BAND = {
  hasSurvey: false,
  isWorking: true,
  maxRows: 10,
  bodyColumns: 120,
  scroll: { offset: 0, bodyRows: 10 },
  view: {},
}

function agent(over: Partial<AgentRow>): AgentRow {
  return {
    id: 'a1',
    label: 'Pesquisa',
    type: 'Explore',
    status: 'running',
    startedAt: 0,
    tools: 0,
    steps: [],
    isWorkflow: false,
    ...over,
  }
}

test('a checklist is real progress, in-progress steps count half', () => {
  const steps = stepsFromList(['a', 'b', 'c', 'd'], 2)
  expect(steps.map(s => s.status)).toEqual(['completed', 'completed', 'in_progress', 'pending'])
  expect(checklistRatio(steps)).toBe(2.5 / 4)
  expect(progressOf(agent({ steps }), {}, 0)).toEqual({ ratio: 2.5 / 4, isEstimate: false })
})

test('the estimate rises with tool calls and never reaches 100%', () => {
  const few = estimateRatio(agent({ tools: 3 }), undefined, 0)
  const usual = estimateRatio(agent({ tools: 18 }), undefined, 0)
  const many = estimateRatio(agent({ tools: 500 }), undefined, 0)
  expect(few < usual).toBe(true)
  expect(usual > 0.75 && usual < 0.9).toBe(true)
  expect(many < 0.96).toBe(true)
  expect(progressOf(agent({ tools: 3 }), {}, 0)?.isEstimate).toBe(true)
})

test('history replaces the default and the main loop gets no guess', () => {
  const stats = { Explore: foldStats(undefined, 6, 60_000) }
  const withHistory = estimateRatio(agent({ tools: 6 }), stats.Explore, 0)
  expect(withHistory > 0.8).toBe(true)
  expect(progressOf(agent({ id: 'main', type: 'main', tools: 9 }), stats, 0)).toBe(null)
  expect(progressOf(agent({ status: 'completed' }), stats, 0)).toEqual({ ratio: 1, isEstimate: false })
})

test('text bars mark estimates with a different glyph', () => {
  expect(textBar(0.5, 10, false)).toBe('█████░░░░░')
  expect(textBar(0.5, 10, true)).toBe('▒▒▒▒▒░░░░░')
})

test('progress printed by a program is read from the end of its output', () => {
  expect(parseOutputProgress('Rendered 13912/16638, time remaining: 6m 57s\nRendered 13914/16638')).toBe(13914 / 16638)
  expect(parseOutputProgress('step 1/2 done\n45%')).toBe(0.45)
  expect(parseOutputProgress('page 1/2')).toBeUndefined()
  expect(parseOutputProgress('nothing here')).toBeUndefined()
  expect(lastLine('Encoded 16638/16638\n\u001b[34m○ out/ep1_raw.mp4\u001b[39m 1.2 GB\n')).toBe('○ out/ep1_raw.mp4 1.2 GB')
})

const RENDER =
  'cd /c/Users/x/Videos/proj && rm -rf work/b && npx remotion render src/index.ts Reveal out/raw.mp4 > work/render_v3.log 2>&1 && python tools/master.py out/raw.mp4 out/ep1.mp4 > work/master_v3.log 2>&1 && ffmpeg -i out/ep1.mp4 -f mp4 NUL; cat work/master_v3.log'

test('a command tells where its logs go, and a check tells which log it reads', () => {
  expect(logTargets(RENDER, 'C:/elsewhere')).toEqual([
    'C:/Users/x/Videos/proj/work/render_v3.log',
    'C:/Users/x/Videos/proj/work/master_v3.log',
  ])
  expect(logTargets('python - <<EOF\nif a > b: pass\nEOF', 'C:/p')).toEqual([])
  expect(logTargets('npm run build | tee build.log', 'C:\\p')).toEqual(['C:/p/build.log'])
  expect(
    polledLogs("cd /c/Users/x/Videos/proj && tail -c 400 work/render_v3.log | tr '\r' '\n' | tail -3", 'C:/p'),
  ).toEqual(['C:/Users/x/Videos/proj/work/render_v3.log'])
  expect(polledLogs('ls -la work', 'C:/p')).toEqual([])
})

const PANE = {
  title: 'Agentes',
  isFocused: false,
  bodyColumns: 48,
  placement: 'dock' as const,
  scroll: { offset: 0, bodyRows: 30 },
  view: {},
}

function shellAnswer(withProgress: boolean) {
  return (_: unknown, e: { run_in_background?: boolean }) =>
    e.run_in_background
      ? {
          result: { stdout: '', stderr: '', interrupted: false, backgroundTaskId: 'b1' },
          text: 'Command running in background with ID: b1. Output is being written to: C:\\tmp\\b1.output.',
        }
      : {
          result: { stdout: withProgress ? 'Rendered 50/100' : 'ok', stderr: '', interrupted: false },
          text: withProgress ? 'Rendered 50/100' : 'ok',
        }
}

test('names are short and kinds read in a word', () => {
  expect(shortLabel('Render, master, contact sheet and phone copy of episode 1')).toBe('Render, master, contact sheet…')
  expect(shortLabel('mapa do emulador no KB')).toBe('Mapa do emulador no KB')
  expect(kindLabel(agent({ type: 'Explore' }))).toBe('busca')
  expect(kindLabel(agent({ type: 'shell' }))).toBe('comando')
  expect(kindLabel(agent({ type: 'my-plugin:reviewer' }))).toBe('reviewer')
})

test('the panel shows a checklist as a bar and the step in words', async ($, on) => {
  mock.clock(on)
  const answered = await $.tool.call({
    tool: 'mcp__agent-progress__progress',
    steps: ['Ler o código', 'Escrever o mod', 'Testar'],
    done: 1,
  })
  // A plugin tool's result must be text: an object fails the call in a live session.
  expect(typeof answered.result).toBe('string')
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'agent-progress', surface, component: 'Pane', requestId: 'agentes', props: PANE })
    expect(await ui.find({ text: /Conversa principal/ })).toBeDefined()
    expect(await ui.find({ text: /50%/ })).toBeDefined()
    expect(await ui.find({ text: /etapa 2 de 3: Escrever o mod/ })).toBeDefined()
    if (surface === 'desktop') expect(await ui.find({ type: 'Svg' })).toBeDefined()
    await ui.unmount()
  }
})

test('work with no number to show draws no bar, only what it is doing', async ($, on) => {
  mock.clock(on)
  on('tool.call', { tool: 'Bash' }, shellAnswer(false))
  await $.tool.call({ tool: 'Bash', command: 'npm run dev', description: 'Servidor de desenvolvimento', run_in_background: true })
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'agent-progress', surface, component: 'Pane', requestId: 'agentes', props: PANE })
    expect(await ui.find({ text: /Servidor de desenvolvimento/ })).toBeDefined()
    expect(await ui.find({ text: /comando/ })).toBeDefined()
    expect(await ui.find({ text: /%/ })).toBeUndefined()
    if (surface === 'desktop') expect(await ui.find({ type: 'Svg' })).toBeUndefined()
    await ui.unmount()
  }
})

test('the chat keeps one line with the way to the panel', async ($, on) => {
  mock.clock(on)
  on('tool.call', { tool: 'Bash' }, shellAnswer(true))
  await $.tool.call({ tool: 'Bash', command: 'render.sh', description: 'Renderizar o vídeo', run_in_background: true })
  await $.tool.call({ tool: 'Bash', command: 'tail -1 render.log' })
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'agent-progress', surface, component: 'AbovePrompt', props: BAND })
    expect(await ui.find({ text: /1 em background/ })).toBeDefined()
    expect(await ui.find({ text: /Renderizar o vídeo 50%/ })).toBeDefined()
    expect(await ui.find({ key: 'open' })).toBeDefined()
    await ui.unmount()
  }
})

test('a background task finishes when the session no longer lists it', async ($, on) => {
  mock.clock(on)
  on('classic.Stop', () => ({}))
  on('tool.call', { tool: 'Bash' }, shellAnswer(true))
  await $.tool.call({ tool: 'Bash', command: 'render.sh', description: 'Renderizar o vídeo', run_in_background: true })
  await $.classic.Stop({ stop_hook_active: false, background_tasks: [] })
  const ui = await $.ui.mount({ plugin: 'agent-progress', surface: 'terminal', component: 'Pane', requestId: 'agentes', props: PANE })
  expect(await ui.find({ text: /Concluídos/ })).toBeDefined()
  expect(await ui.find({ text: /✓ Renderizar o vídeo/ })).toBeDefined()
  await ui.unmount()
})

test('the panel follows the log a background command writes, without the agent checking', async ($, on) => {
  const clock = mock.clock(on)
  on('session.cwd', () => ({ value: 'C:/p' }))
  on('tool.call', { tool: 'Bash' }, shellAnswer(false))
  on('fs.stat', (_, e) =>
    e.path.endsWith('render_v3.log')
      ? { value: { kind: 'file', size: 900, mtimeMs: 2, isLink: false } }
      : { value: { kind: 'file', size: 0, mtimeMs: 1, isLink: false } },
  )
  on('fs.read', () => ({ value: 'Rendered 100/400\rRendered 300/400, time remaining: 1m' }))
  await $.tool.call({ tool: 'Bash', command: RENDER, description: 'Render', run_in_background: true })
  await clock.advance(5000)
  const ui = await $.ui.mount({ plugin: 'agent-progress', surface: 'terminal', component: 'Pane', requestId: 'agentes', props: PANE })
  expect(await ui.find({ text: /75%/ })).toBeDefined()
  expect(await ui.find({ text: /time remaining/ })).toBeDefined()
  await ui.unmount()
})

test('Agent and background shells are asked for names that fit the app task list', async ($, on) => {
  on('tool.describe', (_, e) => ({ description: `base ${e.tool}` }))
  const provider = { plugin: 'engine', tier: 'core' } as const
  const agent = await $.tool.describe({ tool: 'Agent', description: 'base Agent', provider })
  const bash = await $.tool.describe({ tool: 'Bash', description: 'base Bash', provider })
  const read = await $.tool.describe({ tool: 'Read', description: 'base Read', provider })
  expect(agent.description).toContain('16 characters at most')
  expect(bash.description).toContain('run_in_background')
  expect(read.description).toBe('base Read')
})

test('paths built from variables the command sets are read', () => {
  expect(logTargets('SP=/tmp/s/pad; for i in 1 2; do echo $i; done > $SP/render.log 2>&1', 'C:/p')).toEqual([
    '/tmp/s/pad/render.log',
  ])
  expect(polledLogs('D="C:/work"; tail -1 "${D}/build.log"', 'C:/p')).toEqual(['C:/work/build.log'])
  expect(logTargets('npm run build > $OUT/x.log', 'C:/p')).toEqual(['C:/p/$OUT/x.log'])
})
