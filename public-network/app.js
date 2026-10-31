const activeAgents = document.querySelector('#activeAgents');
const personalCount = document.querySelector('#personalCount');
const specialistCount = document.querySelector('#specialistCount');
const employeeSelect = document.querySelector('#employeeSelect');
const actionButton = document.querySelector('#actionButton');
const joinButton = document.querySelector('#joinButton');
const leaveButton = document.querySelector('#leaveButton');
const scenarioButton = document.querySelector('#scenarioButton');
const scenarioStatus = document.querySelector('#scenarioStatus');
const employeesEl = document.querySelector('#employees');
const modulesEl = document.querySelector('#modules');
const eventLog = document.querySelector('#eventLog');
const sysadminStatus = document.querySelector('#sysadminStatus');
const lifecycleTrace = document.querySelector('#lifecycleTrace');
const phaseLabel = document.querySelector('#phaseLabel');
const moduleLifecycle = document.querySelector('#moduleLifecycle');
const parallelStatus = document.querySelector('#parallelStatus');

let stateCache = null;
let employeeOptionsSignature = '';
let lifecycleCounts = [];
let scenarioWasRunning = false;

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { 'content-type': 'application/json', ...(options.headers || {}) },
    ...options,
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
  return body;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function renderEmployees(state) {
  const active = state.employees.filter((item) => item.active);
  employeesEl.innerHTML = active.length
    ? active.map((employee) => `
      <div class="agentcard personal-agent">
        <div class="agenttop">
          <strong>${escapeHtml(employee.name)}</strong>
          <span class="pill active">PERSONAL · ACTIVE</span>
        </div>
        <div>${escapeHtml(employee.office)}</div>
        <small>${escapeHtml(employee.language)} · ${escapeHtml(employee.role)}</small>
        <code>${escapeHtml(employee.agentId || 'no agent')}</code>
      </div>
    `).join('')
    : '<div class="empty">No employee agents are active.</div>';

  const signature = active
    .map((employee) => `${employee.id}:${employee.name}:${employee.office}`)
    .join('|');

  if (signature !== employeeOptionsSignature) {
    const selected = employeeSelect.value;
    employeeSelect.innerHTML = active
      .map((employee) => `<option value="${escapeHtml(employee.id)}">${escapeHtml(employee.name)} — ${escapeHtml(employee.office)}</option>`)
      .join('');
    if (active.some((employee) => employee.id === selected)) employeeSelect.value = selected;
    employeeOptionsSignature = signature;
  }

  actionButton.disabled = !active.length || state.scenario?.running;
}

function renderRequest(request) {
  const resultOrder = ['Translator', 'Editor', 'Voice Writer'];
  return `
    <div class="requestcard">
      <div class="requesthead">
        <strong>${escapeHtml(request.requestedByName || request.requestedBy || 'employee')}</strong>
        <span>${escapeHtml(request.sourceLanguage || '')} → ${escapeHtml(request.corporateLanguage || 'English')}</span>
      </div>
      <div class="source-message">${escapeHtml(request.text || '')}</div>
      <div class="resultlist">
        ${resultOrder.map((role) => {
          const result = request.results?.[role];
          return `
            <div class="resultrow">
              <span>${role}</span>
              <div>${result ? escapeHtml(result.text) : '<em>working…</em>'}</div>
            </div>
          `;
        }).join('')}
      </div>
    </div>
  `;
}

function renderModules(state) {
  if (!state.modules.length) {
    modulesEl.className = 'cards empty';
    modulesEl.textContent = 'No specialist module is active.';
    parallelStatus.textContent = 'No specialist work';
    return;
  }

  modulesEl.className = 'cards';
  modulesEl.innerHTML = state.modules.map((module) => {
    const running = module.members.filter((member) => member.status === 'running').length;
    const allRunning = running > 1;
    const modeLabel = module.mode === 'real-llm' ? 'REAL LLM' : 'FALLBACK';
    const recentRequests = [...(module.requests || [])].slice(-3).reverse();
    return `
      <div class="modulecard specialist-module">
        <div class="agenttop">
          <strong>${escapeHtml(module.type)}</strong>
          <span class="pill module">TEMPORARY · ON DEMAND</span>
        </div>
        <div class="modulemeta">
          <small>${escapeHtml(module.id)} · requests served: ${module.requestCount || 0}</small>
          <span class="pill mode ${module.mode === 'real-llm' ? 'real' : 'fallback'}">${modeLabel}</span>
        </div>
        <div class="module-note">${allRunning ? '⚡ Multiple specialist agents running concurrently' : 'Shared-state specialist team'}</div>
        <div class="memberlist">
          ${module.members.map((member) => `
            <div>
              <span>${escapeHtml(member.role)}<code>${escapeHtml(member.agentId || '')}</code></span>
              <span class="memberstatus ${escapeHtml(member.status)}">${escapeHtml(member.status)}</span>
            </div>
          `).join('')}
        </div>
        <div class="requestlist">
          ${recentRequests.map(renderRequest).join('')}
        </div>
      </div>
    `;
  }).join('');

  const runningSpecialists = state.modules.flatMap((module) => module.members)
    .filter((member) => member.status === 'running').length;
  parallelStatus.textContent = runningSpecialists > 1
    ? `${runningSpecialists} specialist agents running in parallel`
    : runningSpecialists === 1
      ? '1 specialist agent running'
      : 'Specialist module active';
}

