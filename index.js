/**
 * dsh-workbuddy — 局域网 WorkBuddy 网关（一个插件管全部）。
 *
 * 宿主半区三件事：
 * 1. 五个模型侧工具：
 *    - workbuddy_apply_config: 写入 provider 路由与默认模型（实时生效）
 *    - workbuddy_status: 探测网关并列出带倍率的模型
 *    - workbuddy_chat: 用免费模型做一次性调用
 *    - workbuddy_optimize_prompt: 用免费模型改写提示词
 *    - workbuddy_delegate: 按任务档位把工作委派给子代理（自动填 provider/model）
 * 2. 一段简短的系统提示：讲清三档该怎么用来分派子代理。
 * 3. `GET /api/workbuddy-quota`（网关积分）与 `GET /api/workbuddy-balance`（账号余额）。
 *
 * 同包的 cordis.patch.yml 负责注册 workbuddy provider 路由与默认模型；
 * client.js 负责侧栏底栏（积分 / 余额 / 峰谷）。
 *
 * @module dsh-workbuddy
 */

export const name = 'workbuddy'
// systemPrompt / subagents 用 ctx.get 可选获取：缺了它们只关掉「分派」这一块，
// 不影响路由、四个工具和侧栏底栏。
export const inject = ['tools', 'credentials', 'settings', 'connection']

// 网关地址可用环境变量覆盖；默认回环地址只是占位，安装时请指向你的真实网关。
// 注意：cordis.patch.yml 里的 baseURL 是独立的一份，安装时也要一并改。
const BASE_URL = (typeof process !== 'undefined' && process.env?.WORKBUDDY_BASE_URL)
  ? String(process.env.WORKBUDDY_BASE_URL).replace(/\/$/, '')
  : 'http://127.0.0.1:8790/v1'
const KEY_REF = 'WORKBUDDY_API_KEY'
const DEFAULT_MODEL = 'hy4flash-free'
const CHAT_TIMEOUT_MS = 240_000

/**
 * 子代理分派的三档。只保留三档：档位越少，模型越愿意真按规则做。
 * `provider` / `model` 就是 `subagent` 工具要填的那两个参数。
 */
const TIERS = [
  {
    tier: 'cheap',
    label: '省钱',
    provider: 'workbuddy',
    model: 'hy4flash-free',
    credits: '免费',
    when: '纯文本处理、分类、摘要、改写、格式转换；只读 1–2 个文件、不写代码；预期改动很小',
  },
  {
    tier: 'standard',
    label: '标准',
    provider: 'workbuddy',
    model: 'deepseek-v4.1-flash',
    credits: '0.11',
    when: '要写或改代码、跨几个文件、需要多步工具调用；拿不准时的默认档',
  },
  {
    tier: 'strong',
    label: '强力',
    provider: 'workbuddy',
    model: 'kimi-k3.1-pro',
    credits: '0.97',
    when: '标准档做过但失败或质量不够；超长链推理、复杂算法、架构级判断',
  },
]

/** 网关不可用时的兜底路由（不占网关额度，走账号）。 */
const FALLBACK = { provider: 'deepseek-account', model: 'deepseek-flash', label: '账号兜底' }

const TIER_BY_NAME = new Map(TIERS.map(entry => [entry.tier, entry]))


