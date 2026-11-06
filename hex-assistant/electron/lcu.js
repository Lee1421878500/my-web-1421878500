'use strict';

/**
 * LCU（League Client Update）客户端
 *
 * 凭据探测采用三级兜底，越靠前越可靠：
 *   1. 进程命令行  —— 不依赖安装路径，国服 WeGame 也能命中
 *   2. lockfile    —— 官方客户端标准位置
 *   3. 客户端日志   —— 命令行/文件都拿不到时的最后手段
 *
 * 注意：LCU 是本地 HTTPS 服务，使用自签名证书，必须 rejectUnauthorized:false。
 */

const https = require('https');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const { EventEmitter } = require('events');

const IS_WIN = process.platform === 'win32';
const IS_MAC = process.platform === 'darwin';

/* ═══════════════ 一、凭据探测 ═══════════════ */

function runCmd(cmd, timeout = 8000) {
  return new Promise(resolve => {
    exec(cmd, { timeout, windowsHide: true, maxBuffer: 1024 * 1024 }, (err, stdout) => {
      resolve(err ? '' : (stdout || ''));
    });
  });
}

function parseCredentials(text) {
  if (!text) return null;
  // 优先匹配命令行参数写法
  let m = /--app-port=(\d+)/.exec(text);
  let n = /--remoting-auth-token=([\w\-_]+)/.exec(text);
  if (m && n) return { port: parseInt(m[1], 10), password: n[1] };

  // lockfile 格式：LeagueClient:pid:port:password:protocol
  m = /^[^:]+:\d+:(\d+):([^:]+):/m.exec(text);
  if (m) return { port: parseInt(m[1], 10), password: m[2] };
  return null;
}

/** 方式 1：读取 LeagueClientUx 进程命令行 */
async function fromProcess() {
  let out = '';

  if (IS_WIN) {
    // PowerShell / CIM 比 wmic 更稳定（Win11 已弃用 wmic）
    out = await runCmd(
      'powershell -NoProfile -NonInteractive -Command ' +
      '"Get-CimInstance Win32_Process -Filter \\"name=\'LeagueClientUx.exe\'\\" | Select-Object -ExpandProperty CommandLine"'
    );
    if (!out.trim()) {
      // 兜底：老系统用 wmic
      out = await runCmd('wmic process where "name=\'LeagueClientUx.exe\'" get CommandLine /format:list');
    }
  } else if (IS_MAC) {
    out = await runCmd("ps -A -o command | grep -i 'LeagueClientUx' | grep -v grep");
  } else {
    out = await runCmd("ps -A -o command | grep -i 'LeagueClientUx' | grep -v grep");
  }

  const cred = parseCredentials(out);
  if (cred) return { ...cred, source: 'process' };
  return null;
}

/** 从进程可执行文件路径推导安装目录 */
async function guessInstallDir() {
  let exePath = '';

  if (IS_WIN) {
    exePath = await runCmd(
      'powershell -NoProfile -NonInteractive -Command ' +
      '"Get-CimInstance Win32_Process -Filter \\"name=\'LeagueClientUx.exe\'\\" | Select-Object -ExpandProperty ExecutablePath"'
    );
  } else if (IS_MAC) {
    exePath = await runCmd("ps -A -o command | grep -i 'LeagueClientUx' | grep -v grep");
    const m = /(\/[^\s]+\.app)/.exec(exePath);
    if (m) return path.join(m[1], 'Contents', 'LoL');
    return '';
  }

  exePath = exePath.trim();
  if (!exePath) return '';
  return path.dirname(exePath);
}

