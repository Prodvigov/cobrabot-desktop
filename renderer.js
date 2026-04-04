const { ipcRenderer } = require('electron');

// DOM elements
const statusCard = document.getElementById('status-card');
const statusIndicator = document.getElementById('status-indicator');
const statusText = document.getElementById('status-text');
const tokenGroup = document.getElementById('token-group');
const tokenInput = document.getElementById('token-input');
const connectBtn = document.getElementById('connect-btn');
const connectedInfo = document.getElementById('connected-info');
const disconnectBtn = document.getElementById('disconnect-btn');
const errorMessage = document.getElementById('error-message');
const errorText = document.getElementById('error-text');
const helpLink = document.getElementById('help-link');

// Modal elements
const confirmationModal = document.getElementById('confirmation-modal');
const modalTitle = document.getElementById('modal-title');
const modalMessage = document.getElementById('modal-message');
const modalDetails = document.getElementById('modal-details');
const confirmYesBtn = document.getElementById('confirm-yes');
const confirmNoBtn = document.getElementById('confirm-no');

let currentConfirmationId = null;

// Connect button handler
connectBtn.addEventListener('click', async () => {
  const token = tokenInput.value.trim();
  
  if (!token) {
    showError('Введите токен подключения');
    return;
  }
  
  // Show connecting state
  setConnectingState();
  
  try {
    await ipcRenderer.invoke('connect', token);
  } catch (err) {
    showError(err.message);
    setDisconnectedState();
  }
});

// Disconnect button handler
disconnectBtn.addEventListener('click', async () => {
  await ipcRenderer.invoke('disconnect');
  setDisconnectedState();
});

// Help link
helpLink.addEventListener('click', (e) => {
  e.preventDefault();
  require('electron').shell.openExternal('https://cobrabot.ru/help');
});

// Listen for connection status updates
ipcRenderer.on('connection-status', (event, data) => {
  if (data.connected) {
    setConnectedState();
  } else {
    setDisconnectedState();
  }
});

// Listen for connection errors
ipcRenderer.on('connection-error', (event, data) => {
  showError(data.error);
  setDisconnectedState();
});

// Listen for auto-connect
ipcRenderer.on('auto-connect', (event, data) => {
  tokenInput.value = data.token;
  setConnectingState();
});

// Listen for confirmation requests
ipcRenderer.on('confirmation-request', (event, data) => {
  currentConfirmationId = data.id;
  modalMessage.textContent = data.message;
  modalDetails.textContent = data.details;
  confirmationModal.style.display = 'flex';
});

// Confirmation button handlers
confirmYesBtn.addEventListener('click', async () => {
  confirmationModal.style.display = 'none';
  if (currentConfirmationId) {
    await ipcRenderer.invoke('confirmation-response', {
      id: currentConfirmationId,
      confirmed: true
    });
    currentConfirmationId = null;
  }
});

confirmNoBtn.addEventListener('click', async () => {
  confirmationModal.style.display = 'none';
  if (currentConfirmationId) {
    await ipcRenderer.invoke('confirmation-response', {
      id: currentConfirmationId,
      confirmed: false
    });
    currentConfirmationId = null;
  }
});

// State functions
function setConnectingState() {
  statusCard.classList.add('connecting');
  statusIndicator.className = 'status-indicator';
  statusText.textContent = 'Подключение...';
  connectBtn.disabled = true;
  hideError();
}

function setConnectedState() {
  statusCard.classList.remove('connecting');
  statusIndicator.className = 'status-indicator connected';
  statusText.textContent = 'Подключено';
  tokenGroup.style.display = 'none';
  connectedInfo.style.display = 'block';
  hideError();
}

function setDisconnectedState() {
  statusCard.classList.remove('connecting');
  statusIndicator.className = 'status-indicator';
  statusText.textContent = 'Отключено';
  tokenGroup.style.display = 'block';
  connectedInfo.style.display = 'none';
  connectBtn.disabled = false;
}

function showError(message) {
  errorMessage.style.display = 'block';
  errorText.textContent = message;
}

function hideError() {
  errorMessage.style.display = 'none';
}

// Initialize
(async () => {
  const status = await ipcRenderer.invoke('get-status');
  if (status.connected) {
    setConnectedState();
  } else if (status.hasToken) {
    setConnectingState();
  } else {
    setDisconnectedState();
  }
})();
