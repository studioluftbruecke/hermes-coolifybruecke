"""Behaviour: the server each resource runs on (F18). The field in the snapshot, `coolify_overview
server=`, the overview's server text, the references and the `/snapshot` route, against the
synthetic instances in `fixtures/snapshot.json`: `multiserver` (servers app-1 and app-10),
`teamwide` (everything on main) and `scoped` (a token that cannot read servers). No network."""

import copy
import importlib.util
import json
import pathlib
import sys
import types
import urllib.parse

import pytest

ROOT = pathlib.Path(__file__).resolve().parents[1]
FIXTURE = json.loads((ROOT / "tests" / "fixtures" / "snapshot.json").read_text())
BASE = "https://coolify.example.test"
_LOADED = {}


def _plugin():
    if "pkg" not in _LOADED:
        name = "coolifybruecke_servers_under_test"
        spec = importlib.util.spec_from_file_location(name, ROOT / "__init__.py", submodule_search_locations=[str(ROOT)])
        module = importlib.util.module_from_spec(spec)
        sys.modules[name] = module
        spec.loader.exec_module(module)
        for sub in ("snapshot", "references", "capabilities", "coolify_client"):
            importlib.import_module(f"{name}.{sub}")
        _LOADED["pkg"] = module
    return _LOADED["pkg"]


@pytest.fixture
def m():
    pkg = _plugin()
    return types.SimpleNamespace(pkg=pkg, **{sub: sys.modules[f"{pkg.__name__}.{sub}"]
                                             for sub in ("snapshot", "references", "capabilities", "coolify_client")})


class Instance:
    """Answers each token from one fixture instance; records every request."""

    def __init__(self, tokens, fixture=None):
        self.tokens = tokens
        self.fixture = fixture or FIXTURE
        self.requests = []

    def __call__(self, method, url, headers, body, timeout):
        client = sys.modules[_plugin().__name__ + ".coolify_client"]
        token = headers.get("Authorization", "")[len("Bearer "):]
        data = self.fixture.get(self.tokens.get(token), {})
        parsed = urllib.parse.urlsplit(url)
        if parsed.path == "/mcp":
            call = json.loads(body)
            name = call["params"]["name"]
            self.requests.append((method, "MCP " + name))
            args = call["params"]["arguments"]
            key = f"{name}:{args['server_uuid']}" if name == "get_server_metrics" else name
            if name == "list_deployments" and args.get("status") == "finished":
                key = "list_deployments:finished"
            if key not in data.get("mcp", {}):
                return client.HttpResponse(400, json.dumps({"jsonrpc": "2.0", "id": call["id"], "error": {
                    "code": -32602, "message": "not found"}}).encode())
            return client.HttpResponse(200, json.dumps({"jsonrpc": "2.0", "id": call["id"],
                                                        "result": data["mcp"][key]}).encode())
        key = f"{method} {parsed.path}" + (f"?{parsed.query}" if parsed.query else "")
        self.requests.append((method, key))
        if not data:
            return client.HttpResponse(401, b'{"message": "Unauthenticated."}')
        status, payload = data["rest"].get(key, (404, {"message": "Not found."}))
        return client.HttpResponse(status, json.dumps(payload).encode())


def settings():
    return {"COOLIFYBRUECKE_URL": BASE, "check_updates": False}.get


def secrets(read="tok-read"):
    return {"COOLIFYBRUECKE_TOKEN": None, "COOLIFYBRUECKE_READ_TOKEN": read}.get


def kw(m, inst, tmp_path=None):
    return dict(transport=inst, cache=m.snapshot.SnapshotCache(), cache_file=None,
                **({"data_dir": tmp_path} if tmp_path is not None else {}))


def build(m, kind="multiserver", fixture=None):
    conn = m.capabilities.connection_from_settings(BASE, None, "tok-read")
    return m.snapshot.build_snapshot(conn, transport=Instance({"tok-read": kind}, fixture)).to_dict()


def overview(m, kind="multiserver", **filters):
    return m.pkg.overview_text(settings(), secrets(), **filters, **kw(m, Instance({"tok-read": kind})))


HEADERS = ("NEEDS YOU", "ON SERVER", "SERVERS", "DEPLOYMENTS", "LATEST DEPLOYS", "Latest deploys", "RESOURCES",
           "BY PROJECT", "LIMITS", "ERRORS")


def section(text, title):
    lines = text.splitlines()
    start = next(i for i, line in enumerate(lines) if line.startswith(title))
    end = next((i for i in range(start + 1, len(lines)) if lines[i].startswith(HEADERS)), len(lines))
    return lines[start:end]


# --- the field ---------------------------------------------------------------------------------

