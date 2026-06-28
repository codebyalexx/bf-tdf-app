const form = document.querySelector('#config-form');
const sessionCount = document.querySelector('#session-count');
const cooldownSeconds = document.querySelector('#cooldown-seconds');
const applyButton = document.querySelector('#apply-config');
const configStatus = document.querySelector('#config-status');
const sessionsBody = document.querySelector('#sessions-body');
const sessionsStatus = document.querySelector('#sessions-status');
const statusDot = document.querySelector('#status-dot');

let configDirty = false;

function formatTimer(seconds) {
  if (!seconds) return '--:--';
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`;
}

function setText(selector, value) {
  document.querySelector(selector).textContent = value;
}

function renderSessions(sessions) {
  sessionsBody.replaceChildren();
  for (const session of sessions) {
    const row = document.createElement('tr');
    const worker = session.worker;
    const values = [
      `#${session.id}`,
      worker?.phase || session.state,
      worker?.activity || 'Initialisation',
      formatTimer(worker?.remainingSeconds),
      String(worker?.cycles || 0),
      `${worker?.totalPoints || 0}p`,
    ];
    values.forEach((value, index) => {
      const cell = document.createElement(index === 0 ? 'th' : 'td');
      if (index === 0) {
        const sessionLink = document.createElement('a');
        sessionLink.className = 'session-id-link';
        sessionLink.href = `/session.html?id=${session.id}`;
        sessionLink.textContent = value;
        cell.append(sessionLink);
      } else {
        cell.textContent = value;
      }
      if (index === 1) cell.dataset.state = worker?.state || session.state;
      row.append(cell);
    });
    const action = document.createElement('td');
    const link = document.createElement('a');
    link.className = 'row-link';
    link.href = `/session.html?id=${session.id}`;
    link.textContent = '→';
    link.setAttribute('aria-label', `Ouvrir la session ${session.id}`);
    action.append(link);
    row.append(action);
    sessionsBody.append(row);
  }
}

function render(data) {
  statusDot.className = `status-dot ${data.state === 'ready' ? 'ready' : 'error'}`;
  setText('#active-sessions', data.aggregate.activeSessions);
  setText('#total-cycles', data.aggregate.cycles);
  setText('#total-points', `${data.aggregate.totalPoints}p`);
  setText('#club-rank', data.ranking.rank ? `#${data.ranking.rank}` : '--');
  setText('#club-points', data.ranking.score == null ? '--' : `${data.ranking.score}p`);
  sessionsStatus.textContent = `${data.sessions.length} profil${data.sessions.length > 1 ? 's' : ''} configuré${data.sessions.length > 1 ? 's' : ''}`;
  renderSessions(data.sessions);

  if (!configDirty) {
    if (sessionCount.options.length !== data.limits.maxSessions) {
      sessionCount.replaceChildren();
      for (let count = 1; count <= data.limits.maxSessions; count += 1) {
        const option = document.createElement('option');
        option.value = String(count);
        option.textContent = `${count} session${count > 1 ? 's' : ''}`;
        sessionCount.append(option);
      }
    }
    sessionCount.value = String(data.config.sessionCount);
    cooldownSeconds.value = String(data.config.cooldownSeconds);
    configStatus.textContent = `Limite machine : ${data.limits.maxSessions} sessions`;
  }
}

async function refresh() {
  try {
    const response = await fetch('/api/status', { cache: 'no-store' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    render(await response.json());
  } catch (error) {
    statusDot.className = 'status-dot error';
    sessionsStatus.textContent = error.message;
  }
}

form.addEventListener('input', () => {
  configDirty = true;
  configStatus.textContent = 'Modifications non appliquées';
});

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  applyButton.disabled = true;
  configStatus.textContent = 'Application de la configuration…';
  try {
    const response = await fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionCount: Number(sessionCount.value),
        cooldownSeconds: Number(cooldownSeconds.value),
      }),
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
    configDirty = false;
    render({ state: 'ready', ...body });
    configStatus.textContent = 'Configuration appliquée';
  } catch (error) {
    configStatus.textContent = error.message;
  } finally {
    applyButton.disabled = false;
  }
});

refresh();
const refreshTimer = setInterval(refresh, 3000);
window.addEventListener('pagehide', () => clearInterval(refreshTimer));
