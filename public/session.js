const sessionId = Number(new URLSearchParams(location.search).get('id'));
const statusDot = document.querySelector('#status-dot');
const captureButton = document.querySelector('#capture-button');
const screenshot = document.querySelector('#screenshot');
const emptyState = document.querySelector('#empty-state');
const captureStatus = document.querySelector('#capture-status');
let screenshotUrl;

if (!Number.isInteger(sessionId) || sessionId < 1) location.replace('/');
document.querySelector('#session-title').textContent = `Session #${sessionId}`;

function formatTimer(seconds) {
  if (!seconds) return '--:--';
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`;
}

function render(session) {
  const worker = session.worker;
  statusDot.className = `status-dot ${session.state === 'running' ? 'ready' : 'error'}`;
  document.querySelector('#session-club').textContent = session.clubName || 'Initialisation';
  document.querySelector('#activity-title').textContent = worker?.activity || 'Initialisation';
  document.querySelector('#worker-phase').textContent = worker?.phase || session.state;
  document.querySelector('#worker-phase').dataset.state = worker?.state || session.state;
  document.querySelector('#worker-message').textContent = worker?.message || session.error || 'Ouverture du profil';
  document.querySelector('#worker-points').textContent = `${worker?.points || 0}p`;
  document.querySelector('#worker-timer').textContent = formatTimer(worker?.remainingSeconds);
  document.querySelector('#worker-cycles').textContent = String(worker?.cycles || 0);
  document.querySelector('#worker-total').textContent = `${worker?.totalPoints || 0}p`;
  captureButton.disabled = session.state !== 'running';
}

async function refresh() {
  try {
    const response = await fetch(`/api/sessions/${sessionId}`, { cache: 'no-store' });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
    render(body);
  } catch (error) {
    statusDot.className = 'status-dot error';
    captureStatus.textContent = error.message;
  }
}

captureButton.addEventListener('click', async () => {
  captureButton.disabled = true;
  captureStatus.textContent = 'Capture en cours…';
  try {
    const response = await fetch(`/api/sessions/${sessionId}/screenshot`, {
      method: 'POST',
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body.error || `HTTP ${response.status}`);
    }
    const image = await response.blob();
    if (screenshotUrl) URL.revokeObjectURL(screenshotUrl);
    screenshotUrl = URL.createObjectURL(image);
    screenshot.src = screenshotUrl;
    screenshot.classList.add('visible');
    emptyState.hidden = true;
    captureStatus.textContent = `Capturé à ${new Date().toLocaleTimeString('fr-FR')}`;
  } catch (error) {
    captureStatus.textContent = error.message;
  } finally {
    captureButton.disabled = false;
  }
});

refresh();
const refreshTimer = setInterval(refresh, 3000);
window.addEventListener('pagehide', () => clearInterval(refreshTimer));