def test_every_kind_carries_its_server_names_from_its_own_row(m):
    snap = build(m)
    assert {r["name"]: r["servers"] for r in snap["resources"]} == {
        "web-one": ["app-1"], "web-ten": ["app-10"], "stats": ["app-10"], "main-db": ["app-1"],
        "web-both": ["app-1", "app-10"],  # primary first; the nameless additional server is skipped
        "web-lost": []}                   # no server named: unknown, never "no server"


def test_the_recorded_teamwide_rows_run_on_main_and_scoped_rows_are_unknown(m):
    assert {tuple(r["servers"]) for r in build(m, "teamwide")["resources"]} == {("main",)}
    assert [r["servers"] for r in build(m, "scoped")["resources"]] == [[]]


def test_the_server_costs_no_extra_request(m):
    inst = Instance({"tok-read": "multiserver"})
    conn = m.capabilities.connection_from_settings(BASE, None, "tok-read")
    m.snapshot.build_snapshot(conn, transport=inst)
    assert not any("/servers/" in key for _, key in inst.requests)
    assert sorted(key for _, key in inst.requests if not key.startswith("MCP")) == sorted([
        "GET /api/v1/servers", "GET /api/v1/applications", "GET /api/v1/services", "GET /api/v1/databases",
        "GET /api/v1/deployments", "GET /api/v1/projects", "GET /api/v1/projects/proj-fleet"])


def test_only_the_server_name_enters_the_snapshot(m):
    wide = copy.deepcopy(FIXTURE)
    leaky = {"uuid": "srv-app1", "name": "app-1", "ip": "198.51.100.77", "private_key_id": 424242,
             "hetzner_server_id": 777001, "proxy": {"type": "traefik-secret-proxy"}}
    rows = wide["multiserver"]["rest"]
    rows["GET /api/v1/applications"][1][0]["destination"]["server"] = dict(leaky)
    rows["GET /api/v1/applications"][1][2]["additional_servers"] = [dict(leaky, name="app-10")]
    rows["GET /api/v1/services"][1][0]["server"] = dict(leaky, name="app-10")
    rows["GET /api/v1/databases"][1][0]["destination"]["server"] = dict(leaky)
    for row in rows["GET /api/v1/servers"][1]:
        row.update(ip="198.51.100.77", private_key_id=424242)
    snap = build(m, fixture=wide)
    dumped = json.dumps(snap)
    for leak in ("198.51.100.77", "424242", "777001", "traefik-secret-proxy", "private_key_id", "hetzner"):
        assert leak not in dumped
    assert {r["name"]: r["servers"] for r in snap["resources"]}["web-both"] == ["app-1", "app-10"]


def test_the_snapshot_route_carries_servers(m, tmp_path):
    status, body = m.pkg.api_snapshot(settings(), secrets(), **kw(m, Instance({"tok-read": "multiserver"}), tmp_path))
    assert status == 200
    assert {r["name"]: r["servers"] for r in body["resources"]}["web-both"] == ["app-1", "app-10"]


# --- the overview without a filter -------------------------------------------------------------

def test_a_multi_server_overview_names_the_server_per_group_or_per_line(m):
    text = overview(m)
    listing = section(text, "BY PROJECT")
    assert "Fleet / production:" in listing  # mixed group: the header has no server
    assert "  web-one app running:healthy https://web-one.example.test @ app-1" in listing
    assert "  stats ser running:healthy https://stats.example.test @ app-10" in listing
    assert "  web-both app running:healthy https://web-both.example.test @ app-1 + app-10" in listing
    assert "  web-lost app running:healthy https://web-lost.example.test @ server unknown" in listing


def test_a_group_on_one_server_carries_it_in_the_header_only(m):
    text = overview(m, "teamwide")  # servers main and edge; every row on main
    listing = section(text, "BY PROJECT")
    assert listing[1:3] == ["Blog / production: @ main", "  blog app running:unknown https://blog.example.test"]
    assert not any(line.startswith("  ") and "@" in line for line in listing)


def test_a_one_server_instance_shows_no_server_text(m):
    one = copy.deepcopy(FIXTURE)
    one["teamwide"]["rest"]["GET /api/v1/servers"][1] = one["teamwide"]["rest"]["GET /api/v1/servers"][1][:1]
    snap = build(m, "teamwide", one)
    assert m.snapshot.multi_server(snap) is False
    text = m.snapshot.render_overview(snap)
    assert "@" not in "\n".join(section(text, "BY PROJECT"))