/** 方式 2：lockfile */
async function fromLockfile() {
  const candidates = [];

  const installDir = await guessInstallDir();
  if (installDir) candidates.push(path.join(installDir, 'lockfile'));

  if (IS_WIN) {
    candidates.push(
      'C:\\Riot Games\\League of Legends\\lockfile',
      'C:\\Program Files\\Riot Games\\League of Legends\\lockfile',
      'D:\\Riot Games\\League of Legends\\lockfile',
      'E:\\Riot Games\\League of Legends\\lockfile',
      // 国服 WeGame 常见位置
      'C:\\Program Files (x86)\\WeGame\\英雄联盟\\lockfile',
      'C:\\Program Files (x86)\\腾讯游戏\\英雄联盟\\lockfile',
      'D:\\WeGame\\英雄联盟\\lockfile',
      'D:\\腾讯游戏\\英雄联盟\\lockfile'
    );
  } else if (IS_MAC) {
    candidates.push('/Applications/League of Legends.app/Contents/LoL/lockfile');
  }

  for (const file of candidates) {
    try {
      if (!fs.existsSync(file)) continue;
      const text = fs.readFileSync(file, 'utf8');
      const cred = parseCredentials(text);
      if (cred) return { ...cred, source: 'lockfile:' + file };
    } catch (e) { /* 下一个 */ }
  }
  return null;
}

/** 方式 3：客户端日志（取最新一份，第一行含启动参数） */
async function fromLog() {
  const installDir = await guessInstallDir();
  if (!installDir) return null;

  const logDir = path.join(installDir, 'Logs', 'LeagueClient Logs');
  const logDirAlt = path.join(path.dirname(installDir), 'Logs', 'LeagueClient Logs');

  for (const dir of [logDir, logDirAlt]) {
    try {
      if (!fs.existsSync(dir)) continue;
      const files = fs.readdirSync(dir)
        .filter(f => f.endsWith('.log'))
        .map(f => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs }))
        .sort((a, b) => b.t - a.t);
      if (!files.length) continue;

      const text = fs.readFileSync(path.join(dir, files[0].f), 'utf8').slice(0, 4000);
      const cred = parseCredentials(text);
      if (cred) return { ...cred, source: 'log' };
    } catch (e) { /* 下一个 */ }
  }
  return null;
}

/** 综合探测 */
async function detectCredentials() {
  for (const fn of [fromProcess, fromLockfile, fromLog]) {
    try {
      const cred = await fn();
      if (cred && cred.port && cred.password) return cred;
    } catch (e) { /* 继续下一种 */ }
  }
  return null;
}

/* ═══════════════ 二、HTTPS 请求 ═══════════════ */

function lcuRequest(cred, method, endpoint, body) {
  return new Promise((resolve, reject) => {
    const auth = 'Basic ' + Buffer.from(`riot:${cred.password}`).toString('base64');
    const payload = body ? JSON.stringify(body) : null;

    const req = https.request({
      host: '127.0.0.1',
      port: cred.port,
      path: endpoint,
      method,
      rejectUnauthorized: false,
      timeout: 6000,
      headers: {
        'Authorization': auth,
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {})
      }
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          if (!data) return resolve(null);
          try { resolve(JSON.parse(data)); } catch (e) { resolve(data); }
        } else {
          reject(Object.assign(new Error(`HTTP ${res.statusCode}`), { status: res.statusCode }));
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('LCU 请求超时')); });
    if (payload) req.write(payload);
    req.end();
  });
}

/* ═══════════════ 三、WebSocket 事件订阅 ═══════════════ */

const OPCODE_SUBSCRIBE = 5; // OnJsonApiEvent

/* ═══════════════ 四、LCU 门面 ═══════════════ */

class LcuClient extends EventEmitter {
  constructor() {
    super();
    this.cred = null;
    this.ws = null;
    this.connected = false;
    this.reconnectTimer = null;
    this.closedByUser = false;
  }

  /** 尝试连接（可重复调用，用于轮询等待客户端启动） */
  async connect() {
    if (this.connected) return true;

    const cred = await detectCredentials();
    if (!cred) {
      this.emit('status', { connected: false, reason: '未找到英雄联盟客户端凭据（客户端可能未启动）' });
      return false;
    }

    // 用一次轻量请求验证凭据有效
    try {
      await lcuRequest(cred, 'GET', '/lol-gameflow/v1/gameflow-phase');
    } catch (e) {
      this.emit('status', { connected: false, reason: '凭据无效或客户端未就绪: ' + e.message });
      return false;
    }

    this.cred = cred;
    this.connected = true;
    this.emit('status', { connected: true, source: cred.source, port: cred.port });
    this.openWs();
    return true;
  }

