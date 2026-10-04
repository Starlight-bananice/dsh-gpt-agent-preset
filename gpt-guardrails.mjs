/**
 * gpt-guardrails — the enforcement half of the `gpt` agent preset.
 *
 * The preset's persona and skill catalog state the operating rules; this plugin
 * makes the three most expensive ones mechanical:
 *
 * 1. PER-TURN CALL BUDGET on the status/planning tools (`get_goal`,
 *    `create_goal`, `update_goal`, `todo_write`). Diagnosis behind it: in the
 *    sessions this preset was built from, a model spent an entire working window
 *    on 300 `todo_write` and 164 `get_goal` calls — rewriting the same plan and
 *    re-reading the same goal — and shipped no implementation at all.
 *    A prose instruction not to do that competes with the model's own
 *    momentum; a budget does not. The denial is actionable (it names the
 *    budget and the replacement behavior), so a blocked call redirects the
 *    turn instead of stalling it.
 *
 * 2. CYCLE BREAKER over a sliding window, not a consecutive run. Both this
 *    plugin's first version and the deployment-wide `repeat-tool-reminder`
 *    counted consecutive identical calls, and a measured GPT loop defeated
 *    both: `bash → read A → read B` repeating 35 times, with the payload
 *    varied just enough (`limit` 400/350/320, `node --version` vs
 *    `node -e ...`) that no exact signature ever appeared twice in a row. The
 *    run counters reset on every intervening call and fired ZERO times in 129
 *    calls. Counting occurrences inside the last `repeatWindow` calls is what
 *    catches an interleaved cycle.
 *
 * 3. RE-READ BUDGET per exact (path, offset, limit), released for a path as
 *    soon as that file is written or edited. The same measurement: 91 of 129
 *    calls were `read`, two files were read 36 and 35 times, and the context
 *    grew to 355K tokens until the provider aborted the stream
 *    (`STREAM_ERROR`). Re-reading bytes already in history adds nothing and is
 *    billed at full input price.
 *
 * It also appends the preset's operating contract to the FIRST pre-step batch
 * of each agent (once per agent, keyed in `injected`), so the authorization and
 * tool-routing rules sit next to real work rather than only in the system
 * prompt — without re-appending the block to every request. That prompt half
 * targets the
 * failure mode OpenAI documents for this model family — stopping to ask rather
 * than acting — which no guard can enforce, because the unwanted behaviour is
 * the ABSENCE of a tool call.
 *
 * DEPENDENCIES: none outside Node globals. A locally authored preset lives
 * under the user home, where `@deepseek-ai/*` is not resolvable — relative
 * preset rows resolve package names from the host base, but a `import` in this
 * file would not. Keep it import-free.
 *
 * AUTHORITY: this is a visibility/steering guard, not a security boundary.
 * Agents are enrolled by `agent/created` on the preset's own standing mount
 * scope, so only agents composed from this preset are affected, and a denial
 * is a normal tool result the model can read.
 */

import { appendFileSync } from 'node:fs'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'gpt-guardrails'

/** Prompt assembly and the tool registry must exist before this plugin runs. */
export const inject = ['systemPrompt', 'tools']

/**
 * Default per-turn budgets, overridden by `config.budgets`.
 *
 * Only two tools are budgeted, and both are reads of state the model already
 * has: `get_goal` re-reads the current goal, and `create_goal` is a one-per-
 * session action. Everything else is deliberately absent.
 *
 * `update_goal` was budgeted here and should not be: a single turn legitimately
 * performs resume -> complete, and a budget turns that into a hard denial.
 * `todo_write` was budgeted too, and that was worse — the tool's own model-
 * facing description says "Mark each todo `completed` as soon as it is done",
 * so a one-call-per-turn cap makes the tool unusable for its stated purpose.
 * It is handled by `todoSpinDenial` instead, which denies only a list identical
 * to the one this agent last wrote.
 */
const DEFAULT_BUDGETS = {
  get_goal: 1,
  create_goal: 1,
}

