#!/usr/bin/env node
/**
 * VLESS + WebSocket 代理服务器（纯 Node.js 实现）
 *
 * 用法:
 *   1) 生成密钥对:  node gen-keypair.js
 *   2) 启动:        node server.js
 *
 * 客户端需要:
 *   - VLESS UUID:  从 gen-keypair.js 输出
 *   - 服务器地址:   你的域名或 IP
 *   - 端口:        43987 (或配置 PORT / WS_PORT)
 *   - 传输:        ws
 *   - TLS:         如前面有 Cloudflare 橙云则不需要本地 TLS
 *   - WS Path:     默认 /vless-node
 *
 * 环境变量 (可选):
 *   PORT        监听端口 (PaaS 注入优先, 例如 Pterodactyl/Render)
 *   WS_PORT     监听端口 (默认 43987)
 *   WS_PATH     WebSocket 路径 (默认 /vless-node)
 *   BIND        绑定地址 (默认 0.0.0.0)
 *   TLS_CERT    TLS 证书路径 (可选, 例如 ./cert.pem)
 *   TLS_KEY     TLS 私钥路径 (可选, 例如 ./key.pem)
 *   TLS_SNI     TLS server name (可选)
 */

'use strict';

const http = require('http');
const https = require('https');
const net = require('net');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

