// node desktop_servers.mjs <case>: one case per process (the page keeps module state).
// Mounts the real desktop/plugin.js on desktop_page_harness.mjs and prints one line
// RESULT {"ok": bool, ...details}. The Python test runs every case and asserts ok.
// F18: the server each resource runs on. On a multi-server instance an Apps row names its server
// and the toolbar has a server switch; the `server` prop pins a widget to one server; each Servers
// card counts its resources. A one-server instance, and a backend half that sends no `servers`,
// show none of it.
import fs from 'node:fs'
import * as h from './harness.mjs'
import plugin from './plugin.mjs'

const iso = ago => new Date(Date.now() - ago).toISOString()

const FIX = {
  setup: { ok: true, configured: true, steps: [] },
  capabilities: {
    ok: true, checked_at: iso(1000), instance: { url: 'https://coolify.example.test', reachable: true, coolify_version: '4.7.6' },
    tokens: [{ role: 'read_only', scope: 'team-wide', status: 'ok', rights: ['read'], setting: 'COOLIFYBRUECKE_READ_TOKEN', fingerprint: 'abcd1234', sees: {} }],
    protected: { environments: ['production'], agent_allowed: false }, available: [], not_available: [], warnings: [], setup: { line: 'Ready', tone: 'good' }
  }
}

const server = (uuid, name) => ({ uuid, name, reachable: true, usable: true, metrics_enabled: false, metrics: null })
const res = (uuid, name, kind, environment, servers, extra) => ({
  uuid, name, kind, project: 'Fleet', environment, status: 'running:healthy', servers, ...(extra || {})
})
const good = { state: 'ok', last_good: { commit: 'abc1234def', created_at: iso(90000), finished_at: iso(60000) } }

// Synthetic, as in fixtures/snapshot.json `multiserver`: app-1 and app-10 (a name that contains the
// other), one app on each, one on both, a service, a database, one row Coolify did not name, and a
// pipeline pair split over the two servers.
const MULTI = {
  servers: [server('srvapp1', 'app-1'), server('srvapp10', 'app-10')],
  resources: [
    res('appone', 'web-one', 'application', 'production', ['app-1']),
    res('appten', 'web-ten', 'application', 'production', ['app-10']),
    res('appboth', 'web-both', 'application', 'staging', ['app-1', 'app-10']),
    res('applost', 'web-lost', 'application', 'staging', []),
    res('svcstats', 'stats', 'service', 'production', ['app-10']),
    res('dbmain', 'main-db', 'database', 'production', ['app-1']),
    res('pipeprod', 'shop-prod', 'application', 'production', ['app-1'], { git_repository: 'acme/shop' }),
    res('pipestag', 'shop-stag', 'application', 'staging', ['app-10'], { git_repository: 'acme/shop' })
  ],
  fleet: { pipeprod: good, pipestag: good }
}

