const { app, BrowserWindow, Tray, Menu, ipcMain, shell } = require('electron');
const path = require('path');
const WebSocket = require('ws');
const Store = require('electron-store');
const screenshot = require('screenshot-desktop');
const { mouse, keyboard, Key } = require('@nut-tree-fork/nut-js');
const fs = require('fs');
const os = require('os');
const puppeteer = require('puppeteer');

const store = new Store();
let mainWindow = null;
let tray = null;
let ws = null;
let browserInstance = null;

// Gateway config
const GATEWAY_URL = 'ws://155.212.228.24:18790';

// Heartbeat config
const HEARTBEAT_INTERVAL = 30000; // 30 seconds
const HEARTBEAT_TIMEOUT = 90000; // 3 missed heartbeats = disconnect
let heartbeatTimer = null;
let lastPongTime = null;
let missedHeartbeats = 0;

// Safety tiers for commands
const SAFETY_TIERS = {
  safe: ['screenshot', 'ping', 'browser_navigate', 'browser_screenshot', 'browser_wait', 'mousemove', 'scroll'],
  moderate: ['exec', 'click', 'type', 'keypress', 'browser_click', 'browser_type', 'browser_launch', 'browser_evaluate'],
  dangerous: ['browser_close']
};

// Dangerous patterns for exec commands
const DANGEROUS_PATTERNS = [
  /^rm\s+/, /^rm\s+-rf/, /^sudo/, /^format/, /^mkfs/,
  /^dd\s+/, /^chmod\s+777/, /^chown/, /^>/,
  /\|\s*rm/, /\|\s*sudo/, /&&\s*rm/, /&&\s*sudo/
];

// Pending confirmations
const pendingConfirmations = new Map();
let confirmationCounter = 0;

// Create main window
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 400,
    height: 500,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    },
    icon: path.join(__dirname, 'assets', 'icon.png')
  });

  mainWindow.loadFile('index.html');
  
  // Hide on close instead of quitting
  mainWindow.on('close', (event) => {
    if (!app.isQuitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });
}

// Create system tray
function createTray() {
  tray = new Tray(path.join(__dirname, 'assets', 'icon.png'));
  
  const contextMenu = Menu.buildFromTemplate([
    { label: 'CobraBot Desktop', enabled: false },
    { type: 'separator' },
    { 
      label: 'Статус: Отключено',
      id: 'status',
      enabled: false
    },
    { type: 'separator' },
    { 
      label: 'Показать окно',
      click: () => {
        mainWindow.show();
      }
    },
    { 
      label: 'Выйти',
      click: () => {
        app.isQuitting = true;
        app.quit();
      }
    }
  ]);
  
  tray.setToolTip('CobraBot Desktop');
  tray.setContextMenu(contextMenu);
  
  tray.on('click', () => {
    mainWindow.show();
  });
}

// Connect to Gateway
function connectToGateway(token) {
  if (ws) {
    ws.close();
  }
  
  ws = new WebSocket(`${GATEWAY_URL}?token=${token}`);
  
  ws.on('open', () => {
    console.log('Connected to Gateway');
    updateStatus('Подключено', true);
    mainWindow.webContents.send('connection-status', { connected: true });
    startHeartbeat();
  });
  
  ws.on('close', () => {
    console.log('Disconnected from Gateway');
    stopHeartbeat();
    updateStatus('Отключено', false);
    mainWindow.webContents.send('connection-status', { connected: false });
    
    // Auto-reconnect after 5 seconds
    setTimeout(() => {
      if (store.get('token')) {
        connectToGateway(store.get('token'));
      }
    }, 5000);
  });
  
  ws.on('error', (err) => {
    console.error('WebSocket error:', err);
    updateStatus('Ошибка', false);
    mainWindow.webContents.send('connection-error', { error: err.message });
  });
  
  ws.on('message', (data) => {
    try {
      const message = JSON.parse(data.toString());
      
      // Handle pong response
      if (message.type === 'pong' || message.pong) {
        lastPongTime = Date.now();
        missedHeartbeats = 0;
        return;
      }
      
      handleCommand(message);
    } catch (err) {
      console.error('Parse error:', err);
    }
  });
}

