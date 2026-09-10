#!/usr/bin/env node
/**
 * 生成 VLESS UUID
 * VLESS 用 UUID v4 作为用户身份, 32 字节 sha256 后比对
 *
 * 用法:  node gen-keypair.js
 * 输出:  UUID 值, 直接复制粘贴到 .env 或配置
 */
'use strict';

const crypto = require('crypto');

function uuidv4() {
  // 标准 UUID v4
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

const uuid = uuidv4();
console.log('========================================');
console.log('VLESS UUID 生成完成');
console.log('========================================');
console.log('');
console.log('UUID:  ' + uuid);
console.log('');
console.log('复制到 server.js 的 VLESS_UUID, 或导出环境变量:');
console.log('');
console.log('  VLESS_UUID=' + uuid);
console.log('');
console.log('Windows PowerShell:');
console.log('  $env:VLESS_UUID="' + uuid + '"');
console.log('  node server.js');
console.log('');
console.log('Linux / Mac:');
console.log('  export VLESS_UUID="' + uuid + '"');
console.log('  node server.js');
console.log('');
console.log('========================================');
console.log('客户端配置参考 (v2rayN / OpenClash / daed):');
console.log('========================================');
console.log('');
console.log('  协议:      VLESS');
console.log('  地址:      你的服务器 IP 或域名');
console.log('  端口:      8443 (默认)');
console.log('  UUID:      ' + uuid);
console.log('  加密:      none');
console.log('  传输:      ws');
console.log('  WS Path:   /vless-node');
console.log('  WS Host:   你的域名 (如有 TLS)');
console.log('  TLS:       如有 CF 橙云 / 自签证书');
console.log('  SNI:       你的域名');
console.log('========================================');
