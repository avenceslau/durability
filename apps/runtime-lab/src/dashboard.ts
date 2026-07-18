export const dashboardHtml = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Durability Runtime Lab</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #090b10;
      --panel: #11151d;
      --panel-raised: #171c26;
      --line: #2a3242;
      --text: #f4f6fb;
      --muted: #98a2b3;
      --accent: #78e6c5;
      --accent-2: #7bb7ff;
      --good: #57d38c;
      --warn: #ffc857;
      --bad: #ff6b7a;
      --running: #8b9cff;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      background:
        radial-gradient(circle at 12% -10%, rgba(71, 153, 255, .16), transparent 32rem),
        radial-gradient(circle at 92% 10%, rgba(88, 224, 175, .12), transparent 28rem),
        var(--bg);
      color: var(--text);
    }
    button { font: inherit; }
    .shell { width: min(1480px, calc(100% - 32px)); margin: 0 auto; padding: 48px 0 80px; }
    header { display: grid; grid-template-columns: 1fr auto; gap: 24px; align-items: end; margin-bottom: 28px; }
    .eyebrow { color: var(--accent); font: 700 12px/1.2 ui-monospace, monospace; letter-spacing: .16em; text-transform: uppercase; }
    h1 { font-size: clamp(34px, 5vw, 68px); line-height: .98; letter-spacing: -.055em; margin: 10px 0 14px; max-width: 900px; }
    .lede { color: var(--muted); max-width: 760px; margin: 0; font-size: 17px; line-height: 1.6; }
    .primary, .run-button {
      border: 0; border-radius: 10px; cursor: pointer; font-weight: 750;
      transition: transform .15s ease, opacity .15s ease, background .15s ease;
    }
    .primary { background: var(--accent); color: #07130f; padding: 13px 18px; white-space: nowrap; }
    .primary:hover, .run-button:hover { transform: translateY(-1px); }
    .primary:disabled, .run-button:disabled { cursor: wait; opacity: .55; transform: none; }
    .summary {
      display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; margin-bottom: 28px;
    }
    .metric { background: rgba(17, 21, 29, .82); border: 1px solid var(--line); border-radius: 14px; padding: 16px 18px; }
    .metric-label { color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: .09em; }
    .metric-value { font-size: 26px; font-weight: 780; margin-top: 5px; }
    .layout { display: grid; grid-template-columns: minmax(420px, .92fr) minmax(520px, 1.35fr); gap: 18px; align-items: start; }
    .panel { border: 1px solid var(--line); background: rgba(17, 21, 29, .88); border-radius: 16px; overflow: hidden; }
    .panel-head { display: flex; justify-content: space-between; align-items: center; padding: 16px 18px; border-bottom: 1px solid var(--line); }
    .panel-head h2 { font-size: 15px; margin: 0; letter-spacing: -.01em; }
    .panel-head span { color: var(--muted); font-size: 12px; }
    #scenario-list { max-height: calc(100vh - 230px); overflow: auto; padding: 8px; }
    .group-label { color: var(--muted); font: 700 10px/1 ui-monospace, monospace; letter-spacing: .13em; text-transform: uppercase; padding: 16px 10px 7px; }
    .scenario {
      display: grid; grid-template-columns: 1fr auto; gap: 12px; align-items: center;
      padding: 13px 12px; border: 1px solid transparent; border-radius: 11px;
    }
    .scenario:hover { background: var(--panel-raised); border-color: var(--line); }
    .scenario h3 { font-size: 14px; margin: 0 0 5px; }
    .scenario p { color: var(--muted); font-size: 12px; line-height: 1.45; margin: 0; }
    .risk { color: var(--warn); }
    .run-button { background: #222a38; color: var(--text); padding: 8px 11px; font-size: 12px; }
    #runs { display: grid; gap: 10px; padding: 10px; max-height: calc(100vh - 230px); overflow: auto; }
    .empty { color: var(--muted); padding: 54px 28px; text-align: center; line-height: 1.6; }
    .run {
      border: 1px solid var(--line); border-radius: 12px; overflow: hidden; background: #0d1118;
    }
    .run-top { display: grid; grid-template-columns: auto 1fr auto; gap: 10px; align-items: center; padding: 13px 14px; }
    .state-dot { width: 9px; height: 9px; border-radius: 50%; background: var(--running); box-shadow: 0 0 0 4px rgba(139, 156, 255, .12); }
    .run[data-state="passed"] .state-dot { background: var(--good); box-shadow: 0 0 0 4px rgba(87, 211, 140, .12); }
    .run[data-state="warning-demonstrated"] .state-dot { background: var(--warn); box-shadow: 0 0 0 4px rgba(255, 200, 87, .12); }
    .run[data-state="failed"] .state-dot { background: var(--bad); box-shadow: 0 0 0 4px rgba(255, 107, 122, .12); }
    .run-title { font-size: 14px; font-weight: 730; }
    .run-id { color: var(--muted); font: 10px/1.4 ui-monospace, monospace; }
    .badge { border: 1px solid var(--line); border-radius: 999px; color: var(--muted); padding: 5px 8px; font: 700 10px/1 ui-monospace, monospace; text-transform: uppercase; }
    .run-body { border-top: 1px solid var(--line); padding: 12px 14px 14px; }
    .checks { display: grid; gap: 6px; }
    .check { display: grid; grid-template-columns: 15px 1fr auto; gap: 8px; align-items: center; font-size: 12px; }
    .check-icon { color: var(--bad); }
    .check.pass .check-icon { color: var(--good); }
    .actual { color: var(--muted); font: 10px/1 ui-monospace, monospace; }
    details { margin-top: 12px; }
    summary { color: var(--accent-2); cursor: pointer; font-size: 11px; user-select: none; }
    .timeline { border-left: 1px solid var(--line); margin: 12px 0 0 5px; padding-left: 14px; display: grid; gap: 9px; }
    .event { position: relative; display: grid; grid-template-columns: 84px 1fr; gap: 8px; font-size: 10px; }
    .event:before { content: ""; position: absolute; width: 5px; height: 5px; border-radius: 50%; background: var(--accent-2); left: -17px; top: 4px; }
    .event-time { color: var(--muted); font-family: ui-monospace, monospace; }
    .event-kind { font-family: ui-monospace, monospace; overflow-wrap: anywhere; }
    .expected { color: var(--muted); font-size: 11px; line-height: 1.45; margin: 10px 0 0; }
    @media (max-width: 980px) {
      header { grid-template-columns: 1fr; }
      header .primary { justify-self: start; }
      .summary { grid-template-columns: repeat(2, 1fr); }
      .layout { grid-template-columns: 1fr; }
      #scenario-list, #runs { max-height: none; }
    }
    @media (max-width: 560px) {
      .shell { width: min(100% - 20px, 1480px); padding-top: 28px; }
      .summary { grid-template-columns: 1fr 1fr; }
      .metric { padding: 13px; }
      .metric-value { font-size: 21px; }
    }
  </style>
</head>
<body>
  <main class="shell">
    <header>
      <div>
        <div class="eyebrow">Workerd · SQLite · real alarms</div>
        <h1>Durability Runtime Lab</h1>
        <p class="lede">Force the ugly moments: resets between commit boundaries, lost acknowledgements, overlapping timeouts, duplicate delivery, alarm replacement, and retry storms. Every verdict is based on persisted invariants.</p>
      </div>
      <button class="primary" id="run-all">Run all scenarios</button>
    </header>
    <section class="summary">
      <div class="metric"><div class="metric-label">Scenarios</div><div class="metric-value" id="total">—</div></div>
      <div class="metric"><div class="metric-label">Passed</div><div class="metric-value" id="passed">0</div></div>
      <div class="metric"><div class="metric-label">Warnings proven</div><div class="metric-value" id="warnings">0</div></div>
      <div class="metric"><div class="metric-label">Running / failed</div><div class="metric-value" id="active">0 / 0</div></div>
    </section>
    <section class="layout">
      <div class="panel">
        <div class="panel-head"><h2>Failure matrix</h2><span>one isolated DO per run</span></div>
        <div id="scenario-list"></div>
      </div>
      <div class="panel">
        <div class="panel-head"><h2>Runtime evidence</h2><span>newest first</span></div>
        <div id="runs"><div class="empty">Run a scenario to see persisted calls, downstream deliveries, checks, and the event timeline.</div></div>
      </div>
    </section>
  </main>
  <script>
    const state = { definitions: [], runs: new Map() };
    const list = document.querySelector('#scenario-list');
    const runs = document.querySelector('#runs');
    const runAll = document.querySelector('#run-all');

    const escapeHtml = (value) => String(value)
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;');

    const refreshMetrics = () => {
      const values = Array.from(state.runs.values());
      document.querySelector('#total').textContent = state.definitions.length;
      document.querySelector('#passed').textContent = values.filter((run) => run.verdict && run.verdict.state === 'passed').length;
      document.querySelector('#warnings').textContent = values.filter((run) => run.verdict && run.verdict.state === 'warning-demonstrated').length;
      const active = values.filter((run) => !run.verdict || run.verdict.state === 'running').length;
      const failed = values.filter((run) => run.verdict && run.verdict.state === 'failed').length;
      document.querySelector('#active').textContent = active + ' / ' + failed;
    };

    const renderScenarios = () => {
      const groups = new Map();
      state.definitions.forEach((definition) => {
        if (!groups.has(definition.group)) groups.set(definition.group, []);
        groups.get(definition.group).push(definition);
      });
      list.innerHTML = Array.from(groups.entries()).map(([group, definitions]) =>
        '<div class="group-label">' + escapeHtml(group) + '</div>' +
        definitions.map((definition) =>
          '<div class="scenario">' +
            '<div><h3 class="' + (definition.riskDemonstration ? 'risk' : '') + '">' + escapeHtml(definition.title) + '</h3>' +
            '<p>' + escapeHtml(definition.summary) + '</p></div>' +
            '<button class="run-button" data-scenario="' + definition.id + '">Run</button>' +
          '</div>'
        ).join('')
      ).join('');
      list.querySelectorAll('[data-scenario]').forEach((button) => {
        button.addEventListener('click', () => runScenario(button.dataset.scenario, button));
      });
    };

    const renderRun = (run) => {
      const verdict = run.verdict || { state: 'running', checks: [] };
      const definition = run.definition;
      const checks = verdict.checks.map((item) =>
        '<div class="check ' + (item.pass ? 'pass' : '') + '">' +
          '<span class="check-icon">' + (item.pass ? '✓' : '·') + '</span>' +
          '<span>' + escapeHtml(item.label) + '</span>' +
          '<span class="actual">' + escapeHtml(item.actual) + '</span>' +
        '</div>'
      ).join('');
      const labEvents = run.lab ? run.lab.events : [];
      const effectEvents = run.effects ? run.effects.attempts.map((attempt) => ({
        at: attempt.at,
        kind: 'downstream_' + (attempt.applied ? 'commit' : 'dedupe_or_failure'),
        attempt: attempt.jobAttempt
      })) : [];
      const events = labEvents.concat(effectEvents).sort((a, b) => a.at - b.at);
      const timeline = events.slice(-40).map((event) =>
        '<div class="event"><span class="event-time">' + new Date(event.at).toLocaleTimeString([], {hour12: false}) + '</span>' +
        '<span class="event-kind">' + escapeHtml(event.kind) + (event.attempt ? ' · attempt ' + event.attempt : '') + '</span></div>'
      ).join('');
      return '<article class="run" data-state="' + verdict.state + '" id="run-' + run.runId + '">' +
        '<div class="run-top"><span class="state-dot"></span><div><div class="run-title">' + escapeHtml(definition.title) + '</div>' +
        '<div class="run-id">' + escapeHtml(run.runId) + '</div></div><span class="badge">' + escapeHtml(verdict.state) + '</span></div>' +
        '<div class="run-body"><div class="checks">' + (checks || '<div class="check"><span class="check-icon">·</span><span>Waiting for runtime evidence</span><span class="actual">polling</span></div>') + '</div>' +
        '<p class="expected">Expected: ' + escapeHtml(definition.expectedOutcome) + '</p>' +
        '<details><summary>Event timeline · ' + events.length + ' events</summary><div class="timeline">' + (timeline || '<span class="event-kind">No events yet</span>') + '</div></details></div></article>';
    };

    const renderRuns = () => {
      const values = Array.from(state.runs.values()).reverse();
      runs.innerHTML = values.length ? values.map(renderRun).join('') : '<div class="empty">No runs yet.</div>';
      refreshMetrics();
    };

    const poll = async (runId, deadline) => {
      try {
        const response = await fetch('/api/runs/' + encodeURIComponent(runId));
        if (response.ok) {
          const update = await response.json();
          state.runs.set(runId, update);
          renderRuns();
          if (update.verdict.state !== 'running') return;
        }
      } catch (_) {
        // A forced object reset can briefly reject RPC; the next poll uses a fresh stub.
      }
      if (Date.now() < deadline) {
        setTimeout(() => poll(runId, deadline), 160);
      } else {
        const current = state.runs.get(runId);
        if (current && current.verdict && current.verdict.state === 'running') {
          current.verdict.state = 'failed';
          current.verdict.checks.push({ label: 'settled before deadline', pass: false, actual: 'timed out' });
          renderRuns();
        }
      }
    };

    const runScenario = async (scenario, button) => {
      if (button) button.disabled = true;
      try {
        const response = await fetch('/api/runs', {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({scenario})
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || 'Failed to start scenario');
        state.runs.set(result.runId, result);
        renderRuns();
        poll(result.runId, Date.now() + 20000 + result.definition.settleMs);
      } finally {
        if (button) button.disabled = false;
      }
    };

    runAll.addEventListener('click', async () => {
      runAll.disabled = true;
      for (const definition of state.definitions) {
        await runScenario(definition.id);
        await new Promise((resolve) => setTimeout(resolve, 80));
      }
      runAll.disabled = false;
    });

    fetch('/api/scenarios').then((response) => response.json()).then((definitions) => {
      state.definitions = definitions;
      renderScenarios();
      refreshMetrics();
    });
  </script>
</body>
</html>`;