// Update tray status
function updateStatus(status, connected) {
  const statusItem = tray.menu.getMenuItemById('status');
  if (statusItem) {
    statusItem.label = `Статус: ${status}`;
  }
  
  // Update tray icon color (if we have different icons)
  const iconFile = connected ? 'icon-active.png' : 'icon.png';
  tray.setImage(path.join(__dirname, 'assets', iconFile));
}

// Heartbeat functions
function startHeartbeat() {
  stopHeartbeat(); // Clear any existing timer
  
  lastPongTime = Date.now();
  missedHeartbeats = 0;
  
  heartbeatTimer = setInterval(() => {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      stopHeartbeat();
      return;
    }
    
    // Check if we received pong
    const now = Date.now();
    const timeSinceLastPong = now - lastPongTime;
    
    if (timeSinceLastPong > HEARTBEAT_TIMEOUT) {
      missedHeartbeats++;
      console.log(`Missed heartbeat (${missedHeartbeats})`);
      
      if (missedHeartbeats >= 3) {
        console.log('Connection stale, reconnecting...');
        ws.close();
        return;
      }
    }
    
    // Send ping
    ws.send(JSON.stringify({ type: 'ping', timestamp: now }));
  }, HEARTBEAT_INTERVAL);
}

function stopHeartbeat() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
  missedHeartbeats = 0;
}

// Check safety tier for command
function checkSafetyTier(type, payload) {
  // Safe commands - no confirmation needed
  if (SAFETY_TIERS.safe.includes(type)) {
    return { needsConfirmation: false };
  }
  
  // Moderate commands - check for dangerous patterns
  if (SAFETY_TIERS.moderate.includes(type)) {
    if (type === 'exec' && payload?.command) {
      const cmd = payload.command;
      for (const pattern of DANGEROUS_PATTERNS) {
        if (pattern.test(cmd)) {
          return {
            needsConfirmation: true,
            tier: 'dangerous',
            message: '⚠️ Потенциально опасная команда',
            details: `Выполнить: \`${cmd}\`?`
          };
        }
      }
    }
    return { needsConfirmation: false };
  }
  
  // Dangerous commands - always need confirmation
  if (SAFETY_TIERS.dangerous.includes(type)) {
    return {
      needsConfirmation: true,
      tier: 'dangerous',
      message: '⚠️ Опасное действие',
      details: `Команда: ${type}`
    };
  }
  
  return { needsConfirmation: false };
}

// Request confirmation from user
async function requestConfirmation(message, details) {
  return new Promise((resolve) => {
    const confirmationId = ++confirmationCounter;
    
    // Send confirmation request to UI
    mainWindow.webContents.send('confirmation-request', {
      id: confirmationId,
      message,
      details
    });
    
    // Store pending confirmation
    pendingConfirmations.set(confirmationId, resolve);
    
    // Show window
    mainWindow.show();
  });
}

