const { app, BrowserWindow, Tray, Menu, ipcMain, shell } = require('electron');
const path = require('path');
const WebSocket = require('ws');
const Store = require('electron-store');
const screenshot = require('screenshot-desktop');
const { mouse, keyboard, Key } = require('@nut-tree-fork/nut-js');
const fs = require('fs');
const os = require('os');
const puppeteer = require('puppeteer-core');
const store = new Store();

let mainWindow = null;
let tray = null;
let ws = null;
let browserInstance = null;

// Gateway config
const GATEWAY_URL = 'ws://155.212.228.24:18790';

// Heartbeat config
const HEARTBEAT_INTERVAL = 30000;
const HEARTBEAT_TIMEOUT = 90000;
let heartbeatTimer = null;
let lastPongTime = null;
let missedHeartbeats = 0;

// Safety tiers
const SAFETY_TIERS = {
  safe: ['screenshot', 'ping', 'browser_navigate', 'browser_screenshot', 'browser_wait', 'mousemove', 'scroll'],
  moderate: ['exec', 'click', 'type', 'keypress', 'browser_click', 'browser_type', 'browser_launch', 'browser_evaluate'],
  dangerous: ['browser_close']
};

// Dangerous patterns for exec
const DANGEROUS_PATTERNS = [
  /^rm\s+/, /^rm\s+-rf/, /^sudo/, /^format/, /^mkfs/,
  /^dd\s+/, /^chmod\s+777/, /^chown/, /^>/,
  /\|\s*rm/, /\|\s*sudo/, /&&\s*rm/, /&&\s*sudo/
];

const pendingConfirmations = new Map();
let confirmationCounter = 0;

// Find Chrome/Edge executable on Windows
function findBrowserExecutable() {
  const possiblePaths = [
    // Chrome
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    process.env.LOCALAPPDATA + '\\Google\\Chrome\\Application\\chrome.exe',
    // Edge
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    // Brave
    'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
    // Vivaldi
    'C:\\Program Files\\Vivaldi\\Application\\vivaldi.exe',
  ];
  
  for (const browserPath of possiblePaths) {
    if (browserPath && fs.existsSync(browserPath)) {
      return browserPath;
    }
  }
  
  return null;
}

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
    { label: 'Статус: Отключено', id: 'status', enabled: false },
    { type: 'separator' },
    { label: 'Показать окно', click: () => mainWindow.show() },
    { label: 'Выйти', click: () => { app.isQuitting = true; app.quit(); } }
  ]);
  
  tray.setToolTip('CobraBot Desktop');
  tray.setContextMenu(contextMenu);
  tray.on('click', () => mainWindow.show());
}

