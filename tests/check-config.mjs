#!/usr/bin/env node
/**
 * Offline config-key check for `agent.cordis.yml`.
 *
 * A preset row whose config keys do not match its plugin's schema fails at
 * MOUNT time: the registry rejects the whole preset, so the symptom is a preset
 * that will not start rather than an error pointing at the row. This catches
 * that before it ships.
 *
 * Self-contained on purpose: the shipped Schemastery expressions live in
 * `schemas.json` beside this file (copied verbatim from the packages), so the
 * check runs with no installed app, no checkout, and no network. When a package
 * gains a config key, re-copy that one expression.
 *
 * `!!js` conditions are not evaluated here — this checks KEY NAMES, not platform
 * values. `install-preset.py` is what evaluates those.
 *
 * Usage: node tests/check-config.mjs
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const COMPOSITION = join(HERE, '..', 'agent.cordis.yml')
const text = readFileSync(COMPOSITION, 'utf8')
const SCHEMAS = JSON.parse(readFileSync(join(HERE, 'schemas.json'), 'utf8'))

/**
 * Stand-in values for the module-level constants the shipped schema
 * expressions reference (size ceilings, default lists, and so on).
 *
 * Their VALUES are irrelevant here: this check reads property NAMES from the
 * expression's shape, and a `z.number().default(READ_LIMIT)` declares `readLimit`
 * whether the constant is 2000 or 0. Supplying them is what lets those
 * expressions evaluate at all, so their rows get checked instead of skipped.
 */
const CONSTANTS = {
  DEFAULT_PROJECT_ROOT_MARKERS: ['.git'],
  DEFAULT_MAX_SOURCE_BYTES: 1048576,
  DEFAULT_INSTRUCTION_FILE_CANDIDATES: ['AGENTS.md'],
  DEFAULT_LOCAL_INSTRUCTION_FILE_CANDIDATES: ['AGENTS.local.md'],
  READ_LIMIT: 2000,
  READ_MAX_LINE_LENGTH: 2000,
  READ_MAX_BYTES: 262144,
  STREAM_MIN_SIZE: 1,
  GREP_MAX_LINE_BYTES: 2000,
  SEARCH_META_MAX_BYTES: 1024,
  RAW_OUTPUT_MAX_BYTES: 262144,
  SEARCH_GRACE_MS: 1000,
  SEARCH_STDERR_MAX_BYTES: 8192,
  SEARCH_TIMEOUT_MS: 30000,
  DEFAULT_WATCH_STABILITY_THRESHOLD_MS: 200,
  DEFAULT_WATCH_POLL_INTERVAL_MS: 100,
  DEFAULT_WATCH_MAX_PROJECTS: 128,
  DEFAULT_CATALOG_DESCRIPTION_MAX_LENGTH: 1024,
  DEFAULT_WEB_TOOL_TIMEOUT_MS: 60000,
  DEFAULT_FETCH_MAX_OUTPUT_CHARS: 100000,
}

/** Split the row list into `{ id, name }` pairs, in file order. */
function readRows(source) {
  const rows = []
  for (const line of source.split('\n')) {
    const top = /^- id:\s*(\S+)\s*$/.exec(line)
    if (top !== null) rows.push({ id: top[1], name: undefined, isGroup: false })
    if (rows.length === 0) continue
    const current = rows[rows.length - 1]
    const name = /^\s+name:\s*(.+?)\s*$/.exec(line)
    if (name !== null && current.name === undefined) {
      current.name = name[1].replace(/^['"]|['"]$/g, '')
    }
    // A group row's `config:` is a child row list, not a mapping.
    if (/^\s+config:\s*$/.test(line) && /^\s+group:\s*true\s*$/.test(source)) {
      // Handled below by the child-id scan; marked here for clarity only.
    }
  }
  return rows
}

/**
 * Keys declared directly under one row's `config:` block.
 *
 * Scans the row's own line span. A group row's child list is skipped: its `- id:`
 * lines are separate rows and stop the span.
 */
function configKeysFor(source, rowId) {
  const lines = source.split('\n')
  const start = lines.findIndex(line => new RegExp(`^- id:\\s*${rowId}\\s*$`).test(line))
  if (start < 0) return new Set()
  let end = lines.length
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^- id:/.test(lines[index])) { end = index; break }
  }
  const keys = new Set()
  let inConfig = false
  for (const line of lines.slice(start, end)) {
    if (/^\s+config:\s*$/.test(line)) { inConfig = true; continue }
    if (!inConfig) continue
    // A nested list item ends the mapping level: `- id:` inside `config:` is a
    // child row, and its keys belong to that child, not to this row.
    if (/^\s+-\s+id:/.test(line)) break
    const key = /^\s+([A-Za-z][A-Za-z0-9_]*):/.exec(line)
    if (key !== null) keys.add(key[1])
  }
  return keys
}