def test_every_row_unknown_shows_no_server_text(m):
    lost = copy.deepcopy(FIXTURE)
    for kind in ("applications", "services", "databases"):
        for row in lost["multiserver"]["rest"][f"GET /api/v1/{kind}"][1]:
            row.pop("server", None)
            row.pop("additional_servers", None)
            (row.get("destination") or {}).pop("server", None)
    snap = build(m, fixture=lost)
    assert all(r["servers"] == [] for r in snap["resources"]) and m.snapshot.multi_server(snap) is False
    assert "@" not in "\n".join(section(m.snapshot.render_overview(snap), "BY PROJECT"))


# --- server= -----------------------------------------------------------------------------------

def test_server_filter_opens_with_the_complete_list_and_matches_exactly(m):
    text = overview(m, server="app-1")
    lines = text.splitlines()
    assert "Filter: project~* environment~* server=app-1 (3 of 6 resources)" in lines
    on = section(text, "ON SERVER")
    assert on == ["ON SERVER app-1 (3 resources: 2 applications, 0 services, 1 databases)",
                  "Fleet / production: web-one, main-db",
                  "Fleet / staging: web-both",
                  "1 resources with unknown server not listed: Coolify did not name their server"]
    assert lines.index(on[0]) == lines.index("NEEDS YOU: nothing. No app is failing, no server is down.") + 1
    assert "web-ten" not in text and "stats" not in text  # app-10 is not app-1
    assert section(text, "SERVERS") == ["SERVERS (1)", next(l for l in lines if l.startswith("- app-1:"))]
    listing = section(text, "BY PROJECT")
    assert "  web-one app running:healthy https://web-one.example.test" in listing  # [app-1]: no suffix
    assert "  web-both app running:healthy https://web-both.example.test @ app-1 + app-10" in listing


def test_server_filter_takes_a_uuid_any_case_or_a_unique_part(m):
    for query in ("srv-app10", "APP-10", "app-10"):
        assert "ON SERVER app-10 (3 resources: 2 applications, 1 services, 0 databases)" in overview(m, server=query)


def test_an_ambiguous_or_unknown_server_names_the_servers_and_filters_nothing(m):
    for query, said in (("app", "server='app' fits 2 servers (app-1, app-10), so it filters nothing"),
                        ("nope", "No server matches server='nope', so it filters nothing")):
        text = overview(m, server=query)
        assert said in text and "Servers: app-1, app-10." in text
        assert "ON SERVER" not in text and "Filter:" not in text
        assert "web-ten" in text and "web-one" in text


def test_server_filter_narrows_needs_you_and_the_deploy_sections(m):
    snap = build(m)
    snap["attention"] = [
        {"signal": "failing", "severity": "critical", "resource_uuid": "app-ten", "title": "web-ten is failing"},
        {"signal": "failing", "severity": "critical", "resource_uuid": "app-one", "title": "web-one is failing"},
        {"signal": "server_down", "severity": "critical", "server_uuid": "srv-app10", "title": "app-10 is down"},
        {"signal": "server_down", "severity": "critical", "server_uuid": "srv-app1", "title": "app-1 is down"},
        {"signal": "coolify_update", "severity": "info", "title": "Coolify 9.9.9 is out"},
    ]
    dep = {"uuid": "dep-x", "resource_uuid": "app-ten", "resource_name": "web-ten", "status": "in_progress",
           "created_at": "2026-11-25T10:00:00Z"}
    snap["deployments"] = {"running": [dep, dict(dep, uuid="dep-y", resource_uuid="app-one", resource_name="web-one")]}
    snap["latest_deployments"] = [dict(dep, uuid="dep-z", status="failed"),
                                  dict(dep, uuid="dep-w", status="finished", resource_uuid="app-one",
                                       resource_name="web-one")]
    text = m.snapshot.render_overview(snap, server="app-1")
    needs = section(text, "NEEDS YOU")
    assert [l.split(": ", 1)[1] for l in needs[1:]] == [
        "web-one is failing (uuid app-one)", "app-1 is down (uuid srv-app1)", "Coolify 9.9.9 is out"]
    assert "dep-x" not in text and "dep-z" not in text
    assert "dep-y" in text and "dep-w" in text


def test_fifty_resources_on_one_server_all_appear_under_the_cap(m):
    snap = build(m)
    base = next(r for r in snap["resources"] if r["name"] == "web-one")
    snap["resources"] = [dict(base, uuid=f"u{i}", name=f"service-{i:02d}-with-a-rather-long-name",
                              project=f"Project number {i % 9}", environment=("production", "staging")[i % 2],
                              fqdn=f"https://service-{i}.example.test,https://alias-{i}.example.test",
                              status="exited:unhealthy" if i % 3 else "running:healthy")
                         for i in range(50)] + [dict(base, uuid="v0", name="elsewhere", servers=["app-10"])]
    text = m.snapshot.render_overview(snap, server="app-1", max_chars=m.snapshot.MAX_OVERVIEW_CHARS - 300)
    assert len(text) <= m.snapshot.MAX_OVERVIEW_CHARS - 300
    on = "\n".join(section(text, "ON SERVER"))
    assert on.startswith("ON SERVER app-1 (50 resources: 50 applications, 0 services, 0 databases)")
    assert all(f"service-{i:02d}-with-a-rather-long-name" in on for i in range(50))
    assert "elsewhere" not in text
    assert "more resources not listed; call coolify_overview with project=, environment= or server= to narrow" in text