  openWs() {
    let WebSocket;
    try { WebSocket = require('ws'); } catch (e) {
      this.emit('warn', 'ws 模块缺失，事件订阅不可用（回退轮询）');
      return;
    }
    if (!this.cred) return;

    const auth = 'Basic ' + Buffer.from(`riot:${this.cred.password}`).toString('base64');
    try {
      this.ws = new WebSocket(`wss://127.0.0.1:${this.cred.port}/`, {
        headers: { Authorization: auth },
        rejectUnauthorized: false
      });
    } catch (e) {
      this.emit('warn', 'WSS 建立失败: ' + e.message);
      return;
    }

    this.ws.on('open', () => {
      this.emit('ws', 'open');
      // 订阅关心的资源变化
      [
        'OnJsonApiEvent_lol-matchmaking_v1_ready-check',
        'OnJsonApiEvent_lol-gameflow_v1_gameflow-phase',
        'OnJsonApiEvent_lol-champ-select_v1_session',
        'OnJsonApiEvent_lol-gameflow_v1_session'
      ].forEach(evt => {
        try { this.ws.send(JSON.stringify([OPCODE_SUBSCRIBE, evt])); } catch (e) { /* ignore */ }
      });
    });

    this.ws.on('message', buf => {
      let msg;
      try { msg = JSON.parse(buf.toString()); } catch (e) { return; }
      // 格式：[5, "OnJsonApiEvent_xxx", { data, eventType, uri }]
      if (!Array.isArray(msg) || msg[0] !== OPCODE_SUBSCRIBE) return;
      const event = msg[1];
      const payload = msg[2];
      if (event && payload) this.emit('event', { event, ...payload });
    });

    this.ws.on('close', () => {
      this.emit('ws', 'close');
      if (this.closedByUser) return;
      this.connected = false;
      this.scheduleReconnect();
    });

    this.ws.on('error', () => { /* close 会接着触发 */ });
  }

  scheduleReconnect() {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      await this.connect();
    }, 5000);
  }

  close() {
    this.closedByUser = true;
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    try { if (this.ws) this.ws.close(); } catch (e) { /* ignore */ }
    this.ws = null;
    this.connected = false;
    this.cred = null;
  }

  /* ─── 便捷方法 ─── */

  get(endpoint) {
    if (!this.cred) return Promise.reject(new Error('LCU 未连接'));
    return lcuRequest(this.cred, 'GET', endpoint);
  }

  post(endpoint, body) {
    if (!this.cred) return Promise.reject(new Error('LCU 未连接'));
    return lcuRequest(this.cred, 'POST', endpoint, body);
  }

  /** 当前游戏阶段：None / Lobby / Matchmaking / ChampSelect / InProgress ... */
  async getPhase() {
    const p = await this.get('/lol-gameflow/v1/gameflow-phase');
    return typeof p === 'string' ? p : null;
  }

  /** 选人阶段的当前英雄 championId（数字） */
  async getChampSelectChampionId() {
    try {
      const s = await this.get('/lol-champ-select/v1/session');
      if (!s) return null;
      const cell = (s.myTeam || []).find(m => m.cellId === s.localPlayerCellId);
      if (!cell) return null;
      // 换英雄时 championId 会变；championPickIntent 是预选
      return cell.championId || cell.championPickIntent || null;
    } catch (e) {
      return null;
    }
  }

  /** 接受对局 */
  async acceptReadyCheck() {
    await this.post('/lol-matchmaking/v1/ready-check/accept', {});
  }

  /** 查询准备确认状态 */
  getReadyCheck() {
    return this.get('/lol-matchmaking/v1/ready-check').catch(() => null);
  }
}

module.exports = { LcuClient, detectCredentials, lcuRequest };