// ============ 加载 .env 文件 ============
// Pterodactyl / Render / Fly 等平台把环境变量写进 .env，
// Node.js 不会自动读，这里手动加载 (零依赖)。
// 优先级: 已存在的环境变量 > .env 文件 (不覆盖系统注入)
(function loadEnv() {
  const candidates = [
    path.resolve(process.cwd(), '.env'),
    path.resolve(__dirname, '.env'),
  ];
  for (const file of candidates) {
    let content;
    try { content = fs.readFileSync(file, 'utf8'); }
    catch (e) { continue; }
    for (const rawLine of content.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq < 1) continue;
      let key = line.slice(0, eq).trim();
      let val = line.slice(eq + 1).trim();
      // 去引号
      if ((val.startsWith('"') && val.endsWith('"')) ||
          (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      // 不覆盖已有值
      if (key && !(key in process.env)) {
        process.env[key] = val;
      }
    }
  }
})();

// ============ 配置 ============
// 端口优先级: PORT (Pterodactyl/Render/Fly 等 PaaS 注入) > WS_PORT (手动指定) > 43987
const PORT = parseInt(process.env.PORT || process.env.WS_PORT || '43987', 10);
const PATH = process.env.WS_PATH || '/vless-node';
const BIND = process.env.BIND || '0.0.0.0';

// VLESS UUID - 必须是你自己 gen-keypair 生成的
// VLESS 协议中 UUID 是 16 字节原始二进制 (不是 sha256 哈希)
const VLESS_UUID = process.env.VLESS_UUID || '';
const VLESS_UUID_RAW = uuidToRawBytes(VLESS_UUID);

const TLS_CERT = process.env.TLS_CERT || '';
const TLS_KEY = process.env.TLS_KEY || '';
const TLS_SNI = process.env.TLS_SNI || '';

// ============ 工具函数 ============
/**
 * 把 UUID 字符串转成 16 字节二进制
 * 例如 "2233e21c-7854-4b63-a327-8070b141a67d" -> Buffer(16 bytes)
 */
function uuidToRawBytes(uuid) {
  if (!uuid || !/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(uuid)) {
    return null;
  }
  const hex = uuid.replace(/-/g, '');
  if (hex.length !== 32) return null;
  return Buffer.from(hex, 'hex');
}

// ============ 日志 ============
function log(...args) {
  console.log('[vless-ws]', new Date().toISOString(), ...args);
}
function err(...args) {
  console.error('[vless-ws:err]', new Date().toISOString(), ...args);
}

// ============ 前置检查 ============
function preflight() {
  const problems = [];
  if (!VLESS_UUID || VLESS_UUID.length !== 36) {
    problems.push('VLESS_UUID 未配置或不合法 (应为 36 字符 UUID 格式)。运行: node gen-keypair.js');
  }
  if (!VLESS_UUID_RAW) {
    problems.push('VLESS_UUID 解析失败, 请检查 UUID 格式 (8-4-4-4-12 hex)');
  }
  if ((TLS_CERT && !TLS_KEY) || (TLS_KEY && !TLS_CERT)) {
    problems.push('TLS_CERT 和 TLS_KEY 必须同时配置, 或同时不配置');
  }
  if (TLS_CERT) {
    try { fs.accessSync(TLS_CERT, fs.constants.R_OK); }
    catch (e) { problems.push('TLS_CERT 文件不存在: ' + TLS_CERT); }
  }
  if (TLS_KEY) {
    try { fs.accessSync(TLS_KEY, fs.constants.R_OK); }
    catch (e) { problems.push('TLS_KEY 文件不存在: ' + TLS_KEY); }
  }
  if (problems.length) {
    err('启动失败:');
    problems.forEach(p => err('  - ' + p));
    process.exit(1);
  }
}

// ============ VLESS 协议解析 ============
/**
 * 解析 VLESS 请求头 (Xray-Proxy Protocol V1)
 * @param {Buffer} buf 头 + 剩余负载
 * @param {string} proto 'tcp'|'udp'|'http'|'https'
 * @returns {{target, payload}} | null
 */
function parseVlessRequest(buf, proto) {
  if (buf.length < 31) return null;
  if (buf[0] !== 0x00) return null;
  // version 0x00
  const uuid = buf.subarray(1, 17);
  if (!VLESS_UUID_RAW || !uuid.equals(VLESS_UUID_RAW)) return null;

  const ipVer = buf[17];
  let ipOffset, ipLen;
  if (ipVer === 1) {
    ipOffset = 18; ipLen = 4;
  } else if (ipVer === 2) {
    ipOffset = 18; ipLen = 16;
  } else {
    return null;
  }
  if (buf.length < ipOffset + ipLen + 2) return null;

  const ipAddr = buf.subarray(ipOffset, ipOffset + ipLen).toString('hex');
  const ip = ipVer === 1 ? ipAddr.match(/../g).join('.') : ipv6Short(ipAddr);
  const port = buf.readUInt16BE(ipOffset + ipLen);
  const cmd = buf[ipOffset + ipLen + 2];
  if (cmd !== 1) return null;

  // 读 len
  let offset = ipOffset + ipLen + 3;
  if (buf.length < offset + 2) return null;
  const len = buf.readUInt16BE(offset);
  offset += 2;
  if (buf.length < offset + len) return null;

  const addr = buf.subarray(offset, offset + len).toString('utf8');
  offset += len;
  // XRay 扩展部分 (通常 0 字节)
  let extLen = 0;
  if (offset < buf.length) extLen = buf.readUInt16BE(offset);
  offset += 2 + extLen;

  const payload = buf.subarray(offset);

  // 目标地址选择:
  // - IPv4/IPv6 字段是真实地址 -> 用之
  // - IPv4 字段全 0 (0.0.0.0) -> 用 addr 字段 (通常包含真实域名或 IP)
  // - IPv6 字段全 0 (0000:...) -> 用 addr 字段
  let target;
  if (ipVer === 1) {
    const ipv4IsZero = (buf[ipOffset] === 0 && buf[ipOffset + 1] === 0 &&
                        buf[ipOffset + 2] === 0 && buf[ipOffset + 3] === 0);
    if (ipv4IsZero) {
      target = addr || ip;
    } else {
      target = ip;
    }
  } else if (ipVer === 2) {
    // IPv6: 检查是否全零
    const ipv6IsZero = buf.slice(ipOffset, ipOffset + 16).equals(Buffer.alloc(16));
    if (ipv6IsZero) {
      target = addr || ip;
    } else {
      target = ip;
    }
  } else {
    target = addr || ip;
  }

  return {
    target,
    port,
    payload,
    protocol: proto
  };
}

function ipv6Short(hex) {
  // 把 hex IPv6 转成标准表示
  try {
    const groups = hex.match(/..../g);
    return groups.join(':');
  } catch (e) {
    return hex;
  }
}

// ============ 目标连接 ============
/**
 * 处理整个 WS 连接的生命周期:
 * 1. 接收第一个 message, 解析 VLESS 头
 * 2. 建立到目标的 TCP 连接
 * 3. 转发后续数据 (双向)
 *
 * @param {WebSocket} ws WS 连接
 * @param {function} logFn 日志函数
 */
function setupTarget(ws, logFn) {
  let socket = null;
  let ready = false;
  let reqBuf = Buffer.alloc(0);

  function onMessage(data) {
    if (typeof data === 'string') data = Buffer.from(data, 'utf8');
    if (!Buffer.isBuffer(data)) return;

    if (!ready) {
      // 还没解析过 VLESS 头, 累积数据直到能解析
      reqBuf = Buffer.concat([reqBuf, data]);
      const parsed = parseVlessRequest(reqBuf, 'tcp');
      if (!parsed) {
        // 数据太少, 等下一个 message; 太多就报错
        if (reqBuf.length > 4096) {
          err('VLESS 请求解析失败, 累计 ' + reqBuf.length + ' 字节');
          ws.close(1008, 'bad vless req');
          if (socket) socket.destroy();
          return;
        }
        return;
      }
      ready = true;
      logFn('解析成功 ->', parsed.target + ':' + parsed.port, 'payload=' + (parsed.payload ? parsed.payload.length : 0) + 'B');

      // 建立 TCP 连接
      socket = net.createConnection({ host: parsed.target, port: parsed.port, family: 0 });

      // 目标 -> 客户端
      socket.on('data', (chunk) => {
        if (ws.readyState === ws.OPEN) {
          ws.send(chunk, { binary: true });
        }
      });
      socket.on('error', (e) => {
        err('目标连接错误', parsed.target + ':' + parsed.port, e.message);
        try { ws.close(1011, 'target error'); } catch (_) {}
      });
      socket.on('close', () => {
        try { ws.close(1000, 'target closed'); } catch (_) {}
      });

      // 把第一个 message 的 payload 发过去
      if (parsed.payload && parsed.payload.length) {
        socket.write(parsed.payload);
      }
      reqBuf = Buffer.alloc(0);
    } else {
      // 已解析, 直接转发后续数据
      if (socket && socket.writable) {
        socket.write(data);
      }
    }
  }

  ws.on('message', onMessage);

  return {
    destroy: () => { if (socket) socket.destroy(); }
  };
}

// ============ UDP 支持 ============
/**
 * VLESS over WS 不支持真正的 UDP datagram 路由 (因为 WS 是流式),
 * 所以 UDP 我们走 TCP 兼容模式 (Xray 默认), 这里简单返回。
 */
function handleUdp(ws) {
  // 简化: 直接关
  ws.close(1001, 'udp not supported in this implementation');
}

// ============ HTTP/WebSocket 服务器 ============
function startServer() {
  let server, wss;

  if (TLS_CERT && TLS_KEY) {
    // 带 TLS 的模式 (自签或自有证书)
    const tlsOpts = {
      cert: fs.readFileSync(TLS_CERT),
      key: fs.readFileSync(TLS_KEY),
      servername: TLS_SNI
    };
    server = https.createServer(tlsOpts, handleHttp);
  } else {
    server = http.createServer(handleHttp);
  }

  wss = new WebSocketServer({
    server,
    path: PATH,
    maxPayload: 16 * 1024 * 1024, // 16MB
    handleProtocols: () => true
  });

  wss.on('connection', (ws, req) => {
    const ua = req.headers['user-agent'] || '';
    log('新连接', req.socket.remoteAddress, 'ua=' + ua.slice(0, 40));

    // setupTarget 接管整个 WS 生命周期:
    //   - 解析第一个 message 的 VLESS 头
    //   - 建立到目标的 TCP 连接
    //   - 双向转发数据
    const controller = setupTarget(ws, log);

    ws.on('close', (code, reason) => {
      log('连接关闭', code, reason.toString().slice(0, 50));
      controller.destroy();
    });

    ws.on('error', (e) => {
      err('WS 错误', e.message);
      controller.destroy();
    });
  });

  server.listen(PORT, BIND, () => {
    log('========================================');
    log('VLESS + WS 代理服务器已启动');
    log('  监听:       ' + BIND + ':' + PORT);
    log('  WS Path:    ' + PATH);
    log('  TLS:        ' + (TLS_CERT ? 'on (' + TLS_SNI + ')' : 'off'));
    log('  UUID:       ' + VLESS_UUID);
    log('========================================');
  });
  server.on('error', (e) => {
    err('服务器错误', e.message);
    process.exit(1);
  });
}

function handleHttp(req, res) {
  // HTTP 请求: 返回健康检查页面 (非 WS 升级请求)
  if (req.method === 'GET' && req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('vless-ws-node proxy is running.\nWS path: ' + PATH + '\n');
    return;
  }
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, uuid: VLESS_UUID, path: PATH }));
    return;
  }
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('not found');
}

// ============ 入口 ============
preflight();
startServer();
