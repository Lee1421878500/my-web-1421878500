'use strict';

/**
 * Live Client Data API（游戏内实时数据）
 *
 * Riot 官方公开接口：https://127.0.0.1:2999/liveclientdata/allgamedata
 * 仅在「游戏进行中」可用（选人阶段没有），免认证，自签名证书。
 *
 * 用于进入游戏后确认当前英雄 —— 海克斯大乱斗的强化符文是在游戏内刷的，
 * 此时客户端选人接口已经失效，只能靠这个接口拿英雄。
 */

const https = require('https');
const http = require('http');

const HOST = '127.0.0.1';
const PORT = 2999;

function rawRequest(useHttps, pathname, timeout = 3000) {
  return new Promise((resolve, reject) => {
    const lib = useHttps ? https : http;
    const req = lib.request({
      host: HOST, port: PORT, path: pathname, method: 'GET',
      rejectUnauthorized: false, timeout
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error('HTTP ' + res.statusCode));
        try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.end();
  });
}

/** 兼容处理：官方是 https，个别版本/代理下 http 也可用 */
async function apiGet(pathname) {
  try {
    return await rawRequest(true, pathname);
  } catch (e) {
    return await rawRequest(false, pathname);
  }
}

/**
 * 取当前玩家英雄
 * 返回 { championName, gameMode, gameTime, myTeam:[], theirTeam:[] } 或 null
 */
async function getLiveState() {
  let all;
  try {
    all = await apiGet('/liveclientdata/allgamedata');
  } catch (e) {
    return null;   // 不在游戏中（端口未监听）
  }

  const active = all.activePlayer || {};
  const players = all.allPlayers || [];

  // 用 riotId / riotIdGameName / summonerName 三种标识匹配自己
  const myId = active.riotId || '';
  const myName = active.riotIdGameName || active.summonerName || '';

  const me = players.find(p =>
    (myId && p.riotId === myId) ||
    (myName && p.riotIdGameName === myName) ||
    (myName && p.summonerName === myName)
  );

  const gameData = all.gameData || {};

  return {
    championName: me ? me.championName : null,   // 英文 id，与 Data Dragon 一致
    gameMode: gameData.gameMode || '',
    gameTime: gameData.gameTime || 0,
    mapName: gameData.mapName || '',
    myTeam: players.filter(p => p.team === (me ? me.team : 'ORDER'))
      .map(p => ({ championName: p.championName, riotId: p.riotId || p.summonerName, isMe: p === me })),
    theirTeam: players.filter(p => p.team !== (me ? me.team : 'ORDER'))
      .map(p => ({ championName: p.championName, riotId: p.riotId || p.summonerName }))
  };
}

/** 快速探活：游戏是否在进行 */
async function isInGame() {
  try {
    await apiGet('/liveclientdata/gamestats');
    return true;
  } catch (e) {
    return false;
  }
}

module.exports = { getLiveState, isInGame };
