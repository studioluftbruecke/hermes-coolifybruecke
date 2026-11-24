// node desktop_app_rows.mjs <case>: one case per process (the page keeps module state).
// Mounts the real desktop/plugin.js on desktop_page_harness.mjs and prints one line
// RESULT {"ok": bool, ...details}. The Python test runs every case and asserts ok.
// F17: an Apps row shows Stop on a resource that runs, Start on one that is stopped, neither on an
// unknown state, and no Start while a deployment of that stopped app is in flight (SS-0 measured:
// start on a running app queues a full redeploy, and status stays stale while a deployment runs).
// App links: #/coolifybruecke?app=<uuid> opens that row and scrolls to it once (WPBrücke D17).
import fs from 'node:fs'
import * as h from './harness.mjs'
import plugin, { statusClass } from './plugin.mjs'

const iso = ago => new Date(Date.now() - ago).toISOString()

const app = (name, status) => ({
  uuid: 'app-' + name, name, kind: 'application', project: 'Demo', environment: 'staging', status
})

const FIX = {
  setup: { ok: true, configured: true, steps: [] },
  capabilities: {
    ok: true, checked_at: iso(1000), instance: { url: 'https://coolify.example.test', reachable: true, coolify_version: '4.0.0' },
    tokens: [{ role: 'api', scope: 'team-wide', status: 'ok', rights: ['read', 'deploy'], setting: 'COOLIFYBRUECKE_TOKEN', fingerprint: 'abcd1234', sees: {} }],
    protected: { environments: ['production'], agent_allowed: false }, available: [], not_available: [], warnings: [], setup: { line: 'Ready', tone: 'good' }
  },
  actions: {
    ok: true,
    actions: [
      { kind: 'deploy', label: 'Deploy', target_kinds: ['application'] },
      { kind: 'restart', label: 'Restart', target_kinds: ['application'] },
      { kind: 'start', label: 'Start', target_kinds: ['application'] },
      { kind: 'stop', label: 'Stop', target_kinds: ['application'] }
    ],
    action_token: { role: 'api', setting: 'COOLIFYBRUECKE_TOKEN', deploy: true }
  }
}

function boot(opts) {
  const resources = opts.resources || []
  const snapshot = { ok: true, taken_at: iso(2000), servers: [], resources, fleet: opts.fleet || {}, deployments: { running: [] }, summary: opts.summary || [], attention: opts.attention || [], latest_deployments: [] }
  const apps = { id: 'apps', type: 'resources', size: 'l', props: { row_actions: opts.rowActions || ['deploy', 'restart', 'stop', 'start'], pairs: false } }
  const layout = {
    ok: true,
    layout: { version: 1, updated_by: 'pane', widgets: (opts.widgets || []).concat([apps]) },
    widget_types: [], presets: []
  }
  const ctx = {
    rest: async (path, init) => {
      const method = (init && init.method) || 'GET'
      const p = path.split('?')[0]
      if (p === '/setup') return FIX.setup
      if (p === '/capabilities') return FIX.capabilities
      if (p === '/snapshot') return snapshot
      if (p === '/actions' && method === 'GET') return FIX.actions
      if (p === '/layout' && path.includes('availability')) return { ok: true, availability: [] }
      if (p === '/layout') return layout
      if (p === '/alerts') return { ok: true, on: false }
      if (p === '/notes') return { ok: true, text: '', entries: 0 }
      if (/^\/resources\/[^/]+\/deployments$/.test(p)) return { ok: true, deployments: [{ uuid: 'd1', status: 'finished', commit: 'abc1234def', commit_message: 'History of ' + p.split('/')[2], created_at: iso(60000), finished_at: iso(30000) }] }
      return { ok: false, error: 'no fixture for ' + p }
    },
    storage: { get: (k, f) => f, set: () => {}, remove: () => {} },
    register: c => (contributions.push(c), () => {}),
    registerSettingsPage: c => (contributions.push({ ...c, area: 'settings' }), () => {})
  }
  const contributions = []
  plugin.register(ctx)
  const parts = ['page'].map(id => contributions.find(c => c.id === id))
  h.mount(h.jsx('div', { children: parts.map(c => h.jsx('section', { children: c.render() })) }))
}