function boot(opts) {
  const snapshot = {
    ok: true, taken_at: iso(2000), servers: opts.servers || [], resources: opts.resources || [], fleet: opts.fleet || {},
    deployments: { running: [] }, summary: [], attention: [], latest_deployments: []
  }
  const apps = { id: 'apps', type: 'resources', size: 'l', props: { row_actions: [], ...(opts.appsProps || {}) } }
  const widgets = (opts.servers_widget ? [{ id: 'servers', type: 'servers', size: 'l', props: { history: false } }] : []).concat([apps])
  const layout = { ok: true, layout: { version: 1, updated_by: 'pane', widgets }, widget_types: [], presets: [] }
  const contributions = []
  const ctx = {
    rest: async (path, init) => {
      const p = path.split('?')[0]
      if (p === '/setup') return FIX.setup
      if (p === '/capabilities') return FIX.capabilities
      if (p === '/snapshot') return snapshot
      if (p === '/actions') return { ok: true, actions: [], action_token: null }
      if (p === '/servers/metrics') return { ok: true, range: '1h', minutes: 60, servers: {} }
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
  plugin.register(ctx)
  const page = contributions.find(c => c.id === 'page')
  h.mount(h.jsx('div', { children: [h.jsx('section', { children: page.render() })] }))
}

const rows = () => h.all(n => n.type === 'div' && n.props['data-cc-app']).map(n => n.props['data-cc-app'])
const rowOf = uuid => h.all(n => n.type === 'div' && n.props['data-cc-app'] === uuid)[0]
const serverText = () => Object.fromEntries(h.all(n => n.props['data-cc-server-of']).map(n => [n.props['data-cc-server-of'], h.text(n)]))
const switchButtons = () => {
  const box = h.all(n => n.props['data-cc-server-switch'] !== undefined)[0]
  return box ? h.all(n => n.type === 'button', [box]).map(n => h.text(n).trim()) : null
}
const pick = label => {
  const box = h.all(n => n.props['data-cc-server-switch'] !== undefined)[0]
  const button = box && h.all(n => n.type === 'button' && h.text(n).trim() === label, [box])[0]
  if (!button) throw new Error('no switch button ' + label)
  h.click(button)
  return h.settle()
}
const pairs = () => h.all(n => n.props['data-cc-pair']).map(n => n.props['data-cc-pair'])
const unknownNote = () => {
  const n = h.all(n => n.props['data-cc-unknown-server'] !== undefined)[0]
  return n ? h.text(n) : null
}
const counts = () => Object.fromEntries(h.all(n => n.props['data-cc-server']).map(card => {
  const c = h.all(n => n.props['data-cc-server-count'] !== undefined, [card])[0]
  return [card.props['data-cc-server'], c ? h.text(c) : null]
}))
const expanded = uuid => {
  const row = rowOf(uuid)
  const toggle = row && h.all(n => n.type === 'button' && 'aria-expanded' in n.props, [row])[0]
  return toggle ? toggle.props['aria-expanded'] : null
}
const canon = v => (v && typeof v === 'object' && !Array.isArray(v) ? Object.keys(v).sort().map(k => [k, canon(v[k])]) : v)
const same = (a, b) => JSON.stringify(canon(a)) === JSON.stringify(canon(b))
const sorted = list => list.slice().sort()

const cases = {
  multi_row_text_and_switch() {
    boot(MULTI)
    return h.settle().then(() => {
      const seen = { text: serverText(), switch: switchButtons(), pairs: pairs(), rows: sorted(rows()) }
      const ok = same(seen.text, {
        appone: 'app-1', appten: 'app-10', appboth: 'app-1 + app-10', svcstats: 'app-10', dbmain: 'app-1',
        pipeprod: 'app-1', pipestag: 'app-10'
      }) && same(seen.switch, ['All servers', 'app-1', 'app-10']) && seen.pairs.length === 1 && seen.rows.length === 8
      return { ok, ...seen }
    })
  },
  switch_filters_and_hides_pairs() {
    boot(MULTI)
    return h.settle().then(async () => {
      await pick('app-1')
      const one = { rows: sorted(rows()), text: serverText(), pairs: pairs(), note: unknownNote() }
      await pick('app-10')
      const ten = { rows: sorted(rows()) }
      await pick('All servers')
      const back = { rows: rows().length, pairs: pairs().length, note: unknownNote() }
      const ok = same(one.rows, ['appboth', 'appone', 'dbmain', 'pipeprod']) && same(one.text, {}) && one.pairs.length === 0 &&
        one.note === '1 resource with unknown server hidden.' &&
        same(ten.rows, ['appboth', 'appten', 'pipestag', 'svcstats']) &&
        back.rows === 8 && back.pairs === 1 && back.note === null
      return { ok, one, ten, back }
    })
  },
  link_resets_the_switch() {
    h.setHash('#/coolifybruecke')
    boot(MULTI)
    return h.settle().then(async () => {
      await pick('app-1')
      const before = Boolean(rowOf('appten'))
      h.setHash('#/coolifybruecke?app=appten')
      await h.settle()
      const after = { row: Boolean(rowOf('appten')), open: expanded('appten'), rows: rows().length, scrolls: h.scrolls.map(s => s.props['data-cc-app']) }
      const ok = before === false && after.row && after.open === true && after.rows === 8 && same(after.scrolls, ['appten'])
      return { ok, before, after }
    })
  },
  server_prop_pins_the_widget() {
    boot({ ...MULTI, appsProps: { server: 'APP-10' } })
    return h.settle().then(() => {
      const seen = { rows: sorted(rows()), switch: switchButtons(), text: serverText(), note: unknownNote(), pairs: pairs() }
      const ok = same(seen.rows, ['appboth', 'appten', 'pipestag', 'svcstats']) && seen.switch === null && same(seen.text, {}) &&
        seen.note === '1 resource with unknown server hidden.' && seen.pairs.length === 0
      return { ok, ...seen }
    })
  },
  empty_state_names_the_server() {
    boot({ ...MULTI, appsProps: { server: 'nope', project: 'Fleet' } })
    return h.settle().then(() => {
      const text = h.pageText()
      const ok = rows().length === 0 && text.includes('This widget filters on Fleet / nope.')
      return { ok, rows: rows(), says: text.slice(text.indexOf('Nothing matches'), text.indexOf('Nothing matches') + 80) }
    })
  },
  one_server_shows_no_server_text() {
    boot({
      servers: [server('srvmain', 'main')],
      resources: [res('a1', 'web', 'application', 'production', ['main']), res('a2', 'api', 'application', 'staging', ['main'])],
      servers_widget: true
    })
    return h.settle().then(() => {
      const seen = { text: serverText(), switch: switchButtons(), rows: rows().length, counts: counts() }
      const ok = same(seen.text, {}) && seen.switch === null && seen.rows === 2 && same(seen.counts, { srvmain: '2 resources' })
      return { ok, ...seen }
    })
  },
  older_backend_half_shows_none_of_it() {
    const resources = MULTI.resources.map(({ servers, ...rest }) => rest)
    boot({ servers: MULTI.servers, resources, servers_widget: true })
    return h.settle().then(() => {
      const seen = { text: serverText(), switch: switchButtons(), rows: rows().length, counts: counts() }
      const ok = same(seen.text, {}) && seen.switch === null && seen.rows === 8 && same(seen.counts, { srvapp1: null, srvapp10: null })
      return { ok, ...seen }
    })
  },
  servers_cards_count_their_resources() {
    boot({ ...MULTI, servers_widget: true })
    return h.settle().then(() => {
      const seen = counts()
      const ok = same(seen, { srvapp1: '4 resources', srvapp10: '4 resources' })
      return { ok, counts: seen }
    })
  },
  // The owner's instance as measured live (masked: names, projects, uuids and server names
  // replaced; kinds and the server split kept): every resource names its server, 44 on the
  // first server and 11 on the second.
  live_snapshot_both_servers() {
    const live = JSON.parse(fs.readFileSync(new URL('./servers-live.json', import.meta.url), 'utf8'))
    boot({ ...live, servers_widget: true })
    return h.settle().then(async () => {
      const names = live.servers.map(s => s.name)
      const all = rows().length
      const text = serverText()
      const byServer = live.resources.reduce((m, r) => ((m[r.servers.join(' + ')] = (m[r.servers.join(' + ')] || 0) + 1), m), {})
      const counted = counts()
      const shown = {}
      for (const name of names) {
        await pick(name)
        shown[name] = rows().length
      }
      const ok = all === live.resources.length && Object.keys(text).length === all &&
        same(switchButtons(), ['All servers'].concat(names)) &&
        names.every(n => shown[n] === byServer[n]) && same(byServer, { 'server-a': 44, 'server-b': 11 }) &&
        same(counted, Object.fromEntries(live.servers.map(s => [s.uuid, byServer[s.name] + ' resources'])))
      return { ok, all, byServer, counted, shown }
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