/** Curated route catalog: id, label, credit multiplier, context, output, image input, reasoning levels. */
const MODELS = [
  ['deepseek-v4.1-flash', 'DeepSeek V4.1 Flash', 0.11, 1000000, 128000, true, ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']],
  ['deepseek-v4-pro', 'DeepSeek V4 Pro', 0.51, 1000000, 128000, true, ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']],
  ['hy4flash-free', 'Hy4 Flash free', 0, 960000, 64000, true, ['low', 'medium', 'high']],
  ['hy4flash', 'Hy4 Flash', 0.03, 960000, 64000, true, ['low', 'medium', 'high']],
  ['glm-5.3-flash', 'GLM 5.3 Flash', 0.08, 1000000, 131072, true, ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']],
  ['glm-5.3', 'GLM 5.3', 0.69, 1000000, 64000, true, ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']],
  ['hunyuan-2.0-thinking', 'Hunyuan 2.0 Thinking', 0.04, 128000, 24000, false, ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']],
  ['step-5-preview', 'Step 5 Preview', 0.33, 1000000, 64000, true, ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']],
  ['mimo-v2.6-pro', 'MiMo V2.6 Pro', 0.13, 1000000, 128000, true, ['low', 'medium', 'high']],
  ['kimi-k3.1-pro', 'Kimi K3.1 Pro', 0.97, 1000000, 32000, true, ['low', 'medium', 'high']],
  ['space-bunny', 'Space Bunny', 0.08, 1000000, 128000, true, ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']],
]

/** The `providers.workbuddy` value written through Settings. */
const PROVIDERS = {
  workbuddy: {
    displayName: '局域网 WorkBuddy',
    apiKeyEnv: KEY_REF,
    api: 'openai-completions',
    baseURL: BASE_URL,
    compat: { thinkingFormat: 'deepseek', supportsReasoningEffort: true },
    retryPolicy: { mode: 'normal', maxRetries: 2 },
    models: MODELS.map(([id, label, credits, contextWindow, maxTokens, image, efforts]) => ({
      id,
      name: credits === 0 ? `${label} 免费` : `${label} ·${credits}`,
      contextWindow,
      maxTokens,
      input: image ? ['text', 'image'] : ['text'],
      reasoningEfforts: Object.fromEntries(efforts.map(level => [level, level])),
    })),
  },
}

const TARGET_HINT = {
  code: 'a coding agent task (write or change code, run tests, inspect a repository)',
  analysis: 'an analysis or research task (investigate, compare, explain, produce a report)',
  image: 'an image-generation prompt (visual subject, style, composition, lighting, constraints)',
  general: 'a general assistant request',
}

/** Read the stored gateway key through the credential seam. */
async function gatewayKey(ctx) {
  const hit = await ctx.credentials.resolve(KEY_REF)
  if (hit === undefined || typeof hit.value !== 'string' || hit.value.length === 0) {
    throw new Error(`未找到凭证 ${KEY_REF}；请先在凭证中心保存 WorkBuddy 网关的 API Key。`)
  }
  return hit.value
}

/** POST /chat/completions and normalize the first choice. */
async function chatCompletion(ctx, body, signal) {
  const key = await gatewayKey(ctx)
  const timeout = AbortSignal.timeout(CHAT_TIMEOUT_MS)
  const combined = signal === undefined ? timeout : AbortSignal.any([signal, timeout])
  let response
  try {
    response = await fetch(`${BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify(body),
      signal: combined,
    })
  } catch (error) {
    throw new Error(`连不上 WorkBuddy 网关 ${BASE_URL}（仅局域网可用，且桥需要在运行）：${error instanceof Error ? error.message : String(error)}`)
  }
  const raw = await response.text()
  if (!response.ok) {
    let detail = raw
    try {
      detail = JSON.parse(raw).error?.message ?? raw
    } catch { /* keep the raw text */ }
    throw new Error(`WorkBuddy 网关返回 ${response.status}：${String(detail).slice(0, 400)}`)
  }
  let payload
  try {
    payload = JSON.parse(raw)
  } catch {
    throw new Error('WorkBuddy 网关返回了非 JSON 响应。')
  }
  const choice = payload.choices?.[0]
  return {
    model: payload.model ?? body.model,
    finish: choice?.finish_reason ?? '',
    text: String(choice?.message?.content ?? '').trim(),
    reasoning: String(choice?.message?.reasoning_content ?? '').trim(),
    usage: payload.usage ?? {},
  }
}

/** Describe the gateway's /v1/models and the curated route catalog. */
async function status(ctx, signal) {
  const key = await gatewayKey(ctx)
  const started = Date.now()
  let models = []
  let httpStatus = 0
  let error = null
  try {
    const response = await fetch(`${BASE_URL}/models`, {
      headers: { authorization: `Bearer ${key}` },
      signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
    })
    httpStatus = response.status
    if (!response.ok) {
      error = (await response.text()).slice(0, 300)
    } else {
      const payload = await response.json()
      models = (payload.data ?? []).map(entry => String(entry.id))
    }
  } catch (failure) {
    error = failure instanceof Error ? failure.message : String(failure)
  }
  const value = {
    reachable: error === null && httpStatus > 0 && httpStatus < 300,
    httpStatus,
    latencyMs: Date.now() - started,
    publicModels: models,
    route: { provider: 'workbuddy', baseURL: BASE_URL, defaultModel: 'deepseek-v4.1-flash', optimizerModel: DEFAULT_MODEL },
    catalog: MODELS.map(([id, label, credits, contextWindow, maxTokens, image, efforts]) => ({
      id, label, credits, contextWindow, maxTokens, images: image, reasoningEfforts: efforts,
    })),
  }
  if (error !== null) value.error = error
  return value
}

/** Write the route and default model through the live Settings service. */
async function applyConfig(ctx) {
  const descriptors = ctx.settings.describe()
  const byId = new Map(descriptors.map(entry => [String(entry.ns), entry]))
  const routeId = ['llm-pi-ai', 'include:llm-pi-ai'].find(id => byId.has(id))
  const modelId = ['agent-default-model', 'include:agent-default-model'].find(id => byId.has(id))
  if (routeId === undefined) throw new Error('当前 profile 没有可配置的 llm-pi-ai 条目，无法写入 provider。')
  if (modelId === undefined) throw new Error('当前 profile 没有可配置的 agent-default-model 条目，无法切换默认模型。')
  let changed = false
  const routeValue = byId.get(routeId).value ?? {}
  if (routeValue.providers?.workbuddy === undefined) {
    await ctx.settings.update(routeId, { providers: PROVIDERS })
    changed = true
  }
  const modelValue = byId.get(modelId).value ?? {}
  if (modelValue.provider !== 'workbuddy' || modelValue.model !== 'deepseek-v4.1-flash') {
    await ctx.settings.update(modelId, { provider: 'workbuddy', model: 'deepseek-v4.1-flash', reasoningEffort: 'high' })
    changed = true
  }
  return {
    changed,
    provider: 'workbuddy',
    model: 'deepseek-v4.1-flash',
    note: changed
      ? '已把 workbuddy 路由和默认模型写入当前 profile，新会话立即使用网关额度。'
      : 'workbuddy 路由和默认模型已是最新，无需改动。',
  }
}

/** Rewrite a draft prompt with the free gateway model. */
async function optimize(ctx, args, signal) {
  const target = TARGET_HINT[args.target] === undefined ? TARGET_HINT.general : TARGET_HINT[args.target]
  const language = args.language ?? '与草稿相同的语言'
  const system = [
    'You are a prompt engineer for an AI coding agent called DeepSeek Harness.',
    'Rewrite the user draft into one precise, executable prompt.',
    'Keep every fact, number, path, constraint, and intent from the draft. Never invent facts.',
    `Target: ${target}.`,
    `Write the result in ${language}.`,
    'Structure when useful: goal, context, constraints, deliverables, acceptance criteria, what to avoid.',
    'Remove filler and ambiguity. Do not answer the task and do not add preamble.',
    'Output only the rewritten prompt, without code fences or commentary.',
  ].join(' ')
  const draft = [
    'DRAFT:',
    args.prompt,
    '',
    'EXTRA CONTEXT:',
    args.context ?? '(none)',
  ].join('\n')
  const result = await chatCompletion(ctx, {
    model: DEFAULT_MODEL,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: draft },
    ],
    max_tokens: 4096,
    temperature: 0.2,
  }, signal)
  if (result.text.length === 0) {
    throw new Error(`免费模型 ${DEFAULT_MODEL} 只返回了思考内容（finish=${String(result.finish)}）；请先把 maxTokens 调大或换用 hy4flash。`)
  }
  return { model: result.model, optimized: result.text, finish: result.finish, usage: result.usage }
}

/** 积分查询端点（用同一把 API Key 鉴权）。 */
const QUOTA_PATH = '/api/workbuddy-quota'
/** DeepSeek 官方账号钱包查询端点（只读，来自宿主的 deepseekAccount 服务）。 */
const BALANCE_PATH = '/api/workbuddy-balance'
/** 积分缓存时长：30 秒内重复请求直接返回缓存，避免频繁打网关。 */
const CACHE_MS = 30_000

/**
 * 读取 WorkBuddy 剩余积分。带 30 秒缓存，避免侧栏轮询打爆网关。
 * @param ctx - 携带 credentials 的上下文。
 * @returns 积分快照。
 */
export function createQuotaReader(ctx) {
  let cache = { at: 0, value: null, error: null }

  return async function readQuota() {
    const now = Date.now()
    if (cache.value !== null && now - cache.at < CACHE_MS) return { ...cache.value, cached: true }
    if (cache.error !== null && now - cache.at < CACHE_MS) {
      return { ok: false, error: cache.error, cached: true, fetchedAt: new Date(cache.at).toISOString() }
    }
    try {
      const hit = await ctx.credentials.resolve(KEY_REF)
      if (hit === undefined || typeof hit.value !== 'string' || hit.value.length === 0) {
        throw new Error(`未找到凭证 ${KEY_REF}`)
      }
      const res = await fetch(`${BASE_URL}/quota`, {
        headers: { authorization: `Bearer ${hit.value}` },
        signal: AbortSignal.timeout(8000),
      })
      if (!res.ok) throw new Error(`网关返回 HTTP ${res.status}`)
      const payload = await res.json()
      const value = {
        ok: true,
        total: Number(payload.total ?? 0),
        fetchedAt: new Date().toISOString(),
        source: 'workbuddy-gateway /v1/quota',
      }
      cache = { at: now, value, error: null }
      return { ...value, cached: false }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      cache = { at: now, value: null, error: message }
      return { ok: false, error: message, cached: false, fetchedAt: new Date().toISOString() }
    }
  }
}

/** 账号钱包(normal=充值, bonus=赠送) → 合计余额；货币按第一个可用币种聚合。 */
function accountWalletOf(details) {
  const group = list => {
    if (!Array.isArray(list)) return null
    const wallets = []
    for (const entry of list) {
      if (entry === null || typeof entry !== 'object') return null
      const currency = String(entry.currency ?? '').toUpperCase()
      if (!['CNY', 'USD'].includes(currency)) return null
      const amount = Number(entry.balance)
      if (typeof entry.balance !== 'string' || !Number.isFinite(amount)) return null
      wallets.push({ currency, amount })
    }
    return wallets
  }
  const normal = group(details?.value)
  const bonus = group(details?.bonusWallets)
  if (normal === null || bonus === null) return null
  const totals = new Map()
  for (const wallet of [...normal, ...bonus]) totals.set(wallet.currency, (totals.get(wallet.currency) ?? 0) + wallet.amount)
  if (totals.size === 0) return null
  // 与 cost-meter 一致：优先 CNY，其次 USD。
  const currency = totals.has('CNY') ? 'CNY' : [...totals.keys()][0]
  const sumOf = list => list.reduce((acc, wallet) => wallet.currency === currency ? acc + wallet.amount : acc, 0)
  const topped = sumOf(normal)
  const granted = sumOf(bonus)
  if (![topped, granted, topped + granted].every(Number.isFinite)) return null
  return { currency, total: topped + granted, topped, granted }
}

/**
 * 读取 DeepSeek 官方账号余额（与 设置→账号 同源，由宿主账号服务鉴权，插件不接触 token）。
 * 30 秒缓存 + 只读；未登录/无账号服务时返回 ok:false 而不是 0。
 * @param ctx - 宿主上下文。
 * @returns 余额快照。
 */
export function createBalanceReader(ctx) {
  let cache = { at: 0, value: null }
  const TTL = 30_000

  return async function readBalance() {
    const now = Date.now()
    if (cache.value !== null && now - cache.at < TTL) return { ...cache.value, cached: true }
    const fail = (error) => {
      const value = { ok: false, error, cached: false, fetchedAt: new Date().toISOString() }
      cache = { at: now, value }
      return value
    }
    const account = ctx.get('deepseekAccount')
    if (typeof account?.getBalance !== 'function') return fail('当前 profile 没有账号服务')
    try {
      const details = await account.getBalance({
        version: '',
        locale: 'zh',
        timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60,
      })
      if (details === null) {
        const state = typeof account.getState === 'function' ? await account.getState() : null
        return fail(state?.status === 'signed-out' ? '未登录 DeepSeek 账号' : '账号余额不可用')
      }
      if (details.status !== 'ready') return fail('账号余额读取失败')
      const wallet = accountWalletOf(details)
      if (wallet === null) return fail('账号钱包数据为空')
      const value = { ok: true, ...wallet, fetchedAt: new Date().toISOString(), source: 'deepseek-account/getBalance' }
      cache = { at: now, value }
      return { ...value, cached: false }
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error))
    }
  }
}

/** 分派规则正文。刻意写短：只讲三档和怎么用，不写量化评分表。 */
function delegationPolicyText() {
  const rows = TIERS.map(entry => `| \`${entry.tier}\`（${entry.label}） | ${entry.provider} / ${entry.model} | ${entry.credits} | ${entry.when} |`)
  return [
    '## 子代理分派：按任务大小挑模型',
    '',
    '需要把一块工作拆出去单独做时，先估它属于哪一档，再用 `workbuddy_delegate` 派出去。',
    '',
    '| 档位 | 路由 | 倍率 | 什么时候用 |',
    '|---|---|---|---|',
    ...rows,
    '',
    '- **不确定就用 `standard`。** 宁可标准档一次做对，也不要为省钱反复重试。',
    '- `cheap` 只做不需要判断力的活；它写代码容易出错，出错重来的成本比省下的高。',
    '- 只有 `standard` 已经试过且不行，才升 `strong`。',
    `- 网关连不上或报 401 时用 \`${FALLBACK.provider} / ${FALLBACK.model}\`（账号额度），并在结果里说明原因。`,
    '- 三个档位都已在新会话里授权；手写 `subagent` 时也可以直接填上面表格里的 provider/model。',
    '- 派出去的子任务要自带完整上下文：它看不到当前对话。',
  ].join('\n')
}

/**
 * 注册「分派规则」系统提示段落 + `workbuddy_delegate` 工具。
 * @param ctx - 插件上下文。
 * @param systemPrompt - 宿主 systemPrompt 服务。
 * @param subagents - 宿主 subagents 服务。
 */
function registerDelegation(ctx, systemPrompt, subagents) {
  ctx.effect(
    () => systemPrompt.section({
      name: 'workbuddy/delegation-tiers',
      order: 860,
      text: delegationPolicyText,
    }),
    'dsh-workbuddy: delegation policy section',
  )

  ctx.tools.register({
    name: 'workbuddy_delegate',
    description: 'Delegate one self-contained task to a subagent at a cost tier: cheap (free model, text-only-ish work), standard (default, writes code), strong (hard reasoning, ~9x standard). The tool fills provider/model for you and starts the subagent, returning its name.',
    // 用标准 JSON Schema（type:object + properties + required 数组），与宿主
    // 其余工具一致。首版曾用 DSH 简写方言；同时期出现过 ai-gateway
    // invalid_function_parameters 报错，但直连重放未能证实二者因果，
    // 这里统一成标准格式以排除该变量。
    parameters: {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          description: 'The complete, self-contained task. The subagent does not see this conversation, so include all needed context.',
        },
        tier: {
          type: 'string',
          enum: TIERS.map(entry => entry.tier),
          description: 'cheap = free model for simple text work; standard = default, use when unsure; strong = expensive, only after standard failed.',
        },
        description: {
          type: 'string',
          description: 'Short 3-5 word label for display (same idea as subagent\'s description).',
        },
        name: {
          type: 'string',
          description: 'Optional subagent name, unique among your children; cannot be "lead".',
        },
        cwd: {
          type: 'string',
          description: 'Optional initial working directory for the subagent; defaults to yours.',
        },
      },
      required: ['prompt', 'tier'],
      additionalProperties: false,
    },
    timeoutMs: 60_000,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['kind', 'name', 'tier', 'provider', 'model'],
        properties: {
          kind: { type: 'string' },
          name: { type: 'string' },
          tier: { type: 'string' },
          provider: { type: 'string' },
          model: { type: 'string' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `started subagent ${value.name}（${value.tier} → ${value.provider}/${value.model}）`,
      }],
      presentationMeta: (_args, value) => ({ kind: value.kind, name: value.name }),
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const parent = exec.agent
      if (parent === undefined) throw new Error('workbuddy_delegate 需要一个调用方 agent')
      const route = TIER_BY_NAME.get(args.tier)
      if (route === undefined) {
        throw new Error(`未知档位 "${String(args.tier)}"；可用：${TIERS.map(entry => entry.tier).join(' / ')}`)
      }
      const maxDepth = subagents.resolveMaxDepth(undefined)
      const activation = await subagents.startActivation({
        provider: 'spawn',
        label: args.description ?? `workbuddy ${route.tier}`,
        ...args.name === undefined ? {} : { name: args.name },
        prompt: [{ type: 'text', text: args.prompt }],
        parent,
        ...args.cwd === undefined ? {} : { cwd: args.cwd },
        agentOptions: { provider: route.provider, model: route.model },
        ...maxDepth === undefined ? {} : { maxDepth },
        signal: exec.signal,
        delivery: 'parent',
      })
      return {
        kind: 'activation',
        name: activation.name,
        tier: route.tier,
        provider: route.provider,
        model: route.model,
      }
    },
  })
}

export function apply(ctx) {
  const text = (value) => [{ type: 'text', text: value }]

  ctx.tools.register({
    name: 'workbuddy_apply_config',
    description: 'Ensure the LAN WorkBuddy gateway is the DSH default model route by writing it through the live Settings service. Idempotent; call when the workbuddy provider or its default model is missing or after the gateway address changes.',
    parameters: {},
    timeoutMs: 60_000,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['changed', 'provider', 'model', 'note'],
        properties: {
          changed: { type: 'boolean' },
          provider: { type: 'string' },
          model: { type: 'string' },
          note: { type: 'string' },
        },
      },
      render: (_args, value) => text(value.note),
    },
    async execute(_args, exec) {
      return applyConfig(ctx)
    },
  })

  ctx.tools.register({
    name: 'workbuddy_status',
    description: 'Probe the LAN WorkBuddy gateway and list the curated model catalog with credit multipliers. Use before choosing a model or when gateway calls fail.',
    parameters: {},
    timeoutMs: 30_000,
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        required: ['reachable', 'httpStatus', 'latencyMs', 'publicModels', 'route', 'catalog'],
        properties: {
          reachable: { type: 'boolean' },
          httpStatus: { type: 'number' },
          latencyMs: { type: 'number' },
          publicModels: { type: 'array', items: { type: 'string' } },
          error: { type: 'string' },
          route: { type: 'object', additionalProperties: true },
          catalog: { type: 'array', items: { type: 'object', additionalProperties: true } },
        },
      },
      render: (_args, value) => {
        const lines = [value.reachable
          ? `网关可达（HTTP ${value.httpStatus}，${value.latencyMs} ms）。`
          : `网关不可达：${value.error ?? `HTTP ${value.httpStatus}`}`]
        lines.push(`路由 workbuddy · 默认 deepseek-v4.1-flash · 优化器 ${DEFAULT_MODEL}`)
        lines.push('模型（倍率）：' + value.catalog.map(model => `${model.id}=${model.credits === 0 ? '免费' : model.credits}`).join('、'))
        return text(lines.join('\n'))
      },
    },
    async execute(_args, exec) {
      return status(ctx, exec.signal)
    },
  })

  ctx.tools.register({
    name: 'workbuddy_chat',
    description: 'Send one isolated chat request to the WorkBuddy gateway, defaulting to the free model. Use for cheap subtasks that do not need the main session model; no conversation history is sent.',
    parameters: {
      prompt: { type: 'string', required: true, description: 'The user message to send.' },
      model: { type: 'string', description: 'Gateway model id; defaults to hy4flash-free (0 credits).' },
      system: { type: 'string', description: 'Optional system message.' },
      maxTokens: { type: 'number', description: 'Output cap, 256-4096; defaults to 2048. Reasoning tokens count toward it.' },
    },
    timeoutMs: 260_000,
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        required: ['model', 'text', 'finish'],
        properties: {
          model: { type: 'string' },
          text: { type: 'string' },
          reasoning: { type: 'string' },
          finish: { type: 'string' },
          usage: { type: 'object', additionalProperties: true },
        },
      },
      render: (_args, value) => text(value.text.length === 0 ? '（模型没有返回正文）' : value.text),
    },
    async execute(args, exec) {
      const cap = Math.min(4096, Math.max(256, Math.round(args.maxTokens ?? 2048)))
      const messages = []
      if (args.system !== undefined && args.system.length > 0) messages.push({ role: 'system', content: args.system })
      messages.push({ role: 'user', content: args.prompt })
      return chatCompletion(ctx, {
        model: args.model ?? DEFAULT_MODEL,
        messages,
        max_tokens: cap,
      }, exec.signal)
    },
  })

  ctx.tools.register({
    name: 'workbuddy_optimize_prompt',
    description: 'Rewrite a draft prompt into a precise, executable prompt using the free gateway model (0 credits). Use before expensive or ambiguous tasks, then send the optimized prompt as the real request.',
    parameters: {
      prompt: { type: 'string', required: true, description: 'The draft prompt to rewrite.' },
      context: { type: 'string', description: 'Extra context the rewrite may rely on: constraints, file paths, expected output.' },
      target: { type: 'string', enum: ['code', 'analysis', 'image', 'general'], description: 'What the prompt is for; defaults to general.' },
      language: { type: 'string', description: 'Language of the rewritten prompt; defaults to the draft language.' },
    },
    timeoutMs: 260_000,
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        required: ['model', 'optimized'],
        properties: {
          model: { type: 'string' },
          optimized: { type: 'string' },
          finish: { type: 'string' },
          usage: { type: 'object', additionalProperties: true },
        },
      },
      render: (_args, value) => text(value.optimized),
    },
    async execute(args, exec) {
      return optimize(ctx, args, exec.signal)
    },
  })

  // ---- 子代理按档位分派 ----
  // 服务是可选依赖：没有 systemPrompt / subagents 就整块跳过，其它功能照常。
  const systemPrompt = ctx.get('systemPrompt')
  const subagents = ctx.get('subagents')
  if (systemPrompt !== undefined && subagents !== undefined) {
    registerDelegation(ctx, systemPrompt, subagents)
  }

  // 左侧栏积分接口：必须走 connection.fetch（/api 通道要过浏览器鉴权）。
  const readQuota = createQuotaReader(ctx)
  ctx.effect(
    () => ctx.connection.fetch.register({
      path: QUOTA_PATH,
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: async () => {
        const value = await readQuota()
        return new Response(JSON.stringify(value), {
          status: 200,
          headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
        })
      },
    }),
    'dsh-workbuddy: workbuddy quota route',
  )

  // 侧栏余额接口：DeepSeek 官方账号钱包（只读，与积分一起构成我们自己的底栏）。
  const readBalance = createBalanceReader(ctx)
  ctx.effect(
    () => ctx.connection.fetch.register({
      path: BALANCE_PATH,
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: async () => {
        const value = await readBalance()
        return new Response(JSON.stringify(value), {
          status: 200,
          headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
        })
      },
    }),
    'dsh-workbuddy: deepseek balance route',
  )
}