// Handle commands from Gateway
async function handleCommand(message) {
  console.log('Received command:', message);
  
  const { type, payload, requestId } = message;
  
  // Safety check
  const safetyResult = checkSafetyTier(type, payload);
  if (safetyResult.needsConfirmation) {
    // Show confirmation dialog
    const confirmed = await requestConfirmation(safetyResult.message, safetyResult.details);
    
    if (!confirmed) {
      ws.send(JSON.stringify({
        type: 'response',
        requestId,
        success: false,
        error: 'User denied the action'
      }));
      return;
    }
  }
  
  let result = { success: false, error: 'Unknown command' };
  
  switch (type) {
    case 'screenshot':
      result = await takeScreenshot();
      break;
      
    case 'exec':
      result = await executeCommand(payload);
      break;
      
    case 'click':
      result = await performClick(payload);
      break;
      
    case 'type':
      result = await performType(payload);
      break;
      
    case 'keypress':
      result = await performKeyPress(payload);
      break;
    
    case 'mousemove':
      result = await performMouseMove(payload);
      break;
    
    case 'scroll':
      result = await performScroll(payload);
      break;
    
    // Puppeteer browser commands
    case 'browser_launch':
      result = await browserLaunch(payload);
      break;
    
    case 'browser_navigate':
      result = await browserNavigate(payload);
      break;
    
    case 'browser_screenshot':
      result = await browserScreenshot(payload);
      break;
    
    case 'browser_click':
      result = await browserClick(payload);
      break;
    
    case 'browser_type':
      result = await browserType(payload);
      break;
    
    case 'browser_wait':
      result = await browserWait(payload);
      break;
    
    case 'browser_close':
      result = await browserClose();
      break;
    
    case 'browser_evaluate':
      result = await browserEvaluate(payload);
      break;
      
    case 'ping':
      result = { success: true, pong: true };
      break;
      
    default:
      result = { success: false, error: `Unknown command: ${type}` };
  }
  
  // Send response back
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({
      type: 'response',
      requestId,
      ...result
    }));
  }
}

// Take screenshot
async function takeScreenshot() {
  try {
    const tmpDir = os.tmpdir();
    const filename = `screenshot-${Date.now()}.png`;
    const filepath = path.join(tmpDir, filename);
    
    await screenshot({ filename: filepath });
    
    const imageBuffer = fs.readFileSync(filepath);
    const base64 = imageBuffer.toString('base64');
    
    // Cleanup
    fs.unlinkSync(filepath);
    
    return {
      success: true,
      image: base64,
      width: 1920, // Will be updated with actual dimensions
      height: 1080
    };
  } catch (err) {
    console.error('Screenshot error:', err);
    return { success: false, error: err.message };
  }
}

