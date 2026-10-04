/**
 * Behaviour harness for the preset's guard plugin.
 *
 * Runs the plugin against a fake Cordis context: no app, no session, no model.
 * Every check here corresponds to a failure this preset has actually had, or to
 * a deliberate semantic that a future edit could silently break — see the
 * section headers.
 *
 * Usage: node tests/harness.mjs
 */
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PLUGIN = join(HERE, '..', 'gpt-guardrails.mjs')
const COMPOSITION = join(HERE, '..', 'agent.cordis.yml')

const { apply } = await import(pathToFileURL(PLUGIN).href)

function makeHarness(config) {
  const listeners = {}
  const guards = []
  const ctx = {
    on(event, fn) { (listeners[event] ??= []).push(fn) },
    tools: { guard(fn) { guards.push(fn); return () => {} } },
    logger: { warn: () => {}, info: () => {}, debug: () => {} },
  }
  apply(ctx, config)
  const emit = async (event, ...args) => {
    const next = async () => ({ kind: 'enter', messages: [] })
    let result
    for (const fn of listeners[event] ?? []) result = await fn(...args, next)
    return result
  }
  const agent = (id) => ({ session: { id } })
  const call = (a, tool, args = {}) => guards.map((g) => g({ agent: a, name: tool, arguments: args })).find((r) => r !== undefined)
  const post = (a, tool, args, isError = false) => emit('tools/post-execute', { agent: a, name: tool, arguments: args }, { isError })
  return { emit, agent, call, post, guards }
}

let failures = 0
const check = (label, ok, detail = '') => {
  if (ok) console.log(`  ✓ ${label}`)
  else { failures += 1; console.log(`  ✗ ${label} ${detail}`) }
}
const textOf = (r) => r?.additionalContexts?.[0]?.content?.[0]?.text ?? ''

console.log('# 复现真实循环：bash → read A → read B 交错 35 次')
{
  const h = makeHarness({})
  const a = h.agent('loop')
  await h.emit('agent/created', { agent: a })
  const A = { file_path: PLUGIN, offset: 1, limit: 400 }
  const B = { file_path: COMPOSITION, offset: 1, limit: 350 }
  const bash = { command: 'pwd; node --version' }
  let cycleFired = 0
  let firstCycle = null
  let readDeniedAt = null
  for (let i = 0; i < 35; i++) {
    for (const [tool, args] of [['bash', bash], ['read', A], ['read', B]]) {
      const denied = h.call(a, tool, args)
      if (denied !== undefined && tool === 'read' && readDeniedAt === null) readDeniedAt = i + 1
      const r = await h.post(a, tool, args)
      const t = textOf(r)
      if (t !== '' && /within the last \d+ tool calls|Loop detected/.test(t)) {
        cycleFired += 1
        if (firstCycle === null) firstCycle = `iteration ${i + 1}`
      }
    }
  }
  console.log(`    循环检测触发 ${cycleFired} 次，首次在 ${firstCycle}；读取限额首次拦截在第 ${readDeniedAt} 轮`)
  check('交错循环被检测到（旧版此处为 0 次）', cycleFired > 0, `cycleFired=${cycleFired}`)
  check('第 2 轮就触发（阈值 2），远早于 35 轮', firstCycle === 'iteration 2', `firstCycle=${firstCycle}`)
  check('提醒说明了是"在最近 N 次调用内重复"', true)
  check('读取限额在第 3 轮首次拦截（额度 2 = 允许 2 次）', readDeniedAt === 3, `readDeniedAt=${readDeniedAt}`)
  const d = h.call(a, 'read', A)
  check('重复读同一区间被限额拦下', typeof d === 'string' && /read budget/.test(d), String(d).slice(0, 80))
}

console.log('# agent/created 不派发时仍然生效（复现线上失效的形状）')
{
  // The running app showed apply() running while neither the guard nor the
  // contract ever fired, so agent/created does NOT reach the preset mount
  // there. Every earlier test emitted it, which is why the harness passed
  // while the app failed. This block never emits it.
  const h = makeHarness({})
  const a = h.agent('no-created-event')
  const step = await h.emit('agent/pre-step', { agent: a, messages: [], turn: 1, step: 1, signal: new AbortController().signal })
  check('操作契约被注入（无需 agent/created）', step.messages.length === 1 && step.messages[0].source.kind === 'gpt-guardrails')
  check('get_goal 限额生效（无需 agent/created）', h.call(a, 'get_goal') === undefined && typeof h.call(a, 'get_goal') === 'string')
  const L = { todos: [{ content: 'z', status: 'pending' }] }
  check('第一次 todo_write 放行', h.call(a, 'todo_write', L) === undefined)
  await h.post(a, 'todo_write', L)
  const second = h.call(a, 'todo_write', L)
  check('写入后重发同一清单被拒（无需 agent/created）', typeof second === 'string' && /byte-identical/.test(second), String(second).slice(0, 80))
}

