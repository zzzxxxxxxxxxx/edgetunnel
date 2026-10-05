# Durable Object 版改造说明

在 cmliu/edgetunnel 2.1（`_worker.js`，Version `2026-09-22 20:01:17`）基础上，把 **WebSocket 隧道**的计算下沉到
Durable Object，绕过免费版 Worker 的 10ms CPU 限制（DO 为 30s/请求）。

## 改了什么

| 文件 | 改动 |
| :--- | :--- |
| `_worker.js` | ① 顶部新增 `import { connect } from 'cloudflare:sockets'`（见下文"已知注意点"）② 原 `export default` 改名为 `const EDTHandler`，函数体未改动 ③ 新增薄 Worker 入口：只把 `Upgrade: websocket` 且配置了管理员密码的请求转发进 DO ④ 新增 `export class TunnelDO` ⑤ `创建请求TCP连接器()` 增加标准 `connect()` 兜底 |
| `wrangler.toml` | 新增 `[durable_objects]` 绑定、`[[migrations]]`、`[vars]` 的 `DO_REGION` / `DO_SHARDS` |

**没有改动的东西**：KV 绑定、`/sub`、`/login`、`/admin/*`、伪装页、gRPC/XHTTP 全部仍留在 Worker 里跑。
DO 里没有 KV shim——上游 2.1 的 WS 路径不读 KV、不读 `config_JSON`、不用 `ctx.waitUntil`，DO 直接用 `this.env`
就能拿到 Worker 上配置的全部绑定。

## 部署

Durable Objects 无法走上游 README 主推的「Pages 上传 main.zip」路径（Pages Functions 绑 DO 需要把 DO 类放在
独立 Worker 里），必须用 Wrangler 部署到 Workers：

```bash
npm install -g wrangler     # 或 npx wrangler
wrangler login
wrangler deploy             # 首次部署：必须带上 wrangler.toml 里的 [[migrations]] 段
```

首次部署成功后，DO 命名空间已创建，`[[migrations]]` 段可以删掉，后续部署不再需要。

KV 仍然照旧绑定（绑定名必须为 `KV`），后台与订阅功能不受影响：

```toml
[[kv_namespaces]]
binding = "KV"
id = "你的KV命名空间id"
```

## 变量

| 变量 | 默认 | 说明 |
| :--- | :--- | :--- |
| `DO_REGION` | `wnam` | DO 放置区域，决定隧道出口 IP 所在大区。可选 `wnam/enam/sam/weur/eeur/apac/oc/afr/me`（参考 <https://where.durableobjects.live/>）。**只在 DO 首次实例化时生效**，之后修改无效，必须删除 DO 命名空间重建。 |
| `DO_SHARDS` | `1` | DO 分片数。`1` = 所有隧道连接共用一个 DO 实例（出口 IP 最稳、duration 计费最省）；`>1` = 连接随机分散到多个实例。 |

### 为什么默认 `DO_SHARDS = 1`

DO 的 duration 是**按对象**计费的（官方口径：wall-clock time ... shared across all requests active on an
Object at once）。多条连接共享一个实例只算一份时长；而"每条连接一个 DO"（如 edgetunnel-do 的 `newUniqueId()`
做法）会变成所有连接寿命之和，免费额度消耗成倍增长。

免费额度换算：`13,000 GB-s/天 ÷ 0.125 GB = 104,000 秒 ≈ 单个 128MB 实例连续 28.9 小时/天`。

| 场景 | duration/天 | 免费额度 |
| :--- | ---: | :--- |
| 1 个实例挂 24 h | 10,800 GB-s | 占 83% |
| 1 个实例挂 12 h | 5,400 GB-s | 占 42% |
| 4 个分片全占满 24 h | 43,200 GB-s | **超 3.3 倍** |

免费计划超额不是扣费，而是 **DO 请求直接报错，一直失败到 UTC 零点**。所以先用 `DO_SHARDS=1` 观察
Dashboard 的 Duration 用量再决定要不要分片。

### 为什么没用 WebSocket Hibernation

隧道持有出站 TCP socket 和大量内存态，DO 休眠会切断 socket 并丢状态，正在传输的流会断在半路。
代价就是"连接还在就计费"，因此额度靠**控制 DO 对象数量**来管，而不是靠休眠。

## 已知注意点

1. **TCP 出站入口分了两条路**：上游 2.1 建 TCP 用的是 `request.fetcher.connect()`——这是从
   [ToiCF/GrainTCP](https://github.com/ToiCF/GrainTCP) 移植来的 **request 级未公开灰接口**（GrainTCP README
   原话：与公开 `cloudflare:sockets.connect()` 的差异"主要在 JS 层入口、**fetcher 归属和通道来源**"，
   两者最终落到同一套底层建连实现）。GrainTCP 自己没有任何兜底，也完全没有用到 DO，所以"转发进 DO 后
   `request.fetcher` 是否仍可用"没有现成结论。
   本改造因此按上下文区分：
   - **Worker 内**：仍然优先用 `request.fetcher`（保留它"代码特征更小"的价值）；
   - **DO 内**：TunnelDO 的构造函数把模块级标志 `运行于DurableObject` 置位，`创建请求TCP连接器()`
     直接改走公开、文档化的 `connect()`——不赌灰接口在新请求上下文里的归属，功能等价。
   （Worker 与 DO 是两个独立的模块实例，标志互不影响；即使假设不成立，最坏结果也只是退回公开 API。）
   代价：文件顶部多了一行 `import { connect } from 'cloudflare:sockets'`，这是一个明显的特征串。
   如果你能确认 DO 内 `request.fetcher` 可用并愿意赌它，可以删掉这行 import 与 DO 分支。
2. **`X-CF-Properties`**：`new Request()` 不携带 `cf`，而 DO 内需要 `cf.colo`（拼默认反代域名）和
   `cf.asn`（`识别运营商`），所以由 Worker 覆盖写入该头。不要改成 `append`，否则客户端可以伪造。
3. **命名 DO 首次访问延迟**：官方说明基于名字的 DO 首次 `get()` 需要做一次"全球是否已存在同名实例"的检查，
   可能多几百毫秒；之后位置会被缓存。这是每个区域一次性成本。
4. **本改造未覆盖 gRPC / XHTTP**：这两条是 POST 路径，上游 2026-08 已把 XHTTP 改成 `pipeTo` 直通（低 CPU），
   先观察是否真的触发 1102 再决定要不要一并下沉。若要下沉，在 Worker 入口加与上游入口 (L72) 相同的判定即可。

## 验证

仓库内自带一个回归挂具（Node ≥ 20，不需要部署、不需要 wrangler）：

```bash
node test/do-routing.test.mjs
```

覆盖 6 项：WS 升级正确转发、`Upgrade` 头大小写不敏感、分片与 `locationHint` 可配、
无 `ADMIN` 不占用 DO、普通 HTTP 请求留在 Worker、DO 内 `request.cf` 由 `X-CF-Properties` 完整还原。

部署后仍需自行回归：
- `wrangler tail` 看 DO 内是否拿到正确的 `cf` 与是否抛 `request.fetcher.connect unavailable`；
- 大文件 / 多线程下载是否还出 Error 1102；
- 出口 IP 是否稳定在同一大区（`DO_SHARDS=1` 时应只变 IPv4 最后一段）；
- Dashboard 的 DO **Duration** 用量。

## 回滚

删除 Worker 上的 `TUNNEL_DO` 绑定（或把 `[durable_objects]` 段注释掉重新部署），入口会自动退回
`EDTHandler.fetch(request, env, ctx)`，行为与未改造前一致；`TunnelDO` 类留在文件里不影响。