// Connect to Gateway
function connectToGateway(token) {
  if (ws) ws.close();
  
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
    setTimeout(() => {
      if (store.get('token')) connectToGateway(store.get('token'));
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

function updateStatus(status, connected) {
  const statusItem = tray.menu.getMenuItemById('status');
  if (statusItem) statusItem.label = `Статус: ${status}`;
}

function startHeartbeat() {
  stopHeartbeat();
  lastPongTime = Date.now();
  missedHeartbeats = 0;
  
  heartbeatTimer = setInterval(() => {
    if (!ws || ws.readyState !== WebSocket.OPEN) { stopHeartbeat(); return; }
    const now = Date.now();
    if (now - lastPongTime > HEARTBEAT_TIMEOUT) {
      missedHeartbeats++;
      if (missedHeartbeats >= 3) { ws.close(); return; }
    }
    ws.send(JSON.stringify({ type: 'ping', timestamp: now }));
  }, HEARTBEAT_INTERVAL);
}

function stopHeartbeat() {
  if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
  missedHeartbeats = 0;
}

function checkSafetyTier(type, payload) {
  if (SAFETY_TIERS.safe.includes(type)) return { needsConfirmation: false };
  
  if (SAFETY_TIERS.moderate.includes(type)) {
    if (type === 'exec' && payload?.command) {
      for (const pattern of DANGEROUS_PATTERNS) {
        if (pattern.test(payload.command)) {
          return { needsConfirmation: true, tier: 'dangerous', message: '⚠️ Потенциально опасная команда', details: `Выполнить: \`${payload.command}\`?` };
        }
      }
    }
    return { needsConfirmation: false };
  }
  
  if (SAFETY_TIERS.dangerous.includes(type)) {
    return { needsConfirmation: true, tier: 'dangerous', message: '⚠️ Опасное действие', details: `Команда: ${type}` };
  }
  
  return { needsConfirmation: false };
}

async function handleCommand(message) {
  const { type, payload, requestId } = message;
  
  const safetyResult = checkSafetyTier(type, payload);
  if (safetyResult.needsConfirmation) {
    const confirmed = await requestConfirmation(safetyResult.message, safetyResult.details);
    if (!confirmed) {
      ws.send(JSON.stringify({ type: 'response', requestId, success: false, error: 'User denied' }));
      return;
    }
  }
  
  let result;
  
  switch (type) {
    case 'screenshot': result = await takeScreenshot(); break;
    case 'exec': result = await executeCommand(payload); break;
    case 'click': result = await performClick(payload); break;
    case 'type': result = await performType(payload); break;
    case 'keypress': result = await performKeyPress(payload); break;
    case 'mousemove': result = await performMouseMove(payload); break;
    case 'scroll': result = await performScroll(payload); break;
    case 'browser_launch': result = await browserLaunch(payload); break;
    case 'browser_navigate': result = await browserNavigate(payload); break;
    case 'browser_screenshot': result = await browserScreenshot(payload); break;
    case 'browser_click': result = await browserClick(payload); break;
    case 'browser_type': result = await browserType(payload); break;
    case 'browser_wait': result = await browserWait(payload); break;
    case 'browser_close': result = await browserClose(); break;
    case 'browser_evaluate': result = await browserEvaluate(payload); break;
    case 'ping': result = { success: true, pong: true }; break;
    default: result = { success: false, error: `Unknown command: ${type}` };
  }
  
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'response', requestId, ...result }));
  }
}