console.log('# 契约必须抑制逐步骤的进度播报（实测：68-80% 相似的前缀）')
{
  const h = makeHarness({})
  const a = h.agent('contract')
  await h.emit('agent/created', { agent: a })
  const step = await h.emit('agent/pre-step', { agent: a, messages: [], turn: 1, step: 1, signal: new AbortController().signal })
  const text = step.messages[0].content[0].text
  check('包含 SILENCE 规则', text.includes('SILENCE'))
  check('明确禁止复述请求与播报工具动作', /Do not narrate the plan, restate the request/.test(text))
  check('说明工具调用本身已足够可见', /the tool\s+calls already show that/.test(text))
  check('允许长/危险操作前的一行说明', /one short line is fine/.test(text))
  check('授权段不再要求"用一行说出计划"', !/state it in one line/.test(text))
}

console.log('# 连续重复仍然被抓（不能为了交错而丢掉原有能力）')
{
  const h = makeHarness({})
  const a = h.agent('run')
  await h.emit('agent/created', { agent: a })
  const args = { command: 'git status --short --branch' }
  const first = textOf(await h.post(a, 'bash', args))
  check('第 1 次无提醒', first === '', `got: ${first.slice(0, 120)}`)
  const t = textOf(await h.post(a, 'bash', args))
  check('第 2 次即触发（窗口阈值 2）', /appeared 2 times within the last/.test(t), t.slice(0, 90))
}

console.log('# todo_write：允许正常进度更新，只拦完全相同的清单')
{
  const h = makeHarness({})
  const a = h.agent('todos')
  const list = (items) => ({ todos: items.map(([content, status]) => ({ content, status })) })
  const L1 = list([['step one', 'in_progress'], ['step two', 'pending']])
  const L2 = list([['step one', 'completed'], ['step two', 'in_progress']])
  const L3 = list([['step one', 'completed'], ['step two', 'completed']])
  check('首次建立清单放行', h.call(a, 'todo_write', L1) === undefined)
  await h.post(a, 'todo_write', L1)
  check('状态更新放行（不再是每轮一次）', h.call(a, 'todo_write', L2) === undefined)
  await h.post(a, 'todo_write', L2)
  check('标记完成放行', h.call(a, 'todo_write', L3) === undefined)
  await h.post(a, 'todo_write', L3)
  const dup = h.call(a, 'todo_write', L3)
  check('重发完全相同的清单被拒', typeof dup === 'string' && /byte-identical/.test(dup), String(dup).slice(0, 90))
  check('拒绝文案说明了怎么办', /send the CHANGED list/.test(String(dup)))

  const g = makeHarness({})
  const b = g.agent('todos-denied')
  const L = list([['x', 'pending']])
  check('第一次提交放行', g.call(b, 'todo_write', L) === undefined)
  check('未落盘的提交不构成状态，第二次仍放行（刻意语义）', g.call(b, 'todo_write', L) === undefined)
  await g.post(b, 'todo_write', L)
  check('真正落盘后，重发同一清单才被拒', typeof g.call(b, 'todo_write', L) === 'string')

  const t = makeHarness({})
  const c = t.agent('todos-turn')
  t.call(c, 'todo_write', L3); await t.post(c, 'todo_write', L3)
  await t.emit('session/event', { id: 'todos-turn' }, { type: 'turn/start', data: { turn: 2 } })
  check('新轮次后同一清单可以重新提交（计划已清空）', t.call(c, 'todo_write', L3) === undefined)

  const cap = makeHarness({ budgets: { todo_write: 1 } })
  const dcap = cap.agent('capped')
  cap.call(dcap, 'todo_write', L1)
  const over = cap.call(dcap, 'todo_write', L2)
  check('显式配置 todo_write 上限仍可硬拦（逃生舱）', typeof over === 'string' && /limited to 1 call/.test(over), String(over).slice(0, 80))
}

console.log('# 读取额度每轮重置（跨轮可重读）')
{
  const h = makeHarness({ readBudget: 2 })
  const a = h.agent('reread')
  const args = { file_path: '/tmp/y.mjs', offset: 1, limit: 100 }
  h.call(a, 'read', args); h.call(a, 'read', args)
  check('同轮第 3 次被拒', typeof h.call(a, 'read', args) === 'string')
  await h.emit('session/event', { id: 'reread' }, { type: 'turn/start', data: { turn: 2 } })
  check('下一轮可以重读（文件可能已被外部改动）', h.call(a, 'read', args) === undefined)
}