/** Default repeat counts inside the window, overridden by `config.repeatThresholds`. */
const DEFAULT_REPEAT_THRESHOLDS = [2, 4]

/** Default look-back depth for the cycle breaker, overridden by `config.repeatWindow`. */
const DEFAULT_REPEAT_WINDOW = 12

/** Default re-read allowance per (path, offset, limit) PER TURN, overridden by `config.readBudget`. */
const DEFAULT_READ_BUDGET = 2

/** Message-source kind stamped on everything this plugin injects. */
const SOURCE_KIND = 'gpt-guardrails'

/**
 * The operating contract. Kept short on purpose: it is injected once per agent
 * (the first step that agent takes), so every line must earn its tokens against
 * a model that already reads the full tool catalog.
 *
 * The authorization block is the load-bearing part for the GPT-6 family:
 * OpenAI's own GPT-6 guidance names "more likely to ask the user a question
 * when additional input could materially change the result", "more likely to
 * ask for clarification where earlier models would make assumptions", and
 * "likes to ask non-blocking questions as it's working by default" as the
 * observed behaviours, and prescribes exactly this prompt shape. Logged
 * evidence agrees: a GPT-6 agent on this harness interrupted a request with
 * "正在分析请求…我正在读取预设…" instead of executing it.
 *
 * The SILENCE block targets the family's other documented habit: it "tends
 * toward detailed, formatted responses" and, on long tool-heavy runs, states a
 * short preamble before each step. Measured on a real session: five consecutive
 * steps opened with 58-65 character restatements of the same plan, 68-80%
 * similar to each other, for work that was 12 `read` calls and 3 `bash` calls.
 * The provider cannot fix this from the wire side — OpenAI's `phase` field
 * distinguishes such commentary from a final answer, but a Harness text block
 * is only `{type: 'text', text}`, so there is nothing for the adapter to map.
 * The prompt is where it is addressable.
 *
 * The routing table is the third load-bearing part: the logged failure in the
 * sessions this preset was built from was `bash` used for jobs that
 * `read`/`grep`/`glob`/`edit` own (171 of 207 calls).
 */
const CONTRACT = [
  '<system-reminder>',
  'Operating contract for this turn (preset: gpt).',
  '',
  'AUTHORIZATION. A request to act — "can you…", "I want…", "help me…", or an',
  'imperative — is authorization to do the work. Treat it as an instruction, not',
  'as a question about your capability.',
  '  Do not stop at acknowledging, proposing a plan, or offering to continue. Pick',
  '  the reading that the wording and prior context support, act on it, and say',
  '  only what the user needs in order to read the result. Two things override',
  '  this: a mode restriction the user chose (in plan mode, explore and propose',
  '  instead of acting), and a decision that is genuinely theirs — a design choice',
  '  that changes the outcome, or an irreversible action. Ask about those before',
  '  deciding; for everything else take the reasonable default rather than',
  '  blocking. Do not add disclaimers or approval checklists for hypothetical',
  '  risk.',
  '',
  'SILENCE. Announce nothing. Do not narrate the plan, restate the request, or',
  'report that you are about to read, search, run, or verify something — the tool',
  'calls already show that, and a line per step is noise the user has to read',
  'past. Speak when you have something the user did not already have: a real',
  'decision you cannot make for them, a blocker, or the answer itself. Before a',
  'long or destructive operation, one short line is fine; before a step in a',
  'multi-step tool sequence it is not.',
  '',
  'TOOLS. Route each job to its own tool. Shell only for processes, builds,',
  'tests, package managers, git, and pipelines:',
  '     read a file            -> read     (not `cat`/`sed`)',
  '     find a file by path    -> glob     (not `find`/`ls`)',
  '     search file contents   -> grep     (not `grep`/`rg` in the shell)',
  '     change a file          -> edit     (not `sed -i`/`python - <<EOF`)',
  '     create a file          -> write',
  '  Batch independent reads into one step. Prefer the result already in this',
  '  conversation; re-read a range when the file has changed since, or when the',
  '  slice is no longer in context. Verify a claim about this workspace by',
  '  inspecting it rather than from memory.',
  '',
  'DONE. For work that changes files, the turn ends when the change is on disk and',
  'verified — not when the plan looks complete. A review, diagnosis, or explanation',
  'is finished when the answer is established; do not change files to satisfy a',
  'sense of completion, and do not hold back the answer until something is written.',
  'Verify in proportion to the change, then stop rather than testing indefinitely.',
  'If something cannot be completed, say so with the evidence and stop.',
  '',
  'STYLE. State the point early and directly. Use a list or a table only when the',
  'content is genuinely parallel or comparative, not as the default shape. Skip',
  'preamble and closing summaries.',
  '</system-reminder>',
].join('\n')

