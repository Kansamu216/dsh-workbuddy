// dsh-workbuddy — browser half。
//
// 侧栏底部自己渲染一整块「积分 / 余额 / 峰谷」，三行同一套样式、顺序固定，
// 不再依赖 cost-meter 的底栏（本插件的三个 data-* 之外不改动任何宿主或
// cost-meter 的选择器）。
//
//   · 积分  ← 宿主 /api/workbuddy-quota（转网关 /v1/quota）
//   · 余额  ← 宿主 /api/workbuddy-balance（宿主 deepseekAccount.getBalance）
//   · 峰谷  ← 本地按 UTC 时段 + 北京时间周末/节假日计算
window.__ModuleLoader__.load({
  id: 'dsh-workbuddy',
  factory: (require) => {
    const React = require('react')

    /* ---------- 峰谷时段（与 cost-meter 默认一致） ---------- */

    /** UTC 半开小时区间 [start, end)，跨午夜用 start > end 表示。 */
    const PEAK_WINDOWS = [{ start: 1, end: 4 }, { start: 6, end: 10 }]
    /** 北京时间公众假期（全天谷价），与 cost-meter 默认表一致。 */
    const PEAK_HOLIDAYS = [
      '2026-09-25', '2026-09-26', '2026-09-27',
      '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04',
      '2026-10-05', '2026-10-06', '2026-10-07',
    ]
    const BEIJING_OFFSET_MS = 8 * 3_600_000

    /** 北京日历日 yyyy-MM-dd。 */
    function beijingDay(ms) {
      return new Date(ms + BEIJING_OFFSET_MS).toISOString().slice(0, 10)
    }

    /** 北京星期：0=周日 … 6=周六。 */
    function beijingWeekday(ms) {
      return new Date(ms + BEIJING_OFFSET_MS).getUTCDay()
    }

    /** 某一时刻的时段：{ peak, reason } 。 */
    function phaseAt(ms) {
      if (PEAK_HOLIDAYS.includes(beijingDay(ms))) return { peak: false, reason: 'holiday' }
      const weekday = beijingWeekday(ms)
      if (weekday === 0 || weekday === 6) return { peak: false, reason: 'weekend' }
      const hour = new Date(ms).getUTCHours()
      for (const { start, end } of PEAK_WINDOWS) {
        const inside = start < end ? hour >= start && hour < end : hour >= start || hour < end
        if (inside) return { peak: true, reason: 'peak' }
      }
      return { peak: false, reason: 'off' }
    }

    /** 下一处时段切换时刻：扫描候选边界（UTC 16:00 北京换日 + 各窗口端点）。 */
    function nextSwitch(ms) {
      const candidates = new Set()
      const dayStart = Math.floor(ms / 86_400_000) * 86_400_000
      for (let d = -1; d <= 12; d += 1) {
        const base = dayStart + d * 86_400_000
        candidates.add(base + 16 * 3_600_000) // 北京 00:00
        for (const { start, end } of PEAK_WINDOWS) {
          candidates.add(base + start * 3_600_000)
          candidates.add(base + end * 3_600_000)
        }
      }
      const here = phaseAt(ms).peak
      const ahead = [...candidates].filter(value => value > ms).sort((a, b) => a - b)
      for (const value of ahead) {
        if (phaseAt(value).peak !== here) return value
      }
      return null
    }

    /** 倒计时文案。 */
    function countdownText(target, now) {
      if (target === null) return '—'
      const minutes = Math.max(1, Math.ceil((target - now) / 60_000))
      const days = Math.floor(minutes / 1440)
      const hours = Math.floor((minutes % 1440) / 60)
      const mins = minutes % 60
      if (days > 0) return `${days}天${hours > 0 ? `${hours}小时` : ''}${mins > 0 ? `${mins}分` : ''}`
      if (hours > 0) return `${hours}小时${mins > 0 ? `${mins}分` : ''}`
      return `${mins}分`
    }

    /** 切换时刻的本地时间文案（北京时间）。 */
    function switchLabel(ms) {
      if (ms === null) return '—'
      const date = new Date(ms + BEIJING_OFFSET_MS)
      const pad = value => String(value).padStart(2, '0')
      return `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}`
    }

    /** 每秒（或到下一分钟）刷新的当前时间。 */
    function useClock() {
      const [now, setNow] = React.useState(() => Date.now())
      React.useEffect(() => {
        const timer = setInterval(() => setNow(Date.now()), 15_000)
        return () => clearInterval(timer)
      }, [])
      return now
    }

    /* ---------- 三个数据行 ---------- */

    const CSS = [
      /* 我们的三行独占一个纵向栈：order:-1 让整块排在 Settings 之前，
         flex:0 0 100% 保证在 footerActions 的横向 flex 里占满整行。 */
      '.wb-stack{display:flex;flex-direction:column;flex:0 0 100%;order:-1;',
      'width:100%;min-width:0;gap:0;box-sizing:border-box}',
      '.wb-row{display:flex;align-items:baseline;justify-content:space-between;gap:8px;',
      'box-sizing:border-box;width:100%;min-width:0;height:28px;padding:0 8px;',
      'border-radius:8px;font-size:12px;line-height:28px;',
      'color:var(--dsw-alias-label-secondary);white-space:nowrap;overflow:hidden}',
      '.wb-row.clickable{cursor:pointer;outline:none}',
      '.wb-row.clickable:hover{background:var(--dsw-alias-interactive-bg-hover,var(--dsw-alias-bg-layer-2))}',
      '.wb-row.clickable:focus-visible{box-shadow:0 0 0 2px var(--dsw-alias-state-business-primary)}',
      '.wb-row-label{overflow:hidden;text-overflow:ellipsis;min-width:0}',
      '.wb-row-value{flex:none;font-variant-numeric:tabular-nums;',
      'color:var(--dsw-alias-label-primary);font-weight:600}',
      '.wb-row.is-error .wb-row-value{color:var(--dsw-alias-state-error-primary)}',
      /* 峰谷三态：峰=橙、谷=绿、周末/假日=中性。 */
      '.wb-peak-dot{display:inline-block;width:6px;height:6px;border-radius:50%;',
      'margin-right:5px;vertical-align:1px;background:var(--dsw-alias-state-idle-primary)}',
      '.wb-row[data-phase=peak] .wb-peak-dot{background:#f7931e}',
      '.wb-row[data-phase=off] .wb-peak-dot{background:var(--dsw-alias-state-success-primary)}',
      '.wb-row[data-phase=off] .wb-row-value{color:var(--dsw-alias-state-success-primary)}',
      '.wb-row[data-phase=peak] .wb-row-value{color:#f7931e}',
      /* 收起成 56px 轨道时只留数值，并居中。 */
      '.wb-stack.rail{align-items:center}',
      '.wb-stack.rail .wb-row{justify-content:center;padding:0;gap:0;height:24px;line-height:24px}',
      '.wb-stack.rail .wb-row-label{display:none}',
    ].join('')

    const CSS_TAG_ID = 'dsh-workbuddy/footer.css'

    function ensureStyles() {
      if (typeof document === 'undefined') return
      if (document.querySelector('style[data-plugin-css=' + JSON.stringify(CSS_TAG_ID) + ']') !== null) return
      const tag = document.createElement('style')
      tag.dataset.plugin = 'dsh-workbuddy'
      tag.dataset.pluginCss = CSS_TAG_ID
      tag.textContent = CSS
      document.head.appendChild(tag)
    }

    /** 通用取数 hook：进页面取一次 + 每 interval 轮询 + 点击强刷。 */
    function useEndpoint(path, intervalMs) {
      const [state, setState] = React.useState({ phase: 'loading', data: null, error: null })
      const load = React.useCallback(async () => {
        try {
          const res = await fetch(path, { credentials: 'same-origin', cache: 'no-store' })
          const data = await res.json()
          if (data !== null && typeof data === 'object' && data.ok === true) {
            setState({ phase: 'ready', data, error: null })
          } else {
            setState({ phase: 'error', data: data ?? null, error: String(data?.error ?? '读取失败') })
          }
        } catch (error) {
          setState({ phase: 'error', data: null, error: String(error && error.message ? error.message : error) })
        }
      }, [path])
      React.useEffect(() => {
        let alive = true
        const tick = () => { if (alive) void load() }
        tick()
        const timer = setInterval(tick, intervalMs)
        return () => { alive = false; clearInterval(timer) }
      }, [load, intervalMs])
      return [state, load]
    }

    const rowClass = extra => 'wb-row' + (extra === undefined ? '' : ' ' + extra)

    /** 积分行。 */
    function CreditRow(props) {
      const { rail } = props
      const [state, load] = useEndpoint('/api/workbuddy-quota', 30_000)
      const ready = state.phase === 'ready'
      const text = ready ? String(Math.round(state.data.total)) : state.phase === 'loading' ? '…' : '—'
      const tip = ready
        ? `WorkBuddy 剩余积分 ${state.data.total}\n读取于 ${state.data.fetchedAt}\n每 30 秒刷新，点击立即刷新`
        : state.phase === 'error' ? `积分读取失败：${state.error}\n点击重试` : '正在读取积分…'
      return React.createElement('div', {
        className: rowClass('clickable' + (ready ? '' : ' is-error')),
        title: tip,
        role: 'button',
        tabIndex: 0,
        'data-wb-row': 'credit',
        onClick: () => { void load() },
        onKeyDown: event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); void load() } },
      },
      rail ? null : React.createElement('span', { className: 'wb-row-label' }, '积分'),
      React.createElement('span', { className: 'wb-row-value' }, text))
    }

    /** 余额行（DeepSeek 官方账号钱包）。 */
    function BalanceRow(props) {
      const { rail } = props
      const [state, load] = useEndpoint('/api/workbuddy-balance', 60_000)
      const ready = state.phase === 'ready'
      const symbol = ready && state.data.currency === 'USD' ? '$' : '¥'
      const text = ready
        ? symbol + Number(state.data.total).toFixed(2)
        : state.phase === 'loading' ? '…' : '—'
      const tip = ready
        ? `DeepSeek 余额 ${symbol}${Number(state.data.total).toFixed(2)}（充值 ${symbol}${Number(state.data.topped).toFixed(2)} · 赠送 ${symbol}${Number(state.data.granted).toFixed(2)}）\n读取于 ${state.data.fetchedAt}`
        : state.phase === 'error' ? `余额读取失败：${state.error}` : '正在读取余额…'
      return React.createElement('div', {
        className: rowClass('clickable' + (ready ? '' : ' is-error')),
        title: tip,
        role: 'button',
        tabIndex: 0,
        'data-wb-row': 'balance',
        onClick: () => { void load() },
        onKeyDown: event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); void load() } },
      },
      rail ? null : React.createElement('span', { className: 'wb-row-label' }, '余额'),
      React.createElement('span', { className: 'wb-row-value' }, text))
    }

    /** 峰谷行。 */
    function PeakRow(props) {
      const { rail } = props
      const now = useClock()
      const phase = phaseAt(now)
      const target = nextSwitch(now)
      const name = phase.reason === 'holiday' ? '节假日' : phase.reason === 'weekend' ? '周末' : phase.peak ? '峰时' : '谷时'
      const countdown = countdownText(target, now)
      const nextInto = target === null ? null : phaseAt(target).peak
      const tip = phase.reason === 'holiday'
        ? '节假日 · 全天谷价'
        : phase.reason === 'weekend'
          ? '周末 · 全天谷价'
          : phase.peak ? '当前峰时（高价时段）' : '当前谷时（半价时段）'
      const right = rail
        ? (phase.peak ? '峰' : '谷')
        : phase.reason === 'holiday' || phase.reason === 'weekend'
          ? name
          : `${name} · ${countdown}后${nextInto ? '峰时' : '谷时'}`
      return React.createElement('div', {
        className: rowClass(),
        title: `${tip}\n${nextInto === null ? '' : `下次切换 ${switchLabel(target)}（北京时间）→ ${nextInto ? '峰时' : '谷时'}`}`,
        'data-wb-row': 'peak',
        'data-phase': phase.peak ? 'peak' : 'off',
      },
      rail
        ? null
        : React.createElement('span', { className: 'wb-row-label' },
            React.createElement('i', { className: 'wb-peak-dot' }), '峰谷'),
      React.createElement('span', { className: 'wb-row-value' }, right))
    }

    /** 侧栏底部整块。 */
    function WorkBuddyFooter(props) {
      const rail = props.wide === false
      return React.createElement('div', { className: 'wb-stack' + (rail ? ' rail' : '') },
        React.createElement(CreditRow, { rail }),
        React.createElement(BalanceRow, { rail }),
        React.createElement(PeakRow, { rail }),
      )
    }

    const inject = ['slots']

    function apply(ctx) {
      ensureStyles()
      ctx.effect(
        () => ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register(
          { name: 'sidebar.footer.action', id: 'workbuddy.footer', order: 5, registrant: 'dsh-workbuddy' },
          WorkBuddyFooter,
        )),
        'dsh-workbuddy: sidebar footer',
      )
    }

    return { name: 'workbuddy', inject, apply }
  },
})
