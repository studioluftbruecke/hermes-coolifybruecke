"""The server each resource runs on, in the Desktop half, run from the real desktop/plugin.js in node.

desktop_page_harness.mjs stands in for react, react/jsx-runtime and @hermes/plugin-sdk.
desktop_servers.mjs mounts the Coolifybrücke page against fixed route answers: the Apps rows name
their server on a multi-server instance, the toolbar's server switch filters the list, the
`server` prop pins a widget, each Servers card counts its resources, and a one-server instance or
an older backend half shows none of it. The last case renders the owner's real instance, masked.
Each case runs in its own node process, because the page keeps module state.
"""

from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
HERE = Path(__file__).resolve().parent
PLUGIN_JS = ROOT / "desktop" / "plugin.js"
IMPORTS = ("@hermes/plugin-sdk", "react", "react/jsx-runtime")

CASES = {
    "multi_row_text_and_switch": "each row names its server, the toolbar offers All servers and each name",
    "switch_filters_and_hides_pairs": "the switch shows one server's rows, hides the pipeline pairs and counts the unknown",
    "link_resets_the_switch": "a link to a row the switch hides resets the switch and opens the row",
    "server_prop_pins_the_widget": "the server prop (any case) shows one server, with no switch and no row text",
    "empty_state_names_the_server": "an empty widget names the server it filters on, with the project",
    "one_server_shows_no_server_text": "one server: no row text, no switch, the card still counts",
    "older_backend_half_shows_none_of_it": "a snapshot without servers fields: no row text, no switch, no count",
    "servers_cards_count_their_resources": "each Servers card says how many resources run on it",
    "live_snapshot_both_servers": "the real instance (masked) renders both servers with the measured split",
}


@pytest.fixture(scope="module")
def page_dir(tmp_path_factory):
    node = shutil.which("node")
    if not node:
        pytest.skip("node is not on PATH")
    js = PLUGIN_JS.read_text(encoding="utf-8")
    for module in IMPORTS:
        assert f"from '{module}'" in js, f"desktop/plugin.js no longer imports {module}"
        js = js.replace(f"from '{module}'", "from './harness.mjs'")
    work = tmp_path_factory.mktemp("coolify-servers")
    (work / "plugin.mjs").write_text(js, encoding="utf-8")
    shutil.copy(HERE / "desktop_page_harness.mjs", work / "harness.mjs")
    shutil.copy(HERE / "desktop_servers.mjs", work / "cases.mjs")
    shutil.copy(HERE / "fixtures" / "servers-live.json", work / "servers-live.json")
    return node, work


def run_case(page_dir, case: str) -> dict:
    node, work = page_dir
    done = subprocess.run([node, "cases.mjs", case], capture_output=True, text=True, timeout=60, cwd=work)
    assert done.returncode == 0, done.stdout + done.stderr
    lines = [line for line in done.stdout.splitlines() if line.startswith("RESULT ")]
    assert len(lines) == 1, done.stdout + done.stderr
    return json.loads(lines[0][len("RESULT "):])


@pytest.mark.parametrize("case", list(CASES))
def test_servers_on_the_page(page_dir, case):
    result = run_case(page_dir, case)
    assert result["ok"] is True, f"{CASES[case]}: {result}"