/**
 * Activation probe. The preset registry audits a mounted row by awaiting its
 * fiber, so a row that is present but never activates (a pending `inject`, or a
 * compatibility preflight that disabled it) is indistinguishable from a row
 * that is simply working — both leave no trace in the session log. This writes
 * one line per activation to a fixed path, which is the only externally visible
 * proof that `apply` ran for a given generation.
 *
 * Best-effort by design: a read-only or missing home directory must never fail
 * the preset mount, so every failure here is swallowed.
 */
const ACTIVATION_LOG = `${globalThis.process?.env?.HOME ?? ''}/.dsh/gpt-guardrails-activations.log`
function noteActivation(config) {
  note(`activated budgets=${JSON.stringify(config.budgets ?? null)}`)
}

/** Append one diagnostic line. Best-effort: diagnostics never fail the mount. */
function note(line) {
  try {
    appendFileSync(ACTIVATION_LOG, `${new Date().toISOString()} ${line}\n`)
  } catch {
    // Never let diagnostics break the mount.
  }
}


/** Cordis `apply` — install the guard, the detector, and the contract injection. */
export function apply(ctx, config = {}) {
  noteActivation(config)
  const budgets = normalizeBudgets(config.budgets)
  const repeatThresholds = normalizeThresholds(config.repeatThresholds)
  const repeatWindow = normalizeWindow(config.repeatWindow)
  const readBudget = normalizeReadBudget(config.readBudget)
  const injectContract = config.injectContract !== false

  /** sessionId -> the agents composed from this preset in that session. */
  const agentsBySession = new Map()
  /** agent -> mutable per-turn state. */
  const state = new WeakMap()
  /** agent -> { signatures: string[], counts: Map<string, number> } sliding window. */
  const windows = new WeakMap()
  /**
   * agent -> Map<'path\u0000offset\u0000limit', count> for the read budget.
   *
   * Cleared every turn (see `beginTurn`). A session-lifetime budget was wrong:
   * it kept refusing a re-read after the file had been changed by the user, a
   * subagent, a build, or git, and after compaction had dropped the earlier
   * result from context. Within one turn the bytes cannot have changed except
   * by this agent's own edit — which releases the budget — so a per-turn count
   * bounds the measured loop without blocking ordinary work.
   */
  const reads = new WeakMap()
  /** agent -> JSON of the todo list this agent last WROTE, for the spin check. */
  const lastTodoList = new WeakMap()
  /**
   * Agents this preset composed.
   *
   * Membership is EARNED, not assumed: it is granted by `agent/created` when
   * that event reaches the mount, and otherwise claimed the first time the
   * guard or the pre-step waterfall actually sees the agent. Gating solely on
   * `agent/created` was measurably wrong — the activation probe showed
   * `apply()` running while neither the guard nor the contract ever fired, so
   * that event does not reach this mount in the running app. Scoping was never
   * the protection anyway: this plugin's context IS the preset's standing
   * mount, so the only agents whose calls and pre-steps reach it are this
   * preset's own.
   */
  const tracked = new WeakSet()
  /** agent -> userMessage instances this plugin injected, so we never re-inject. */
  const injected = new WeakMap()

  /** Record one agent as this preset's own, once. */
  function claim(agent) {
    if (tracked.has(agent)) return
    tracked.add(agent)
    const peers = agentsBySession.get(agent.session?.id)
    if (peers === undefined) agentsBySession.set(agent.session?.id, new Set([agent]))
    else peers.add(agent)
    note(`claimed session=${agent.session?.id} via-observation`)
  }

  function stateFor(agent) {
    let current = state.get(agent)
    if (current === undefined) {
      current = { turn: -1, used: new Map() }
      state.set(agent, current)
    }
    return current
  }

  /** Reset budgets when a new turn opens; the contract rides the same edge. */
  function beginTurn(agent, turn) {
    const current = stateFor(agent)
    if (current.turn === turn) return current
    current.turn = turn
    current.used = new Map()
    reads.delete(agent)
    // The pending plan clears on the next turn (`todo/write` projection
    // lifetime), so the "same list again" memory clears with it.
    lastTodoList.delete(agent)
    return current
  }

  // ── 1. per-turn budgets ───────────────────────────────────────────────────
  //
  // The guard itself is registered on THIS plugin's context (the preset's
  // standing mount scope) rather than from `agent/created` on `agent.ctx`:
  // the standing context outlives every joined agent, so registration can
  // never race the agent's first request, and a plain-context guard is
  // process-wide — the `tracked` set is what narrows it to agents this preset
  // composed. The guard is monotonic: it runs after every reorderable
  // `tools/pre-execute` listener, and no later listener can turn its denial
  // back into permission.
  ctx.tools.guard((exec) => {
    const agent = exec.agent
    if (agent === undefined) return undefined
    claim(agent)
    // A nested dispatch (Code Mode SDK sub-call) carries a parent token and is
    // not a separate model decision, so it neither spends budget nor is denied.
    if (exec.parent !== undefined) return undefined
    if (exec.name === 'read') {
      const stop = readDenial(agent, exec.arguments)
      if (stop !== undefined) return stop
    }
    if (exec.name === 'todo_write') {
      const stop = todoSpinDenial(agent, exec.arguments, budgets.todo_write)
      if (stop !== undefined) return stop
    }
    const budget = budgets[exec.name]
    if (budget === undefined) return undefined
    const current = stateFor(agent)
    const used = current.used.get(exec.name) ?? 0
    if (used < budget) {
      current.used.set(exec.name, used + 1)
      return undefined
    }
    const reason = denial(exec.name, budget)
    note(`DENIED ${exec.name} (budget ${budget}/turn) session=${agent.session?.id}`)
    return reason
  })

  ctx.on('agent/created', ({ agent }) => {
    claim(agent)
  })

  ctx.on('agent/disposed', ({ agent }) => {
    const peers = agentsBySession.get(agent.session.id)
    if (peers !== undefined) {
      peers.delete(agent)
      if (peers.size === 0) agentsBySession.delete(agent.session.id)
    }
    injected.delete(agent)
  })

  /**
   * The denial text. It must be a redirection, not a wall: a model that reads
   * only "denied" tends to retry the same call, which is the loop this plugin
   * exists to break.
   */
  function denial(toolName, budget) {
    const head = `gpt preset budget: ${toolName} is limited to ${budget} call`
      + `${budget === 1 ? '' : 's'} per turn, and this turn has used them.`
    if (toolName === 'get_goal') {
      return `${head} The goal state is already in this conversation — the system`
        + ' reminder above carries it. Continue with the next concrete tool call'
        + ' for the objective, or call create_goal/update_goal once if the goal'
        + ' itself must change.'
    }
    if (toolName === 'todo_write') {
      return `${head} Your list is already recorded; re-sending it does not`
        + ' advance the task. Take the next concrete action on it instead: read,'
        + ' edit, write, grep, glob, or run the verification command.'
    }
    return `${head} Finish or change the goal in this turn instead of re-reading`
      + ' or re-arming it again.'
  }

  /** The read key a re-read is counted under: same file, same window. */
  function readKey(args) {
    const path = typeof args?.file_path === 'string' ? args.file_path : ''
    return `${path}\u0000${args?.offset ?? ''}\u0000${args?.limit ?? ''}`
  }

  /**
   * Bound reading the SAME RANGE again within one turn.
   *
   * The audited failure shape is a model that re-reads one file dozens of times
   * — a logged session read two files 36 and 35 times inside a 37-step loop,
   * growing the context to 355K tokens until the provider aborted the stream.
   * Repeating a call whose result is already in the same turn's history adds no
   * information and pays full input price for it.
   *
   * Deliberately NOT a blanket read limit, in three ways: the counter is per
   * exact (path, offset, limit); it is RELEASED FOR THAT PATH the moment the
   * file is written or edited; and it resets every turn, because between turns
   * the file may have changed under the agent (user, subagent, build, git) and
   * compaction may have dropped the earlier result from context.
   */
  function readDenial(agent, args) {
    if (readBudget <= 0) return undefined
    const path = typeof args?.file_path === 'string' ? args.file_path : ''
    if (path === '') return undefined
    let counter = reads.get(agent)
    if (counter === undefined) {
      counter = new Map()
      reads.set(agent, counter)
    }
    const key = readKey(args)
    const used = counter.get(key) ?? 0
    if (used < readBudget) {
      counter.set(key, used + 1)
      return undefined
    }
    note(`DENIED read ${path} (range already read ${used}x) session=${agent.session?.id}`)
    return `gpt preset read budget: ${path} has already been read ${used} time`
      + `${used === 1 ? '' : 's'} with this exact range, and its content is in`
      + ' this conversation already. Re-reading the same bytes cannot answer a'
      + ' question the previous result did not. Do one of these instead: use the'
      + ' result you already have, read a DIFFERENT range of the file (change'
      + ' offset/limit), search it with grep, or state what is blocking you and'
      + ' finish the turn.'
  }

  /**
   * Wait on a repeated todo list. This replaces a one-call-per-turn cap that
   * contradicted the tool's own description: the list is the model's working
   * state, and the description instructs it to update that state as steps
   * finish. What actually constitutes spinning is re-sending the SAME list,
   * which advances nothing and pays for the whole list again.
   *
   * `optionalCap` is `config.budgets.todo_write` when a deployment sets one —
   * an escape hatch that is no longer part of the default policy.
   */
  function todoSpinDenial(agent, args, optionalCap) {
    const previous = lastTodoList.get(agent)
    const incoming = JSON.stringify(args?.todos ?? null)
    if (previous !== undefined && previous === incoming) {
      note(`DENIED todo_write (identical to the list already recorded) session=${agent.session?.id}`)
      return 'gpt preset todo check: this is byte-identical to the todo list already'
        + ' recorded for this turn, so re-sending it changes nothing. Your list is'
        + ' intact — continue with the next concrete action on it. If the work'
        + ' itself changed, send the CHANGED list (different items, or different'
        + ' statuses); if nothing changed, the list was not the problem.'
    }
    if (typeof optionalCap === 'number' && optionalCap > 0) {
      const current = stateFor(agent)
      const used = current.used.get('todo_write') ?? 0
      if (used >= optionalCap) {
        note(`DENIED todo_write (configured cap ${optionalCap}/turn) session=${agent.session?.id}`)
        return `gpt preset budget: todo_write is limited to ${optionalCap} call`
          + `${optionalCap === 1 ? '' : 's'} per turn by this preset's configuration.`
      }
      current.used.set('todo_write', used + 1)
    }
    return undefined
  }

  /**
   * Remember the list a successful write recorded. Reading the RESULT rather
   * than the call is what keeps a denied attempt from counting as state: a
   * denied call modified nothing, so comparing against it would make the next
   * legitimate update look like a repeat.
   */
  function noteTodoWrite(agent, args) {
    lastTodoList.set(agent, JSON.stringify(args?.todos ?? null))
  }

  /** A write/edit invalidates that path's read counts: verification stays free. */
  function noteWrite(agent, args) {
    const path = typeof args?.file_path === 'string' ? args.file_path : ''
    if (path === '') return
    const counter = reads.get(agent)
    if (counter === undefined) return
    for (const key of [...counter.keys()]) {
      if (key.startsWith(`${path}\u0000`)) counter.delete(key)
    }
  }

  // ── 2. cycle breaker ──────────────────────────────────────────────────────
  //
  // `tools/post-execute` also observes calls that a guard denied, which is the
  // case worth catching: a model hammering a denied call is the loop.
  ctx.on('tools/post-execute', async (exec, result, next) => {
    const downstream = await next()
    if (exec.agent === undefined) return downstream
    // A file that actually changed makes its previous reads stale, so the read
    // budget for that path is released before the model can verify its edit.
    const failed = result?.isError === true
    if (!failed && (exec.name === 'write' || exec.name === 'edit')) {
      noteWrite(exec.agent, exec.arguments)
    }
    if (!failed && exec.name === 'todo_write') {
      noteTodoWrite(exec.agent, exec.arguments)
    }
    const reminder = observeRepeat(exec)
    if (reminder === undefined) return downstream
    if (downstream.kind === 'block') {
      return {
        kind: 'block',
        feedback: downstream.feedback,
        additionalContexts: [reminder, ...(downstream.additionalContexts ?? [])],
      }
    }
    return { ...downstream, additionalContexts: [reminder, ...(downstream.additionalContexts ?? [])] }
  })

  /**
   * Cycles, not runs. The audited loop was `bash → read A → read B` repeating
   * 35 times: the SAME call never occurred consecutively, so every
   * consecutive-run counter (this plugin's first version, and the deployment's
   * `repeat-tool-reminder`) reset on each intervening call and never fired
   * once in 129 calls. Counting occurrences inside a sliding window of the
   * last `repeatWindow` calls catches an interleaved cycle while still
   * tolerating a genuinely repeated call separated by unrelated work.
   */
  function observeRepeat(exec) {
    const agent = exec.agent
    const signature = `${exec.name} ${canonicalize(exec.arguments)}`
    let window = windows.get(agent)
    if (window === undefined) {
      window = { signatures: [], counts: new Map() }
      windows.set(agent, window)
    }
    const count = (window.counts.get(signature) ?? 0) + 1
    window.counts.set(signature, count)
    window.signatures.push(signature)
    if (window.signatures.length > repeatWindow) {
      const evicted = window.signatures.shift()
      const remaining = (window.counts.get(evicted) ?? 1) - 1
      if (remaining <= 0) window.counts.delete(evicted)
      else window.counts.set(evicted, remaining)
    }
    if (!repeatThresholds.includes(count)) return undefined
    const first = count === repeatThresholds[0]
    const args = preview(signature.slice(exec.name.length + 1))
    const text = first
      ? `This exact call has now appeared ${count} times within the last `
        + `${repeatWindow} tool calls:\n  ${exec.name} ${args}\n`
        + 'Interleaving other calls between repetitions does not make it'
        + ' progress. The result is already in this conversation. Stop issuing'
        + ' it: use the result you have, take a different action, or state the'
        + ' blocker and finish the turn.'
      : `Loop detected: ${exec.name} has repeated ${count} times within the last `
        + `${repeatWindow} tool calls, with these exact arguments:\n  ${args}\n`
        + 'You are cycling, not working. Do not issue this call again. Report what'
        + ' you have established, what is blocking you, and what you need — or'
        + ' finish the turn with your findings.'
    return makeMessage(text, `repeat:${exec.name}×${count}`)
  }

  // ── 3. turn bookkeeping and the once-per-turn contract ────────────────────
  ctx.on('session/event', (session, event) => {
    if (event === undefined || event.type !== 'turn/start') return
    const peers = agentsBySession.get(session.id)
    if (peers === undefined) return
    const turn = typeof event.data?.turn === 'number' ? event.data.turn : undefined
    for (const agent of peers) {
      beginTurn(agent, turn ?? stateFor(agent).turn + 1)
    }
  })

  if (injectContract) {
    // The batch is replaced through the RETURNED decision, never by mutating
    // the payload: `agent/pre-step` is a waterfall, and the decision object is
    // the batch the loop actually enters the step with. Injection is once per
    // AGENT, not once per turn: `injected` is keyed by agent.
    ctx.on('agent/pre-step', async (payload, next) => {
      const decision = await next()
      const agent = payload.agent
      if (agent === undefined || decision.kind !== 'enter') return decision
      claim(agent)
      beginTurn(agent, payload.turn)
      if (injected.has(agent)) return decision
      const message = makeMessage(CONTRACT, 'operating contract')
      injected.set(agent, message)
      return { ...decision, messages: [...decision.messages, message] }
    })
  }

  function makeMessage(text, summary) {
    return {
      id: globalThis.crypto.randomUUID(),
      role: 'user',
      content: [{ type: 'text', text }],
      source: {
        kind: SOURCE_KIND,
        plugin: name,
        form: 'notice',
        summary,
      },
    }
  }
}