function renderLog(state) {
  eventLog.innerHTML = state.eventLog.length
    ? state.eventLog.map((entry) => `
      <div class="event event-${entry.type.replaceAll('.', '-')}">
        <time>${new Date(entry.at).toLocaleTimeString()}</time>
        <span class="eventtype">${escapeHtml(entry.type)}</span>
        <span>${escapeHtml(entry.message)}</span>
      </div>
    `).join('')
    : '<div class="empty">Waiting for events…</div>';
}

function latestModuleLifecycle(state) {
  const relevant = state.eventLog.find((entry) =>
    ['module.spawn', 'module.reuse', 'module.release'].includes(entry.type));
  if (!relevant) return 'READY';
  if (relevant.type === 'module.spawn') return 'SPAWNED';
  if (relevant.type === 'module.reuse') return 'REUSED';
  if (relevant.type === 'module.release') return 'RELEASED';
  return 'READY';
}

function renderScenario(state) {
  const current = state.scenario || { running: false, step: 'idle' };
  scenarioStatus.textContent = current.step || 'idle';
  phaseLabel.textContent = String(current.step || 'idle').replaceAll('-', ' ').toUpperCase();
  scenarioButton.disabled = Boolean(current.running);
  scenarioButton.textContent = current.running ? '● Demo running…' : '▶ Run elastic workforce demo';
  joinButton.disabled = Boolean(current.running);
  leaveButton.disabled = Boolean(current.running);

  if (current.running && !scenarioWasRunning) lifecycleCounts = [];
  scenarioWasRunning = Boolean(current.running);
}

function renderLifecycle(state) {
  const count = state.activeAgents;
  if (!lifecycleCounts.length || lifecycleCounts[lifecycleCounts.length - 1] !== count) {
    lifecycleCounts.push(count);
  }
  lifecycleTrace.textContent = lifecycleCounts.join(' → ');
  moduleLifecycle.textContent = latestModuleLifecycle(state);
  moduleLifecycle.dataset.state = moduleLifecycle.textContent.toLowerCase();
}

function render(state) {
  stateCache = state;
  activeAgents.textContent = state.activeAgents;
  personalCount.textContent = state.activePersonalAgents;
  specialistCount.textContent = state.activeSpecialistAgents;
  sysadminStatus.textContent = state.sysadmin.status;
  renderScenario(state);
  renderLifecycle(state);
  renderEmployees(state);
  renderModules(state);
  renderLog(state);
}

async function refresh() {
  try { render(await api('/api/state')); }
  catch (error) { sysadminStatus.textContent = `error: ${error.message}`; }
}

scenarioButton.addEventListener('click', async () => {
  scenarioButton.disabled = true;
  lifecycleCounts = [];
  lifecycleTrace.textContent = '—';
  try {
    await api('/api/scenario/run', { method: 'POST', body: '{}' });
    await refresh();
  } catch (error) {
    scenarioStatus.textContent = `error: ${error.message}`;
    scenarioButton.disabled = false;
  }
});

actionButton.addEventListener('click', async () => {
  if (!employeeSelect.value) return;
  await api('/api/action', {
    method: 'POST',
    body: JSON.stringify({ employeeId: employeeSelect.value }),
  });
  await refresh();
});

joinButton.addEventListener('click', async () => {
  await api('/api/scenario/join-fourth', { method: 'POST', body: '{}' });
  await refresh();
});

leaveButton.addEventListener('click', async () => {
  await api('/api/scenario/two-leave', { method: 'POST', body: '{}' });
  await refresh();
});

await refresh();
setInterval(refresh, 250);
