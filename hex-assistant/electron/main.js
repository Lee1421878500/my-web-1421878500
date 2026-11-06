'use strict';

const { app, BrowserWindow, ipcMain, globalShortcut, Tray, Menu, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const { LcuClient } = require('./lcu');
const live = require('./live');

let win = null;
let tray = null;
let lcu = null;
let lcuLoopTimer = null;
let liveTimer = null;
let acceptTimer = null;

/* ═══════════════ 设置持久化 ═══════════════ */

const defaultSettings = {
  autoAccept: false,
  acceptMinDelay: 600,
  acceptMaxDelay: 1500,
  clickThrough: false,
  opacity: 0.97,
  bounds: { width: 1180, height: 800 }
};

let settings = { ...defaultSettings };

function settingsPath() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function loadSettings() {
  try {
    const raw = fs.readFileSync(settingsPath(), 'utf8');
    settings = { ...defaultSettings, ...JSON.parse(raw) };
  } catch (e) { /* 首次运行 */ }
}

function saveSettings() {
  try { fs.writeFileSync(settingsPath(), JSON.stringify(settings, null, 2)); } catch (e) { /* ignore */ }
}

/* ═══════════════ 运行时状态 ═══════════════ */

const state = {
  lcuConnected: false,
  lcuSource: '',
  phase: 'Offline',
  phaseText: '未连接客户端',
  championId: null,        // LCU 数字 ID
  championName: null,      // Data Dragon 英文 ID（游戏内来源）
  championSource: '',      // 'champ-select' | 'live' | ''
  inGame: false,
  autoAccept: false,
  acceptCount: 0,
  lastAcceptAt: null,
  clickThrough: false,
  autoAcceptBusy: false,
  message: '',
  gameMode: ''
};

function pushState() {
  if (win && !win.isDestroyed()) {
    win.webContents.send('hex:state', { ...state, settings });
  }
  updateTray();
}

function log(...args) {
  console.log('[hex]', ...args);
}

const PHASE_TEXT = {
  None: '客户端空闲',
  Lobby: '房间中',
  Matchmaking: '匹配中',
  ReadyCheck: '等待接受对局',
  ChampSelect: '英雄选择中',
  InProgress: '游戏中',
  WaitingForStats: '结算中',
  EndOfGame: '对局结束',
  Offline: '未连接客户端'
};

/* ═══════════════ 窗口 ═══════════════ */

function createWindow() {
  const b = settings.bounds || defaultSettings.bounds;

  win = new BrowserWindow({
    width: b.width,
    height: b.height,
    x: b.x,
    y: b.y,
    minWidth: 760,
    minHeight: 520,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    alwaysOnTop: true,
    fullscreenable: false,
    skipTaskbar: false,
    show: false,
    title: '海克斯大乱斗助手',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  // 盖在游戏（无边框窗口模式）之上
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  win.loadFile(path.join(__dirname, '..', 'index.html'));

  win.once('ready-to-show', () => {
    win.show();
    win.setOpacity(settings.opacity);
    if (settings.clickThrough) setClickThrough(true);
    pushState();
  });

  win.on('close', () => {
    saveBounds();
    saveSettings();
  });

  win.on('closed', () => { win = null; });

  if (process.argv.includes('--dev')) win.webContents.openDevTools({ mode: 'detach' });
}

function saveBounds() {
  if (!win || win.isDestroyed()) return;
  const b = win.getBounds();
  settings.bounds = { width: b.width, height: b.height, x: b.x, y: b.y };
}

function setClickThrough(on) {
  state.clickThrough = on;
  settings.clickThrough = on;
  saveSettings();
  if (!win || win.isDestroyed()) return;
  if (on) {
    // forward:true 让鼠标事件穿透到下层（游戏），不挡住操作
    win.setIgnoreMouseEvents(true, { forward: true });
    win.setAlwaysOnTop(true, 'screen-saver');
  } else {
    win.setIgnoreMouseEvents(false);
    win.focus();
  }
  pushState();
}

/* ═══════════════ 托盘 ═══════════════ */

function createTray() {
  // 托盘失败不影响主功能（部分系统对空图标支持不佳）
  try {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><text y="13" font-size="14">⬢</text></svg>`;
    let icon = nativeImage.createFromDataURL('data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64'));
    if (!icon || icon.isEmpty()) return;   // 拿不到图标就跳过托盘

    tray = new Tray(icon);
    tray.setToolTip('海克斯大乱斗助手');
    updateTray();
    tray.on('click', () => {
      if (!win) return createWindow();
      win.isVisible() ? win.hide() : win.show();
    });
  } catch (e) {
    console.log('[hex] 托盘创建失败（不影响使用）:', e.message);
    tray = null;
  }
}

function updateTray() {
  if (!tray || !tray.setContextMenu) return;
  const menu = Menu.buildFromTemplate([
    { label: `状态：${state.phaseText}`, enabled: false },
    { label: `自动识别：${state.championId || state.championName || '—'}`, enabled: false },
    { type: 'separator' },
    {
      label: `自动接受对局 ${state.autoAccept ? '✓ 已开启' : '（关闭）'}`,
      click: () => toggleAutoAccept()
    },
    {
      label: `鼠标穿透 ${state.clickThrough ? '✓ 已开启' : '（关闭）'}`,
      click: () => setClickThrough(!state.clickThrough)
    },
    { type: 'separator' },
    { label: '显示窗口', click: () => { if (win) { win.show(); win.focus(); } } },
    { label: '退出', click: () => { app.isQuitting = true; app.quit(); } }
  ]);
  tray.setContextMenu(menu);
}

/* ═══════════════ 自动接受对局 ═══════════════ */

function toggleAutoAccept(force) {
  state.autoAccept = typeof force === 'boolean' ? force : !state.autoAccept;
  settings.autoAccept = state.autoAccept;
  saveSettings();
  if (!state.autoAccept && acceptTimer) {
    clearTimeout(acceptTimer);
    acceptTimer = null;
    state.autoAcceptBusy = false;
  }
  log('自动接受对局 =>', state.autoAccept);
  pushState();
  return state.autoAccept;
}

function handleReadyCheck(data) {
  if (!data || data.state !== 'InProgress') {
    // 对局确认结束（已接受/已超时），清掉挂起的定时器
    if (acceptTimer) { clearTimeout(acceptTimer); acceptTimer = null; }
    state.autoAcceptBusy = false;
    return;
  }
  if (data.playerResponse && data.playerResponse !== 'None') return;  // 已响应过
  if (!state.autoAccept) return;
  if (acceptTimer) return;   // 已排队等待

  const min = Math.max(0, settings.acceptMinDelay ?? 600);
  const max = Math.max(min, settings.acceptMaxDelay ?? 1500);
  const delay = min + Math.floor(Math.random() * (max - min + 1));

  state.autoAcceptBusy = true;
  pushState();
  log(`检测到对局确认，${delay}ms 后自动接受`);

  acceptTimer = setTimeout(async () => {
    acceptTimer = null;
    try {
      await lcu.acceptReadyCheck();
      state.acceptCount += 1;
      state.lastAcceptAt = Date.now();
      state.autoAcceptBusy = false;
      state.message = '已自动接受对局';
      log('已自动接受对局，累计', state.acceptCount);
    } catch (e) {
      state.autoAcceptBusy = false;
      state.message = '自动接受失败：' + e.message;
      log('自动接受失败', e.message);
    }
    pushState();
  }, delay);
}

/* ═══════════════ LCU 连接与状态同步 ═══════════════ */

function initLcu() {
  lcu = new LcuClient();

  lcu.on('status', info => {
    state.lcuConnected = !!info.connected;
    state.lcuSource = info.source || '';
    if (!info.connected) {
      state.phase = 'Offline';
      state.phaseText = PHASE_TEXT.Offline;
      state.championId = null;
      state.championSource = '';
      if (!info.reason) state.message = '';
    } else {
      state.message = '';
    }
    pushState();
  });

  lcu.on('warn', msg => log('warn:', msg));

  lcu.on('event', ev => {
    // 对局确认
    if (ev.event === 'OnJsonApiEvent_lol-matchmaking_v1_ready-check') {
      handleReadyCheck(ev.data);
    }
    // 游戏流程阶段
    if (ev.event === 'OnJsonApiEvent_lol-gameflow_v1_gameflow-phase') {
      applyPhase(ev.data);
    }
    // 选人阶段阵容变化（换英雄会触发）
    if (ev.event === 'OnJsonApiEvent_lol-champ-select_v1_session' && ev.data) {
      const cell = (ev.data.myTeam || []).find(m => m.cellId === ev.data.localPlayerCellId);
      if (cell) {
        const cid = cell.championId || cell.championPickIntent || null;
        if (cid && cid !== state.championId) {
          state.championId = cid;
          state.championName = null;
          state.championSource = 'champ-select';
          log('选人阶段英雄更新 championId=', cid);
          pushState();
        }
      }
    }
  });
}

function applyPhase(phase) {
  if (typeof phase !== 'string') return;
  const changed = state.phase !== phase;
  state.phase = phase;
  state.phaseText = PHASE_TEXT[phase] || phase;
  const nowInGame = phase === 'InProgress';
  if (nowInGame !== state.inGame) {
    state.inGame = nowInGame;
    if (nowInGame) startLivePoll(); else stopLivePoll();
  }
  if (changed) {
    log('游戏阶段 =>', phase);
    // 进选人阶段立即同步一次
    if (phase === 'ChampSelect') syncChampSelect();
  }
  pushState();
}

async function syncChampSelect() {
  if (!lcu || !lcu.connected) return;
  try {
    const cid = await lcu.getChampSelectChampionId();
    if (cid && cid !== state.championId) {
      state.championId = cid;
      state.championName = null;
      state.championSource = 'champ-select';
      pushState();
    }
  } catch (e) { /* ignore */ }
}

function startLivePoll() {
  stopLivePoll();
  const tick = async () => {
    const s = await live.getLiveState();
    if (s && s.championName) {
      const changed = state.championName !== s.championName;
      state.championName = s.championName;
      state.championId = null;
      state.championSource = 'live';
      state.gameMode = s.gameMode || '';
      if (changed) log('游戏内英雄 =>', s.championName, '模式', s.gameMode);
      pushState();
    }
  };
  tick();
  liveTimer = setInterval(tick, 5000);
}

function stopLivePoll() {
  if (liveTimer) { clearInterval(liveTimer); liveTimer = null; }
}

async function lcuLoop() {
  if (!lcu) return;
  try {
    if (!lcu.connected) {
      await lcu.connect();
    } else {
      const phase = await lcu.getPhase().catch(() => null);
      if (phase) {
        applyPhase(phase);
        if (phase === 'ChampSelect') await syncChampSelect();
      }
    }
  } catch (e) {
    state.lcuConnected = false;
  }
  pushState();
  lcuLoopTimer = setTimeout(lcuLoop, 2500);
}

/* ═══════════════ IPC ═══════════════ */

function registerIpc() {
  ipcMain.handle('hex:get-state', () => ({ ...state, settings }));

  ipcMain.handle('hex:toggle-auto-accept', (_e, force) => toggleAutoAccept(force));

  ipcMain.handle('hex:toggle-click-through', (_e, force) => {
    setClickThrough(typeof force === 'boolean' ? force : !state.clickThrough);
    return state.clickThrough;
  });

  ipcMain.handle('hex:set-opacity', (_e, value) => {
    const v = Math.min(1, Math.max(0.35, Number(value) || 0.97));
    settings.opacity = v;
    saveSettings();
    if (win && !win.isDestroyed()) win.setOpacity(v);
    return v;
  });

  ipcMain.handle('hex:set-accept-delay', (_e, min, max) => {
    settings.acceptMinDelay = Math.max(0, Number(min) || 0);
    settings.acceptMaxDelay = Math.max(settings.acceptMinDelay, Number(max) || settings.acceptMinDelay);
    saveSettings();
    return { min: settings.acceptMinDelay, max: settings.acceptMaxDelay };
  });

  ipcMain.handle('hex:reconnect', async () => {
    if (lcu) { lcu.close(); lcu.closedByUser = false; }
    state.lcuConnected = false;
    pushState();
    await lcu.connect();
    return state.lcuConnected;
  });

  ipcMain.on('hex:minimize', () => { if (win) win.minimize(); });
  ipcMain.on('hex:quit', () => { app.isQuitting = true; app.quit(); });
}

/* ═══════════════ 生命周期 ═══════════════ */

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) { win.show(); win.focus(); }
  });

  app.whenReady().then(() => {
    loadSettings();
    state.autoAccept = !!settings.autoAccept;
    state.clickThrough = !!settings.clickThrough;

    createWindow();
    createTray();
    initLcu();
    registerIpc();
    lcuLoop();

    // 全局热键
    globalShortcut.register('Control+Shift+H', () => setClickThrough(!state.clickThrough));
    globalShortcut.register('Control+Shift+A', () => toggleAutoAccept());
    globalShortcut.register('Control+Shift+Q', () => { app.isQuitting = true; app.quit(); });

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') { app.isQuitting = true; app.quit(); }
  });

  app.on('before-quit', () => {
    app.isQuitting = true;
    if (lcuLoopTimer) clearTimeout(lcuLoopTimer);
    if (acceptTimer) clearTimeout(acceptTimer);
    stopLivePoll();
    if (lcu) lcu.close();
    globalShortcut.unregisterAll();
    try { if (tray) tray.destroy(); } catch (e) { /* ignore */ }
  });
}