async function takeScreenshot() {
  try {
    const tmpDir = os.tmpdir();
    const filename = `screenshot-${Date.now()}.png`;
    const filepath = path.join(tmpDir, filename);
    await screenshot({ filename: filepath });
    const imageBuffer = fs.readFileSync(filepath);
    const base64 = imageBuffer.toString('base64');
    fs.unlinkSync(filepath);
    return { success: true, image: base64 };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

async function executeCommand(payload) {
  const { exec } = require('child_process');
  const { promisify } = require('util');
  const execAsync = promisify(exec);
  try {
    const { stdout, stderr } = await execAsync(payload.command, { timeout: 60000, maxBuffer: 1024 * 1024 });
    return { success: true, stdout, stderr };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

async function performClick(payload) {
  try {
    await mouse.setPosition({ x: payload.x, y: payload.y });
    await mouse.leftClick();
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

async function performType(payload) {
  try {
    await keyboard.type(payload.text);
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

async function performKeyPress(payload) {
  try {
    const keyMap = {
      'enter': Key.Enter, 'escape': Key.Escape, 'tab': Key.Tab,
      'backspace': Key.Backspace, 'delete': Key.Delete, 'space': Key.Space,
      'arrow_up': Key.Up, 'arrow_down': Key.Down, 'arrow_left': Key.Left, 'arrow_right': Key.Right
    };
    const mappedKey = keyMap[payload.key.toLowerCase()] || payload.key;
    await keyboard.pressKey(mappedKey);
    await keyboard.releaseKey(mappedKey);
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

async function performMouseMove(payload) {
  try {
    await mouse.setPosition({ x: payload.x, y: payload.y });
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

async function performScroll(payload) {
  try {
    const amount = payload.amount || 100;
    if (payload.direction === 'down') await mouse.scrollDown(amount);
    else if (payload.direction === 'up') await mouse.scrollUp(amount);
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// ============================================
// Browser Functions (puppeteer-core)
// ============================================

async function browserLaunch(payload) {
  try {
    if (browserInstance) {
      return { success: true, message: 'Browser already running' };
    }
    
    const executablePath = findBrowserExecutable();
    if (!executablePath) {
      return { success: false, error: 'No Chrome/Edge browser found. Please install Chrome or Edge.' };
    }
    
    browserInstance = await puppeteer.launch({
      executablePath,
      headless: false,
      defaultViewport: null,
      args: ['--start-maximized', '--no-sandbox', '--disable-setuid-sandbox']
    });
    
    return { success: true, browser: executablePath };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

async function browserNavigate(payload) {
  try {
    if (!browserInstance) return { success: false, error: 'Browser not launched' };
    
    let page = (await browserInstance.pages())[0];
    if (!page) page = await browserInstance.newPage();
    
    await page.goto(payload.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    return { success: true, title: await page.title() };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

async function browserScreenshot(payload) {
  try {
    if (!browserInstance) return { success: false, error: 'Browser not launched' };
    
    const page = (await browserInstance.pages())[0];
    if (!page) return { success: false, error: 'No page open' };
    
    const screenshot = await page.screenshot({ encoding: 'base64', fullPage: payload?.fullPage || false });
    return { success: true, image: screenshot };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

async function browserClick(payload) {
  try {
    if (!browserInstance) return { success: false, error: 'Browser not launched' };
    
    const page = (await browserInstance.pages())[0];
    if (!page) return { success: false, error: 'No page open' };
    
    await page.click(payload.selector);
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

async function browserType(payload) {
  try {
    if (!browserInstance) return { success: false, error: 'Browser not launched' };
    
    const page = (await browserInstance.pages())[0];
    if (!page) return { success: false, error: 'No page open' };
    
    await page.type(payload.selector, payload.text);
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

async function browserWait(payload) {
  try {
    if (!browserInstance) return { success: false, error: 'Browser not launched' };
    
    const page = (await browserInstance.pages())[0];
    if (!page) return { success: false, error: 'No page open' };
    
    await page.waitForSelector(payload.selector, { timeout: payload.timeout || 30000 });
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
    if (!browserInstance) return { success: false, error: 'Browser not launched' };
    
    const page = (await browserInstance.pages())[0];
    if (!page) return { success: false, error: 'No page open' };
    
    const result = await page.evaluate(payload.script);
    return { success: true, result };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// ============================================
// IPC Handlers
// ============================================

ipcMain.handle('connect', async (event, token) => {
  store.set('token', token);
  connectToGateway(token);
  return { success: true };
});

ipcMain.handle('disconnect', async () => {
  if (ws) ws.close();
  store.delete('token');
  return { success: true };
});

ipcMain.handle('get-status', async () => {
  return {
    connected: ws && ws.readyState === WebSocket.OPEN,
    token: store.get('token')
  };
});

ipcMain.handle('confirmation-response', async (event, { id, confirmed }) => {
  const resolve = pendingConfirmations.get(id);
  if (resolve) {
    pendingConfirmations.delete(id);
    resolve(confirmed);
  }
});

// Deep link handling
app.setAsDefaultProtocolClient('cobrabot');

app.on('open-url', (event, url) => {
  event.preventDefault();
  const parsedUrl = new URL(url);
  const token = parsedUrl.searchParams.get('token');
  if (token) {
    store.set('token', token);
    if (mainWindow) {
      mainWindow.webContents.send('token-from-deeplink', token);
    }
  }
});

// App lifecycle
app.whenReady().then(() => {
  createWindow();
  createTray();
  
  // Auto-connect if token exists
  const token = store.get('token');
  if (token) {
    connectToGateway(token);
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
