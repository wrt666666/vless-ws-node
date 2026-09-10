#!/usr/bin/env node
/**
 * VLESS + WebSocket 测试客户端
 *
 * 用法:
 *   VLESS_UUID="2233e21c-7854-4b63-a327-8070b141a67d" node client.js
 *
 * 环境变量:
 *   VLESS_UUID       (必填) VLESS UUID
 *   TARGET_HOST      (默认 example.com)
 *   TARGET_PORT      (默认 443)
 *   PROXY_HOST       (默认 127.0.0.1)
 *   PROXY_PORT       (默认 8443)
 *   PROXY_PATH       (默认 /vless-node)
 */
'use strict';

const WebSocket = require('ws');
const dns = require('dns');
const net = require('net');

const UUID = process.env.VLESS_UUID || '';
const TARGET_HOST = process.env.TARGET_HOST || 'example.com';
const TARGET_PORT = parseInt(process.env.TARGET_PORT || '443', 10);
const PROXY_HOST = process.env.PROXY_HOST || '127.0.0.1';
const PROXY_PORT = parseInt(process.env.PROXY_PORT || '8443', 10);
const PROXY_PATH = process.env.PROXY_PATH || '/vless-node';

if (!UUID) {
  console.error('必须设置 VLESS_UUID 环境变量');
  process.exit(1);
}

function uuidToRawBytes(uuid) {
  const hex = uuid.replace(/-/g, '');
  return Buffer.from(hex, 'hex');
}

async function buildVlessRequest(host, port, payload) {
  const uuidBuf = uuidToRawBytes(UUID);
  if (!uuidBuf || uuidBuf.length !== 16) {
    throw new Error('UUID 格式错误');
  }

  // 解析目标 IP (用 A 记录简化, 实际生产用 AAAA 支持)
  const family = await dns.promises.lookup(host, { family: 4 });
  if (!family || !family.address) {
    throw new Error('DNS 解析失败: ' + host);
  }

  // 构造 VLESS 请求头
  // [version=0x00, uuid=16, ipver=1, ip=4, port=2, cmd=1, len=2, addr=len, ext=2(=0)]
  const header = Buffer.alloc(1 + 16 + 1 + 4 + 2 + 1 + 2 + 0 + 2);
  let offset = 0;
  header.writeUInt8(0x00, offset); offset += 1;        // version
  uuidBuf.copy(header, offset); offset += 16;           // uuid
  header.writeUInt8(1, offset); offset += 1;           // ipver=1 (IPv4)
  // IPv4
  const ipParts = family.address.split('.');
  header.writeUInt8(parseInt(ipParts[0]), offset); offset += 1;
  header.writeUInt8(parseInt(ipParts[1]), offset); offset += 1;
  header.writeUInt8(parseInt(ipParts[2]), offset); offset += 1;
  header.writeUInt8(parseInt(ipParts[3]), offset); offset += 1;
  header.writeUInt16BE(port, offset); offset += 2;     // port
  header.writeUInt8(1, offset); offset += 1;           // cmd=1 (TCP)
  header.writeUInt16BE(0, offset); offset += 2;        // len=0 (空 addr)
  // XRay ext (2 字节 = 0)
  // 实际上 VLESS 用 uint16 表示 ext 长度, 写 0 即可
  // 注意: 我们上面分配了 1+16+1+4+2+1+2+0+2 = 29 字节, 但 len 应该包含 addr 长度
  // 重新构造更清晰的版本
  return null;
}

function buildVlessRequestV2(host, port, payload) {
  const uuidBuf = uuidToRawBytes(UUID);
  // IPv4 地址转 4 字节
  const ipBuf = net.isIP(host) && net.isIP(host) === 4
    ? Buffer.from(host.split('.').map(Number))
    : null;

  // 简化: 用地址字符串 (不解析 IP)
  // 协议允许: 如果客户端发 IP, 就解析成 IP; 否则 addr 字段是域名
  // 但代理服务端需要 IP 才能 connect, 所以我们这里用 IP
  //
  // 实际上 VLESS 客户端 (XRay) 在连接代理时会把目标域名直接放 addr 字段,
  // 服务端代理自己负责解析。我们的服务端实现里 parseVlessRequest 返回 target=addr,
  // 然后 connectToTarget(target, ...) 由 Node.js net 模块解析域名。
  //
  // 所以这里我们可以直接填域名, 不需要 DNS 解析。

  const addr = host;
  const addrBuf = Buffer.from(addr, 'utf8');

  const total = 1 + 16 + 1 + 4 + 2 + 1 + 2 + addrBuf.length + 2;
  const header = Buffer.alloc(total);
  let offset = 0;
  header.writeUInt8(0x00, offset); offset += 1;
  uuidBuf.copy(header, offset); offset += 16;
  header.writeUInt8(1, offset); offset += 1;  // IPv4
  // IPv4 占位, 因为客户端不知道实际 IP, 填 0.0.0.0
  header.writeUInt8(0, offset); offset += 1;
  header.writeUInt8(0, offset); offset += 1;
  header.writeUInt8(0, offset); offset += 1;
  header.writeUInt8(0, offset); offset += 1;
  header.writeUInt16BE(port, offset); offset += 2;
  header.writeUInt8(1, offset); offset += 1;  // cmd=1 TCP
  header.writeUInt16BE(addrBuf.length, offset); offset += 2;
  addrBuf.copy(header, offset); offset += addrBuf.length;
  header.writeUInt16BE(0, offset); offset += 2;  // ext len = 0

  const req = Buffer.concat([header, payload]);
  return req;
}

async function main() {
  console.log('VLESS-WS 测试客户端');
  console.log('  UUID:', UUID);
  console.log('  代理:', PROXY_HOST + ':' + PROXY_PORT + PROXY_PATH);
  console.log('  目标:', TARGET_HOST + ':' + TARGET_PORT);
  console.log('');

  const wsUrl = 'ws://' + PROXY_HOST + ':' + PROXY_PORT + PROXY_PATH;
  const ws = new WebSocket(wsUrl);

  ws.on('open', () => {
    console.log('[客户端] WS 连接已建立');
    const payload = Buffer.from('GET / HTTP/1.1\r\nHost: ' + TARGET_HOST + '\r\nConnection: close\r\n\r\n');
    const req = buildVlessRequestV2(TARGET_HOST, TARGET_PORT, payload);
    console.log('[客户端] 发送 VLESS 请求, 总长度=' + req.length + ' 字节');
    ws.send(req, { binary: true });
  });

  let buf = Buffer.alloc(0);
  ws.on('message', (data) => {
    if (typeof data === 'string') data = Buffer.from(data, 'utf8');
    buf = Buffer.concat([buf, data]);
    // 限制输出
    if (buf.length > 4096) {
      console.log('[响应前 4096 字节]:');
      console.log(buf.toString('utf8', 0, Math.min(buf.length, 4096)));
      buf = Buffer.alloc(0);
    }
  });

  ws.on('close', (code, reason) => {
    console.log('');
    console.log('[客户端] WS 关闭, code=' + code + ', reason=' + reason.toString());
    if (buf.length > 0) {
      console.log('');
      console.log('[完整响应]:');
      console.log(buf.toString('utf8'));
    }
    process.exit(0);
  });

  ws.on('error', (e) => {
    console.error('[客户端] 错误:', e.message);
    process.exit(1);
  });

  setTimeout(() => {
    console.log('[超时] 30 秒无响应, 退出');
    process.exit(2);
  }, 30000);
}

main().catch(e => {
  console.error('致命错误:', e);
  process.exit(1);
});
