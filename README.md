# dsh-workbuddy

把局域网 [WorkBuddy](https://www.workbuddy.ai/) 网关接入 [DeepSeek Harness](https://github.com/deepseek-ai) 的一站式插件：**一个插件同时提供模型路由、agent 工具、侧栏底栏和子代理分派**。

> 面向 DeepSeek Harness `0.2.2-rc.3`（Desktop/Web profile）。其他版本未验证。

## 功能

| 层 | 内容 |
|---|---|
| `cordis.patch.yml` | 注册 `workbuddy` provider 路由 + 默认模型；可配置任意 OpenAI 兼容网关 |
| `index.js`（宿主） | 5 个 agent 工具 + 2 个只读查询接口 + 一段子代理分派规则 |
| `client.js`（浏览器） | 侧栏底栏三行：积分 / 余额 / 峰谷，同一套样式、顺序固定 |

### 5 个工具

| 工具 | 用途 | 花谁的额度 |
|---|---|---|
| `workbuddy_apply_config` | 通过 Settings 实时写入 provider 路由与默认模型（幂等） | 不调用模型 |
| `workbuddy_status` | 探测网关、列出模型与倍率 | 只查 `/models` |
| `workbuddy_chat` | 一次性调用，默认免费模型；不带会话历史 | 免费模型 |
| `workbuddy_optimize_prompt` | 用免费模型把草稿改写成精确提示词 | 免费模型 |
| `workbuddy_delegate` | 按三档把任务分派给子代理，自动填 `provider`/`model` | 取决于档位 |

### 侧栏底栏

| 行 | 来源 |
|---|---|
| 积分 | 网关 `GET /v1/quota`（用 `WORKBUDDY_API_KEY`） |
| 余额 | 宿主账号服务 `deepseekAccount.getBalance()`（插件不接触 token） |
| 峰谷 | 本地计算：UTC 峰窗 `01–04` / `06–10`，北京时间周末与法定假日全天谷价 |

## 安装

### 1. 放好插件

把本仓库放到任意目录，然后装进你的 DSH profile（以 desktop 为例）：

```bash
dsh plugin --profile desktop add /absolute/path/to/dsh-workbuddy
```

或在 `~/.dsh/profiles/desktop/package.json` 里加一条依赖并跑一次安装：

```json
{ "dsh": { "profile": { "bundles": ["dsh-workbuddy"] } } }
```

### 2. 改网关地址（**必须**）

仓库里的地址是**占位符** `http://127.0.0.1:8790/v1`。安装前把下面两处改成你的真实网关：

- `cordis.patch.yml` → `providers.workbuddy.baseURL`
- （可选）`index.js` → `BASE_URL` 的环境变量回退值

> 提示：`index.js` 支持 `WORKBUDDY_BASE_URL` 环境变量覆盖；`cordis.patch.yml` 的那份是独立的，改它才影响 provider 路由。

### 3. 存凭证

在 DSH 凭证中心保存 `WORKBUDDY_API_KEY`（对应 `~/.dsh/.credentials.yaml` 的 `refs.WORKBUDDY_API_KEY`）。

### 4. 重启

完全退出 DSH（⌘Q）再打开。安装/重载返回 `restart-required` 时也需要完整重启，而不仅是刷新页面。

## 子代理三档

不用记 `provider`/`model`，给任务定一档即可：

| 档位 `tier` | 路由 | 倍率 | 何时用 |
|---|---|---|---|
| `cheap` | `workbuddy / hy4flash-free` | 免费 | 纯文本处理、分类、摘要；不写代码 |
| `standard` | `workbuddy / deepseek-v4.1-flash` | 0.11 | 写代码、跨文件、多步工具调用；**拿不准用这档** |
| `strong` | `workbuddy / kimi-k3.1-pro` | 0.97 | standard 失败后；超长链推理、架构判断 |

三档规则同时注入系统提示（段落 `workbuddy/delegation-tiers`），所以手写 `subagent` 时 agent 也知道怎么填参数。

**关于自动降级**：本项目**不实现**运行时自动换模型。系统提示里"网关不可用时用账号额度"只是给模型看的建议。DSH 自带的 `dsh-llm-retry` 只在同一模型上重试 `EMPTY_RESPONSE/RATE_LIMIT/SERVER/TIMEOUT/TRANSPORT`，不覆盖 `INVALID_REQUEST`，也不会换模型。主会话内自动换模型当前 DSH 架构不支持（`llm/stream` options 深冻结）。

## 与 cost-meter 共存

`client.js` 自己画底栏。如果你同时装了 `dsh-cost-meter` 且不想看到两份余额/峰谷，在它的配置里关掉：

```json
{ "balance": { "display": "settings" }, "peakNotice": false }
```

这不影响 cost-meter 的统计、设置页和峰谷切换提醒。

## 安全说明

- 仓库**不含任何密钥或口令**。凭证统一走 DSH 凭证中心。
- 默认地址是回环占位符，不会泄露你的内网拓扑。
- 侧栏余额读取复用宿主账号服务，插件本身拿不到 DeepSeek token。
- 网关只在内网可用时不要把 8790/8792 暴露到公网。

## 自定义

- **模型清单**：`index.js` 的 `MODELS` 与 `cordis.patch.yml` 的 `models` 两处都要改（保持倍率/上下文一致）。
- **峰谷时段**：`client.js` 顶部 `PEAK_WINDOWS` / `PEAK_HOLIDAYS`。
- **三档路由**：`index.js` 的 `TIERS`。

## License

MIT
