# VLESS + WebSocket Node.js 代理

纯 Node.js 实现的 VLESS 代理服务器, 适合在 **Host-Ship** (Pterodactyl) 或任何 Node.js 容器上部署。

## 文件结构

```
vless-ws-node/
├── server.js        # 主代理服务器
├── gen-keypair.js   # 生成 VLESS UUID
├── package.json     # npm 依赖
├── client.js        # 测试客户端
└── README.md
```

## 快速开始

### 1) 安装依赖

```bash
cd vless-ws-node
npm install
```

### 2) 生成 UUID

```bash
node gen-keypair.js
```

复制输出的 UUID, 例如 `2233e21c-7854-4b63-a327-8070b141a67d`。

### 3) 启动服务器

**方式 A: 直接配置**

编辑 `server.js`, 把 `VLESS_UUID` 改成你的 UUID。

```bash
node server.js
```

**方式 B: 环境变量 (推荐)**

```bash
# Linux / Mac
export VLESS_UUID="2233e21c-7854-4b63-a327-8070b141a67d"
node server.js

# Windows PowerShell
$env:VLESS_UUID="2233e21c-7854-4b63-a327-8070b141a67d"
node server.js
```

### 4) 测试

另开一个终端, 用测试客户端:

```bash
VLESS_UUID="2233e21c-7854-4b63-a327-8070b141a67d" node client.js
```

会尝试通过代理访问 `example.com:443`, 输出响应。

## 环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `WS_PORT` | `8443` | 监听端口 |
| `WS_PATH` | `/vless-node` | WebSocket 路径 |
| `BIND` | `0.0.0.0` | 绑定地址 |
| `VLESS_UUID` | (必填) | VLESS UUID |
| `TLS_CERT` | - | TLS 证书路径 (可选) |
| `TLS_KEY` | - | TLS 私钥路径 (可选) |
| `TLS_SNI` | - | TLS server name |

## 在 Host-Ship 部署

### 1) 创建服务器

1. 面板 → Create Server
2. 应用类型: **Node.js**
3. 资源: 1C / 1GB 即可
4. 申请一个入站端口 (如 `8443`)

### 2) 上传文件

通过面板 **Files** 页上传:

- `server.js`
- `package.json`

### 3) 配置启动

在 **Settings → Startup**:

- **Main File**: `server.js`
- **Startup Command**: `node /home/container/server.js`
- 在 **Environment Variables** 添加:
  - `VLESS_UUID` = 你的 UUID
  - `WS_PORT` = `8443` (或你申请的端口)

### 4) 安装依赖

面板 **Console**:

```bash
cd /home/container
npm install
```

### 5) 启动

点面板上的 **Start** 按钮。

## 客户端配置

### v2rayN (Windows / Android)

```text
VLESS + WS
  UUID:      <你的 UUID>
  地址:      <Host-Ship 域名>
  端口:      8443
  加密:      none
  传输:      ws
  WS Path:   /vless-node
  WS Host:   <域名>
  TLS:       如果前面有 CF 橙云, 不开
  SNI:       <域名> (如有 TLS)
```

### OpenClash

```yaml
proxies:
  - name: HostShip-VLESS
    type: vless
    server: <域名>
    port: 8443
    uuid: <UUID>
    udp: false
    tls: false   # 如果走 CF 橙云
    network: ws
    ws-opts:
      path: /vless-node
      headers:
        Host: <域名>
```

### daed

```text
proxy:
  name: HostShip-VLESS
  type: vless
  server:
    address: <域名>
    port: 8443
  vless:
    uuid: <UUID>
    transport:
      type: websocket
      network: tcp
      websocket:
        url: /vless-node
```

## 安全建议

1. **不要直接用 Host-Ship 的真实 IP**: 把域名放 Cloudflare 橙云
2. **定期更换 UUID**: 防止泄露
3. **限制带宽**: 通过 Host-Ship 面板设置资源限制
4. **不要公开 UUID**: 这是你的认证信息

## 性能

- 纯 Node.js 实现, 并发能力中等
- 适合测试和小流量使用
- 生产环境推荐 Go 实现 (xray-core / sing-box)

## 局限性

- 不支持 UDP (VLESS-over-WS 的 UDP 支持需要 XRay 专有扩展)
- 不支持 XRay 的扩展功能 (Reality, XTLS, 路由规则等)
- 不支持分流

## 故障排查

```bash
# 查看日志
node server.js 2>&1 | tee server.log

# 测试端口监听
ss -tlnp | grep 8443

# 测试 TLS (如果配置了)
echo | openssl s_client -connect <你的域名>:8443 -servername <你的域名>
```

## License

MIT