/**
 * Property names one Schemastery expression declares.
 *
 * Evaluated with a recording stand-in for `z`: every builder answers with a
 * chainable object, so an expression using a builder this stub has never heard
 * of still evaluates and still reports its keys, instead of throwing.
 */
function schemaKeys(expr) {
  const makeChain = (self) => {
    const chain = new Proxy(function () {}, {
      get(_target, prop) {
        if (prop === 'props') return self.props
        if (typeof prop === 'symbol') return undefined
        return (...args) => {
          if (prop === 'object') self.props = Object.keys(args[0] ?? {})
          return chain
        }
      },
      apply() { return chain },
    })
    return chain
  }
  const z = new Proxy({}, {
    get: (_target, prop) => {
      if (typeof prop === 'symbol') return undefined
      return (...args) => {
        const self = { props: undefined }
        const chain = makeChain(self)
        if (prop === 'object') self.props = Object.keys(args[0] ?? {})
        return chain
      }
    },
  })
  const names = Object.keys(CONSTANTS)
  try {
    // eslint-disable-next-line no-new-func
    const schema = new Function('z', 'Number', ...names, `return (${expr})`)(
      z,
      Number,
      ...names.map(name => CONSTANTS[name]),
    )
    return schema?.props
  } catch (error) {
    return { error: String(error) }
  }
}

let checked = 0
let skipped = 0
const problems = []

for (const row of readRows(text)) {
  if (typeof row.name !== 'string') continue
  if (row.name.startsWith('./')) {
    console.log(`  local  ${String(row.id).padEnd(22)} ${row.name}`)
    continue
  }
  if (!row.name.startsWith('@deepseek-ai/')) continue
  const pkg = row.name.replace('@deepseek-ai/', '').split('/')[0]
  const expr = SCHEMAS[pkg]
  if (expr === undefined) {
    skipped += 1
    console.log(`  skip   ${String(row.id).padEnd(22)} ${pkg} (no top-level Config schema)`)
    continue
  }
  const declared = schemaKeys(expr)
  if (declared === undefined || declared.error !== undefined) {
    skipped += 1
    console.log(`  skip   ${String(row.id).padEnd(22)} ${pkg} (schema shape not determined)`)
    continue
  }
  const configured = configKeysFor(text, row.id)
  const unknown = [...configured].filter(key => !declared.includes(key))
  checked += 1
  if (unknown.length > 0) {
    problems.push(`${row.id} (${pkg}): unknown key(s) ${unknown.join(', ')} — schema declares: ${declared.join(', ')}`)
    console.log(`  FAIL   ${String(row.id).padEnd(22)} ${pkg} | unknown: ${unknown.join(', ')}`)
  } else {
    console.log(`  ok     ${String(row.id).padEnd(22)} ${pkg} | ${[...configured].join(', ') || 'no config'}`)
  }
}

console.log(`\n${checked} checked, ${skipped} skipped, ${problems.length} failed`)
for (const problem of problems) console.log(`  - ${problem}`)
process.exit(problems.length === 0 ? 0 : 1)