async function executeCommand(payload) {
  const { exec } = require('child_process');
  const { promisify } = require('util');
  const execAsync = promisify(exec);
  
  try {
    const { stdout, stderr } = await execAsync(payload.command, {
      timeout: 60000,
      maxBuffer: 1024 * 1024
    });
    return { success: true, stdout, stderr };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

async function performClick(payload) {
  try {
    const { x, y } = payload;
    await mouse.setPosition({ x, y });
    await mouse.leftClick();
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

async function performType(payload) {
  try {
    const { text } = payload;
    await keyboard.type(text);
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

async function performKeyPress(payload) {
  try {
    const { key } = payload;
    // Map common keys
    const keyMap = {
      'enter': Key.Enter,
      'escape': Key.Escape,
      'tab': Key.Tab,
      'backspace': Key.Backspace,
      'delete': Key.Delete,
      'space': Key.Space,
      'arrow_up': Key.Up,
      'arrow_down': Key.Down,
      'arrow_left': Key.Left,
      'arrow_right': Key.Right,
      'ctrl': Key.LeftControl,
      'alt': Key.LeftAlt,
      'shift': Key.LeftShift,
      'cmd': Key.LeftSuper
    };
    
    const mappedKey = keyMap[key.toLowerCase()] || key;
    await keyboard.pressKey(mappedKey);
    await keyboard.releaseKey(mappedKey);
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

async function performMouseMove(payload) {
  try {
    const { x, y } = payload;
    await mouse.setPosition({ x, y });
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

async function performScroll(payload) {
  try {
    const { direction, amount } = payload;
    const scrollAmount = amount || 100;
    
    if (direction === 'down') {
      await mouse.scrollDown(scrollAmount);
    } else if (direction === 'up') {
      await mouse.scrollUp(scrollAmount);
    } else if (direction === 'left') {
      await mouse.scrollLeft(scrollAmount);
    } else if (direction === 'right') {
      await mouse.scrollRight(scrollAmount);
    }
    
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// ============================================
// Puppeteer Browser Functions
// ============================================

async function browserLaunch(payload) {
  try {
    const options = payload || {};
    
    // Close existing browser if any
    if (browserInstance) {
      await browserInstance.close();
    }
    
    browserInstance = await puppeteer.launch({
      headless: options.headless !== false, // default true
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    
    return { success: true, message: 'Browser launched' };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

async function browserNavigate(payload) {
  try {
    if (!browserInstance) {
      return { success: false, error: 'Browser not launched' };
    }
    
    const { url } = payload;
    const page = await browserInstance.newPage();
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
    
    return { success: true, title: await page.title(), url: page.url() };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

async function browserScreenshot(payload) {
  try {
    if (!browserInstance) {
      return { success: false, error: 'Browser not launched' };
    }
    
    const pages = await browserInstance.pages();
    const page = pages[pages.length - 1];
    
    const screenshot = await page.screenshot({
      encoding: 'base64',
      fullPage: payload?.fullPage || false
    });
    
    return { success: true, image: screenshot };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

async function browserClick(payload) {
  try {
    if (!browserInstance) {
      return { success: false, error: 'Browser not launched' };
    }
    
    const { selector } = payload;
    const pages = await browserInstance.pages();
    const page = pages[pages.length - 1];
    
    await page.click(selector);
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

async function browserType(payload) {
  try {
    if (!browserInstance) {
      return { success: false, error: 'Browser not launched' };
    }
    
    const { selector, text } = payload;
    const pages = await browserInstance.pages();
    const page = pages[pages.length - 1];
    
    await page.type(selector, text);
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

async function browserWait(payload) {
  try {
    if (!browserInstance) {
      return { success: false, error: 'Browser not launched' };
    }
    
    const { selector, timeout } = payload;
    const pages = await browserInstance.pages();
    const page = pages[pages.length - 1];
    
    await page.waitForSelector(selector, { timeout: timeout || 30000 });
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

async function browserClose() {
  try {
    if (browserInstance) {
      await browserInstance.close();
      browserInstance = null;
    }
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

async function browserEvaluate(payload) {
  try {
    if (!browserInstance) {
      return { success: false, error: 'Browser not launched' };
    }
    
    const { script } = payload;
    const pages = await browserInstance.pages();
    const page = pages[pages.length - 1];
    
    const result = await page.evaluate(script);
    return { success: true, result };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// IPC handlers
ipcMain.handle('connect', async (event, token) => {
  store.set('token', token);
  connectToGateway(token);
  return { success: true };
});

ipcMain.handle('disconnect', async () => {
  if (ws) {
    ws.close();
    ws = null;
  }
  store.delete('token');
  return { success: true };
});

ipcMain.handle('get-status', async () => {
  return {
    connected: ws && ws.readyState === WebSocket.OPEN,
    hasToken: store.has('token')
  };
});

// Handle confirmation response from UI
ipcMain.handle('confirmation-response', async (event, data) => {
  const { id, confirmed } = data;
  const resolver = pendingConfirmations.get(id);
  if (resolver) {
    pendingConfirmations.delete(id);
    resolver(confirmed);
  }
  return { success: true };
});

// Handle deeplink (cobrabot://connect?token=xxx)
app.setAsDefaultProtocolClient('cobrabot');

app.on('open-url', (event, url) => {
  event.preventDefault();
  
  const parsedUrl = new URL(url);
  if (parsedUrl.hostname === 'connect') {
    const token = parsedUrl.searchParams.get('token');
    if (token) {
      store.set('token', token);
      if (mainWindow) {
        mainWindow.webContents.send('auto-connect', { token });
        mainWindow.show();
      }
      connectToGateway(token);
    }
  }
});

// App lifecycle
app.whenReady().then(() => {
  createWindow();
  createTray();
  
  // Auto-connect if token saved
  const savedToken = store.get('token');
  if (savedToken) {
    mainWindow.webContents.on('did-finish-load', () => {
      mainWindow.webContents.send('auto-connect', { token: savedToken });
      connectToGateway(savedToken);
    });
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});