const rowOf = uuid => h.all(n => n.type === 'div' && n.props['data-cc-app'] === uuid)[0]
const LABELS = ['Deploy', 'Restart', 'Start', 'Stop']
const rowButtons = uuid => {
  const row = rowOf(uuid)
  if (!row) return null
  const found = h.all(n => n.type === 'button' && LABELS.includes(h.text(n).trim()), [row]).map(n => h.text(n).trim())
  return LABELS.filter(l => found.includes(l))
}
const rowTone = uuid => {
  const row = rowOf(uuid)
  const dot = row && h.all(n => n.props['data-dot'] !== undefined, [row])[0]
  return dot ? dot.props['data-tone'] : null
}
// One colour per action kind, so a row reads before it is read (deploy blue, restart amber,
// stop red, start green). The tone rides on the button as data-cc-tone, and its style must carry
// the matching theme variable: a tinted fill, a hairline and a label mixed toward the page text
// colour (the mix is what keeps contrast in both light and dark).
const rowActionTones = uuid => {
  const row = rowOf(uuid)
  if (!row) return null
  const out = {}
  for (const n of h.all(n => n.type === 'button' && n.props['data-cc-tone'], [row])) {
    out[h.text(n).trim()] = n.props['data-cc-tone']
  }
  return out
}
const rowActionStyles = uuid => {
  const row = rowOf(uuid)
  if (!row) return null
  const out = {}
  for (const n of h.all(n => n.type === 'button' && n.props['data-cc-tone'], [row])) {
    const style = n.props.style || {}
    out[h.text(n).trim()] = { background: style.background, color: style.color, boxShadow: style.boxShadow }
  }
  return out
}

const expanded = uuid => {
  const row = rowOf(uuid)
  const toggle = row && h.all(n => n.type === 'button' && 'aria-expanded' in n.props, [row])[0]
  return toggle ? toggle.props['aria-expanded'] : null
}
const historyShown = uuid => Boolean(rowOf(uuid)) && h.text(rowOf(uuid)).includes('History of ' + uuid)
const scrolledTo = () => h.scrolls.map(s => ({ app: s.props['data-cc-app'], block: s.opts && s.opts.block }))

// Coolify uuids are lowercase letters and digits.
const LINKED = 'k3x9q2app0linked'
const OTHER = 'm7p4q2app0other'
const live = (uuid, name) => ({ uuid, name, kind: 'application', project: 'Demo', environment: 'staging', status: 'running:healthy' })

// The real state measured on the instance (fixture recorded during SS-3, the same app at two
// times, so one state per process): the stopped staging row shows Start, the running one Stop.
const liveState = (key, want) => {
  const state = JSON.parse(fs.readFileSync(new URL('./ss3-live-state.json', import.meta.url), 'utf8'))
  boot({ resources: [state[key].resource], fleet: { [state[key].resource.uuid]: state[key].fleet } })
  return h.settle().then(() => {
    const buttons = rowButtons(state[key].resource.uuid)
    return { ok: JSON.stringify(buttons) === JSON.stringify(want), buttons, want }
  })
}

// SS-0's measured vocabulary (brain coolifybruecke-ss0-statuses.md) plus the statuses Coolify
// documents that this instance never showed. Unknown means neither button.
const VOCAB = [
  ['running:healthy', 'running'], ['running:unknown', 'running'], ['running:unhealthy', 'running'],
  ['running', 'running'], ['exited:unhealthy', 'stopped'], ['exited', 'stopped'], ['exited:3', 'stopped'],
  ['stopped', 'stopped'], ['restarting', 'unknown'], ['starting', 'unknown'], ['created', 'unknown'],
  ['degraded', 'unknown'], ['', 'unknown'], [undefined, 'unknown']
]