/**
 * Validate and normalize the configured budgets. Fail loud at load: a typo in a
 * tool name or a budget of 0 silently disabling a tool is worse than a preset
 * that refuses to mount.
 */
function normalizeBudgets(configured) {
  if (configured === undefined) return DEFAULT_BUDGETS
  if (typeof configured !== 'object' || configured === null || Array.isArray(configured)) {
    throw new TypeError(`${name}: \`budgets\` must be a mapping of tool name to positive integer`)
  }
  const budgets = {}
  for (const [toolName, value] of Object.entries(configured)) {
    if (!Number.isInteger(value) || value < 1) {
      throw new TypeError(`${name}: budget for \`${toolName}\` must be an integer >= 1, got ${String(value)}`)
    }
    budgets[toolName] = value
  }
  return Object.keys(budgets).length === 0 ? DEFAULT_BUDGETS : budgets
}

/** Validate ascending repeat counts for the sliding-window cycle breaker. */
function normalizeThresholds(configured) {
  if (configured === undefined) return DEFAULT_REPEAT_THRESHOLDS
  if (!Array.isArray(configured) || configured.length === 0) {
    throw new TypeError(`${name}: \`repeatThresholds\` must be a non-empty array of integers >= 2`)
  }
  for (const value of configured) {
    if (!Number.isInteger(value) || value < 2) {
      throw new TypeError(`${name}: invalid repeat threshold ${String(value)} — must be an integer >= 2`)
    }
  }
  return [...new Set(configured)].sort((left, right) => left - right)
}

/** How many recent calls the cycle breaker looks back over. */
function normalizeWindow(configured) {
  if (configured === undefined) return DEFAULT_REPEAT_WINDOW
  if (!Number.isInteger(configured) || configured < 4) {
    throw new TypeError(`${name}: \`repeatWindow\` must be an integer >= 4, got ${String(configured)}`)
  }
  return configured
}

/** Per-session re-read allowance for one exact (path, offset, limit). */
function normalizeReadBudget(configured) {
  if (configured === undefined) return DEFAULT_READ_BUDGET
  if (!Number.isInteger(configured) || configured < 0) {
    throw new TypeError(`${name}: \`readBudget\` must be an integer >= 0 (0 disables it), got ${String(configured)}`)
  }
  return configured
}

/** Deep key-sort so argument objects that differ only in key order compare equal. */
function canonicalize(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value) ?? String(value)
}

/** Head-truncate an argument preview so a looping payload cannot ride unbounded. */
function preview(text, limit = 240) {
  const flat = String(text).replace(/\s+/g, ' ')
  return flat.length <= limit ? flat : `${flat.slice(0, limit)}… (+${flat.length - limit} more chars)`
}