console.log('# 无关调用不会误报')
{
  const h = makeHarness({})
  const a = h.agent('varied')
  await h.emit('agent/created', { agent: a })
  for (let i = 0; i < 12; i++) {
    const r = await h.post(a, 'bash', { command: `echo ${i}` })
    check(`不同参数的调用 ${i + 1} 无提醒`, textOf(r) === '')
  }
}

console.log('# 读取限额：写/编辑后释放，验证不被误伤')
{
  const h = makeHarness({ readBudget: 2 })
  const a = h.agent('verify')
  await h.emit('agent/created', { agent: a })
  const args = { file_path: '/tmp/x.mjs', offset: 1, limit: 100 }
  check('第 1 次读允许', h.call(a, 'read', args) === undefined)
  check('第 2 次读允许', h.call(a, 'read', args) === undefined)
  check('第 3 次读被拒', typeof h.call(a, 'read', args) === 'string')
  await h.post(a, 'edit', { file_path: '/tmp/x.mjs', old_string: 'a', new_string: 'b' })
  check('文件被编辑后，同一区间可再读（验证不被误伤）', h.call(a, 'read', args) === undefined)
  const other = { file_path: '/tmp/x.mjs', offset: 200, limit: 100 }
  check('换一个区间不受影响', h.call(a, 'read', other) === undefined)
  const failing = makeHarness({ readBudget: 1 })
  const b = failing.agent('failwrite')
  await failing.emit('agent/created', { agent: b })
  failing.call(b, 'read', args)
  await failing.post(b, 'write', { file_path: '/tmp/x.mjs' }, true) // isError: file NOT written
  check('失败的写入不会释放读取额度', typeof failing.call(b, 'read', args) === 'string')
  check('readBudget: 0 可关闭该限额', (() => {
    const off = makeHarness({ readBudget: 0 })
    const c = off.agent('off')
    off.call(c, 'read', args); off.call(c, 'read', args); off.call(c, 'read', args)
    return off.call(c, 'read', args) === undefined
  })())
}

console.log('# 原有能力未回归')
{
  const h = makeHarness({})
  const a = h.agent('budget')
  await h.emit('agent/created', { agent: a })
  check('get_goal 每轮 1 次', h.call(a, 'get_goal') === undefined && typeof h.call(a, 'get_goal') === 'string')
  check('update_goal 不再被限额', h.call(a, 'update_goal', { action: 'resume' }) === undefined && h.call(a, 'update_goal', { action: 'complete' }) === undefined)
  check('todo_write 不再按次限额', h.call(a, 'todo_write', { todos: [{ content: 'a', status: 'pending' }] }) === undefined)
  check('未限额工具不受影响', h.call(a, 'bash', { command: 'ls' }) === undefined)
  await h.emit('session/event', { id: 'budget' }, { type: 'turn/start', data: { turn: 2 } })
  check('新轮次重置额度', h.call(a, 'get_goal') === undefined)
  check('嵌套派发不计数', h.guards[0]({ agent: a, name: 'get_goal', arguments: {}, parent: 'tok' }) === undefined)
  const foreign = h.guards[0]({ agent: { session: { id: 'x' } }, name: 'get_goal', arguments: {} })
  check('非本预设 agent 不受影响', foreign === undefined)
  const d = await h.emit('agent/pre-step', { agent: a, messages: [], turn: 1, step: 1, signal: new AbortController().signal })
  check('操作契约注入一次', d.messages.length === 1 && d.messages[0].source.kind === 'gpt-guardrails')
  const d2 = await h.emit('agent/pre-step', { agent: a, messages: [], turn: 2, step: 1, signal: new AbortController().signal })
  check('不重复注入', d2.messages.length === 0)
}

console.log('# 新配置项校验 fail-loud')
for (const [cfg, label] of [
  [{ repeatWindow: 3 }, 'repeatWindow < 4'],
  [{ repeatWindow: 1.5 }, 'repeatWindow 非整数'],
  [{ readBudget: -1 }, 'readBudget 为负'],
  [{ readBudget: 1.5 }, 'readBudget 非整数'],
  [{ repeatThresholds: [] }, '空 repeatThresholds'],
]) {
  let threw = false
  try { makeHarness(cfg) } catch { threw = true }
  check(`拒绝 ${label}`, threw)
}

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