const cases = {
  vocabulary() {
    const wrong = VOCAB.filter(([status, want]) => statusClass(status) !== want)
    return Promise.resolve({ ok: wrong.length === 0, wrong, checked: VOCAB.length })
  },
  buttons_running() {
    boot({ resources: [app('run', 'running:healthy'), app('runu', 'running:unknown')] })
    return h.settle().then(() => {
      const a = rowButtons('app-run')
      const b = rowButtons('app-runu')
      return { ok: JSON.stringify(a) === JSON.stringify(['Deploy', 'Restart', 'Stop']) && JSON.stringify(b) === JSON.stringify(a), running: a, unknown_health: b }
    })
  },
  buttons_stopped() {
    boot({ resources: [app('off', 'exited:unhealthy'), app('off2', 'exited')] })
    return h.settle().then(() => {
      const a = rowButtons('app-off')
      const b = rowButtons('app-off2')
      return { ok: JSON.stringify(a) === JSON.stringify(['Deploy', 'Restart', 'Start']) && JSON.stringify(b) === JSON.stringify(a), stopped: a }
    })
  },
  buttons_unknown() {
    boot({ resources: [app('new', 'created'), app('blank', undefined)] })
    return h.settle().then(() => {
      const a = rowButtons('app-new')
      const b = rowButtons('app-blank')
      return { ok: JSON.stringify(a) === JSON.stringify(['Deploy', 'Restart']) && JSON.stringify(b) === JSON.stringify(a), unknown: a }
    })
  },
  start_hidden_while_deploying() {
    boot({ resources: [app('off', 'exited:unhealthy')], fleet: { 'app-off': { state: 'deploying' } } })
    return h.settle().then(() => {
      const a = rowButtons('app-off')
      return { ok: JSON.stringify(a) === JSON.stringify(['Deploy', 'Restart']), buttons: a }
    })
  },
  live_state_stopped() {
    return liveState('stopped', ['Deploy', 'Restart', 'Start'])
  },
  live_state_running() {
    return liveState('running', ['Deploy', 'Restart', 'Stop'])
  },
  tones() {
    boot({ resources: [app('run', 'running:healthy'), app('sick', 'running:unhealthy'), app('off', 'exited:unhealthy'), app('new', 'created')] })
    return h.settle().then(() => {
      const tones = { run: rowTone('app-run'), sick: rowTone('app-sick'), off: rowTone('app-off'), fresh: rowTone('app-new') }
      const ok = tones.run === 'good' && tones.sick === 'warn' && tones.off === 'bad' && tones.fresh === 'muted'
      return { ok, tones }
    })
  },
  // The page opens on the link: that row is expanded with its history and scrolled to once.
  link_opens_row() {
    h.setHash('#/coolifybruecke?app=' + LINKED)
    boot({ resources: [live(OTHER, 'aaa first by name'), live(LINKED, 'zzz linked')] })
    return h.settle().then(() => {
      const seen = { linked: expanded(LINKED), other: expanded(OTHER), history: historyShown(LINKED), scrolls: scrolledTo() }
      const ok = seen.linked === true && seen.other === false && seen.history && JSON.stringify(seen.scrolls) === JSON.stringify([{ app: LINKED, block: 'center' }])
      return { ok, ...seen }
    })
  },
  // A link that arrives while the page is open clears the attention filter that hid its row.
  link_clears_focus() {
    h.setHash('#/coolifybruecke')
    boot({
      resources: [live(OTHER, 'failing one'), live(LINKED, 'healthy one')],
      widgets: [{ id: 'summary', type: 'summary', size: 'l', props: {} }],
      summary: [{ signal: 'failed_deploy', label: 'failed', count: 1, severity: 'bad' }],
      attention: [{ signal: 'failed_deploy', resource_uuid: OTHER, severity: 'bad', label: 'failed' }]
    })
    return h.settle().then(async () => {
      const chip = h.buttons(/failed$/)[0]
      h.click(chip)
      await h.settle()
      const filtered = { linked_row: Boolean(rowOf(LINKED)), other_row: Boolean(rowOf(OTHER)) }
      h.setHash('#/coolifybruecke?app=' + LINKED)
      await h.settle()
      const after = { linked: expanded(LINKED), other_row: Boolean(rowOf(OTHER)), history: historyShown(LINKED), scrolls: scrolledTo() }
      const ok = Boolean(chip) && !filtered.linked_row && filtered.other_row && after.linked === true && after.other_row && after.history && after.scrolls.length === 1 && after.scrolls[0].app === LINKED
      return { ok, chip: Boolean(chip), filtered, after }
    })
  },
  // Values outside the uuid pattern, another page's path, or an empty value open nothing.
  link_invalid_ignored() {
    const long = 'a'.repeat(65)
    const bad = ['#/coolifybruecke?app=app-run', '#/coolifybruecke?app=' + long, '#/wpbruecke?app=' + LINKED, '#/coolifybruecke?app=', '#/coolifybruecke?app=' + LINKED + '%22%5D', '#/coolifybruecke?app=' + LINKED + '/x']
    h.setHash(bad[0])
    boot({ resources: [app('run', 'running:healthy'), live(long, 'long'), live(LINKED, 'linked')] })
    return h.settle().then(async () => {
      const seen = []
      for (const hash of bad) {
        h.setHash(hash)
        await h.settle()
        seen.push({ hash, open: [expanded('app-run'), expanded(long), expanded(LINKED)] })
      }
      const ok = seen.every(s => s.open.every(v => v === false)) && h.scrolls.length === 0
      return { ok, seen, scrolls: scrolledTo() }
    })
  },
  // Keyed on the hash: closing the row sticks through minutes of polls; following the link again
  // (the hash changes and comes back) opens and scrolls again.
  link_not_reopened_on_poll() {
    h.setHash('#/coolifybruecke?app=' + LINKED)
    boot({ resources: [live(LINKED, 'linked')] })
    return h.settle().then(async () => {
      const first = expanded(LINKED)
      h.click(h.all(n => n.type === 'button' && 'aria-expanded' in n.props, [rowOf(LINKED)])[0])
      await h.advance(5 * 60 * 1000)
      const afterPolls = expanded(LINKED)
      h.setHash('#/coolifybruecke')
      await h.settle()
      h.setHash('#/coolifybruecke?app=' + LINKED)
      await h.settle()
      const again = expanded(LINKED)
      const scrolls = scrolledTo()
      const ok = first === true && afterPolls === false && again === true && scrolls.length === 2 && scrolls.every(s => s.app === LINKED)
      return { ok, first, afterPolls, again, scrolls }
    })
  },
  action_tones() {
    boot({ resources: [app('run', 'running:healthy'), app('off', 'exited:unhealthy')] })
    return h.settle().then(() => {
      const running = rowActionTones('app-run')
      const stopped = rowActionTones('app-off')
      const styles = rowActionStyles('app-run')
      const want = { deploy: 'accent', stop: 'red', start: 'green' }
      const tonesOk = running.Deploy === 'accent' && running.Stop === 'red' &&
        stopped.Deploy === 'accent' && stopped.Start === 'green' &&
        running.Restart === undefined && stopped.Restart === undefined
      const colourOf = { accent: 'var(--ui-accent)', red: 'var(--ui-red)', green: 'var(--ui-green)' }
      const styleOk = Object.entries(styles).every(([label, style]) => {
        const colour = colourOf[want[label.toLowerCase()]]
        return Boolean(colour) &&
          style.color.includes(colour) &&
          style.color.includes('color-mix') &&
          style.background.includes(colour) &&
          style.boxShadow.includes(colour)
      })
      return { ok: tonesOk && styleOk, running, stopped, styles }
    })
  }
}

const wanted = process.argv[2]
if (!cases[wanted]) {
  console.error('no case ' + wanted)
  process.exit(1)
}
cases[wanted]().then(value => {
  console.log('RESULT ' + JSON.stringify(value))
}, error => {
  console.error(error && error.stack || error)
  process.exit(1)
})