def test_the_list_itself_is_cut_only_when_it_alone_outgrows_the_cap(m):
    snap = build(m)
    base = next(r for r in snap["resources"] if r["name"] == "web-one")
    snap["resources"] = [dict(base, uuid=f"u{i}", name=f"n{i:03d}-" + "x" * 60, project=f"P{i}") for i in range(300)]
    text = m.snapshot.render_overview(snap, server="app-1")
    assert len(text) <= m.snapshot.MAX_OVERVIEW_CHARS
    on = section(text, "ON SERVER")
    assert on[0].startswith("ON SERVER app-1 (300 resources") and on[1].startswith("P0 / ")
    cut = next(i for i, line in enumerate(on) if line.startswith("... "))
    left = int(on[cut].split()[1])
    assert on[cut] == f"... {left} more names on app-1 not listed" and cut - 1 + left == 300


def test_scoped_token_names_its_cause(m):
    text = overview(m, "scoped", server="app-1")
    assert ("No server names are known, so server='app-1' filters nothing: this token cannot read servers. "
            "To unlock: add a team-wide read-only token (COOLIFYBRUECKE_READ_TOKEN)") in text
    mixed = copy.deepcopy(FIXTURE)
    mixed["scoped"]["rest"]["GET /api/v1/applications"][1].append(
        dict(mixed["multiserver"]["rest"]["GET /api/v1/applications"][1][0], environment_id=11))
    snap = build(m, "scoped", mixed)
    assert snap["servers"] == [] and [r["servers"] for r in snap["resources"]] == [[], ["app-1"]]
    text = m.snapshot.render_overview(snap, server="app-1")  # the rows' own names resolve it
    assert "ON SERVER app-1 (1 resources" in text
    assert "1 resources with unknown server not listed: this token cannot read servers. To unlock:" in text


def test_the_narrowing_hint_names_server_only_on_multi_server_instances(m):
    one = copy.deepcopy(FIXTURE)
    one["teamwide"]["rest"]["GET /api/v1/servers"][1] = one["teamwide"]["rest"]["GET /api/v1/servers"][1][:1]
    for kind, fixture in (("multiserver", None), ("teamwide", one)):
        snap = build(m, kind, fixture)
        snap["resources"] = [dict(snap["resources"][0], uuid=f"u{i}", name=f"app-{i:03d}-long-name") for i in range(300)]
        text = m.snapshot.render_overview(snap)
        assert ("server=" in text.splitlines()[-1]) is (kind == "multiserver")


def test_the_tool_takes_server(m):
    props = m.pkg.COOLIFY_OVERVIEW["parameters"]["properties"]
    assert props["server"]["description"] == ("Only resources on this server: its name or uuid, e.g. app-1. "
                                              "Part of a name works when it fits one server.")
    handler = m.pkg.make_overview_handler(settings(), secrets())
    original = m.pkg.overview_text
    seen = {}
    try:
        m.pkg.overview_text = lambda *a, **k: seen.update(k) or "ok"
        assert handler({"server": "app-1"}) == "ok"
    finally:
        m.pkg.overview_text = original
    assert seen["server"] == "app-1"


# --- references --------------------------------------------------------------------------------

def expand(m, raw, tmp_path):
    return m.pkg.expand_context_reference(raw, settings(), secrets(), **kw(m, Instance({"tok-read": "multiserver"}),
                                                                           tmp_path))


def test_server_reference_counts_and_lists_its_resources(m, tmp_path):
    text = expand(m, "server/app-10", tmp_path)
    assert "runs 3 resources: 2 applications, 1 services, 0 databases:" in text
    assert "- Fleet / production: web-ten, stats\n- Fleet / staging: web-both" in text
    assert "1 resources with unknown server not counted: Coolify did not name their server" in text
    assert len(text) <= m.references.MAX_REFERENCE_CHARS


def test_resource_reference_names_its_server(m, tmp_path):
    assert "\nserver app-1 + app-10\n" in expand(m, "resource/web-both", tmp_path)
    assert "\nserver unknown\n" in expand(m, "resource/web-lost", tmp_path)
    assert "\nserver app-10\n" in expand(m, "stats", tmp_path)
