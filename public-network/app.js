const activeAgents = document.querySelector('#activeAgents');
const personalCount = document.querySelector('#personalCount');
const specialistCount = document.querySelector('#specialistCount');
const employeeSelect = document.querySelector('#employeeSelect');
const actionButton = document.querySelector('#actionButton');
const joinButton = document.querySelector('#joinButton');
const leaveButton = document.querySelector('#leaveButton');
const employeesEl = document.querySelector('#employees');
const modulesEl = document.querySelector('#modules');
const eventLog = document.querySelector('#eventLog');
const sysadminStatus = document.querySelector('#sysadminStatus');

let stateCache = null;

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { 'content-type': 'application/json', ...(options.headers || {}) },
    ...options,
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
  return body;
}

function renderEmployees(state) {
  const active = state.employees.filter((item) => item.active);
  employeesEl.innerHTML = active.length
    ? active.map((employee) => `
      <div class="agentcard">
        <div class="agenttop"><strong>${employee.name}</strong><span class="pill active">ACTIVE</span></div>
        <div>${employee.office}</div>
        <small>${employee.language} · ${employee.role}</small>
        <code>${employee.agentId || 'no agent'}</code>
      </div>
    `).join('')
    : '<div class="empty">No employee agents are active.</div>';

  const selected = employeeSelect.value;
  employeeSelect.innerHTML = active.map((employee) => `<option value="${employee.id}">${employee.name} — ${employee.office}</option>`).join('');
  if (active.some((employee) => employee.id === selected)) employeeSelect.value = selected;
  actionButton.disabled = !active.length;
}

function renderModules(state) {
  if (!state.modules.length) {
    modulesEl.className = 'cards empty';
    modulesEl.textContent = 'No specialist module is active.';
    return;
  }
  modulesEl.className = 'cards';
  modulesEl.innerHTML = state.modules.map((module) => `
    <div class="modulecard">
      <div class="agenttop"><strong>${module.type}</strong><span class="pill module">ON DEMAND</span></div>
      <small>${module.id}</small>
      <div class="memberlist">
        ${module.members.map((member) => `
          <div><span>${member.role}</span><span class="memberstatus ${member.status}">${member.status}</span></div>
        `).join('')}
      </div>
    </div>
  `).join('');
}

function renderLog(state) {
  eventLog.innerHTML = state.eventLog.length
    ? state.eventLog.map((entry) => `
      <div class="event">
        <time>${new Date(entry.at).toLocaleTimeString()}</time>
        <span class="eventtype">${entry.type}</span>
        <span>${entry.message}</span>
      </div>
    `).join('')
    : '<div class="empty">Waiting for events…</div>';
}

function render(state) {
  stateCache = state;
  activeAgents.textContent = 1 + state.activePersonalAgents + state.activeSpecialistAgents;
  personalCount.textContent = state.activePersonalAgents;
  specialistCount.textContent = state.activeSpecialistAgents;
  sysadminStatus.textContent = state.sysadmin.status;
  renderEmployees(state);
  renderModules(state);
  renderLog(state);
}

async function refresh() {
  try { render(await api('/api/state')); }
  catch (error) { sysadminStatus.textContent = `error: ${error.message}`; }
}

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
