import { useEffect, useMemo, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import { ClerkProvider, SignedIn, SignedOut, SignIn, useUser, useClerk } from '@clerk/clerk-react'
import { api, rupees } from './lib/api.js'

const rupeesStr = (r) => '₹' + Number(r || 0).toLocaleString('en-IN', { minimumFractionDigits: 2 })

// Count a number up to its target — the one place a value animates, to mark change.
function useCountUp(target) {
  const [val, setVal] = useState(target)
  const prev = useRef(target)
  useEffect(() => {
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    if (reduce || prev.current === target) { setVal(target); prev.current = target; return }
    const from = prev.current, to = target, start = performance.now(), dur = 480
    let raf
    const tick = (t) => {
      const p = Math.min(1, (t - start) / dur)
      const e = 1 - Math.pow(1 - p, 3)
      setVal(Math.round(from + (to - from) * e))
      if (p < 1) raf = requestAnimationFrame(tick)
      else prev.current = to
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [target])
  return val
}

const NAV = [
  { id: 'overview', label: 'Overview' },
  { id: 'policy', label: 'Policy' },
  { id: 'simulate', label: 'Payments' },
  { id: 'pending', label: 'Pending' },
  { id: 'decisions', label: 'Ledger' },
  { id: 'keys', label: 'Developers' },
]

const V_LABEL = { ALLOW: 'Cleared', STEP_UP: 'Step-up', BLOCK: 'Blocked' }
const V_TEXT = { ALLOW: 'text-cleared', STEP_UP: 'text-held', BLOCK: 'text-denied' }
const V_DOT = { ALLOW: 'bg-cleared', STEP_UP: 'bg-held', BLOCK: 'bg-denied' }

// The single status indicator, used identically everywhere a verdict appears.
function Verdict({ d, className = '' }) {
  return (
    <span className={`inline-flex items-center gap-1.5 font-medium ${V_TEXT[d]} ${className}`}>
      <i className={`h-1.5 w-1.5 rounded-full ${V_DOT[d]}`} />
      {V_LABEL[d]}
    </span>
  )
}

const clock = (ts) => {
  try { return new Date(ts).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }) }
  catch { return '—' }
}

// "Today" / "Yesterday" / "12 Sep" for ledger day separators.
function dayLabel(ts) {
  try {
    const d = new Date(ts), now = new Date()
    const startOf = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate())
    const diff = Math.round((startOf(now) - startOf(d)) / 86400000)
    if (diff === 0) return 'Today'
    if (diff === 1) return 'Yesterday'
    return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short' })
  } catch { return '' }
}

// A number that rolls to its target when it changes (reuses useCountUp).
function CountNum({ value, format }) {
  const n = useCountUp(value)
  return <>{format ? format(n) : n}</>
}

function StatusLine({ health, integrity }) {
  const item = (ok, label) => (
    <span className="flex items-center gap-1.5">
      <i className={`h-1.5 w-1.5 rounded-full ${ok ? 'bg-cleared' : 'bg-denied'}`} />{label}
    </span>
  )
  return (
    <div className="flex items-center gap-4 text-[11px] text-faint">
      {item(health?.status === 'ok', 'backend')}
      {item(!!health?.razorpay_configured, 'rail')}
      {item(!!integrity?.valid, 'chain sealed')}
    </div>
  )
}

// --- signal helpers ----------------------------------------------------------
function decidedBy(d) {
  if (d.decision === 'ALLOW') return null
  const det = d.deterministic_result?.decision
  if (d.decision === 'BLOCK') return det === 'BLOCK' ? 'rules' : 'AI judge'
  if (det === 'STEP_UP') return 'rules'
  if (d.risk_anomaly === true) return 'risk model'
  return 'AI judge'
}

function summarize(decisions) {
  const s = { total: decisions.length, ALLOW: 0, STEP_UP: 0, BLOCK: 0, cleared_paise: 0, flagged_paise: 0, executed: 0, by: { rules: 0, 'risk model': 0, 'AI judge': 0 } }
  for (const d of decisions) {
    s[d.decision] = (s[d.decision] || 0) + 1
    if (d.decision === 'ALLOW') { s.cleared_paise += d.amount_paise || 0; if (d.executed) s.executed += 1 }
    else { s.flagged_paise += d.amount_paise || 0; const b = decidedBy(d); if (b && s.by[b] != null) s.by[b] += 1 }
  }
  return s
}

const SIG_TEXT = { cleared: 'text-cleared', held: 'text-held', denied: 'text-denied', mute: 'text-faint' }
const SIG_DOT = { cleared: 'bg-cleared', held: 'bg-held', denied: 'bg-denied', mute: 'bg-faint' }

function signalStates(d) {
  const det = d.deterministic_result?.decision
  const rules = det === 'BLOCK' ? ['blocked', 'denied'] : det === 'STEP_UP' ? ['needs review', 'held'] : ['cleared', 'cleared']
  const risk = d.risk_anomaly === true ? ['unusual', 'held'] : d.risk_anomaly === false ? ['normal', 'cleared'] : ['not run', 'mute']
  let ai
  if (d.llm_status === 'ok') ai = d.manipulation_suspected ? ['manipulation', 'denied'] : d.intent_match === false ? ['intent mismatch', 'denied'] : ['intent match', 'cleared']
  else if (d.llm_status === 'skipped_block') ai = ['not needed', 'mute']
  else if (d.llm_status === 'failed') ai = ['unavailable', 'held']
  else ai = ['off', 'mute']
  return [
    { name: 'Rules', state: rules[0], tone: rules[1] },
    { name: 'Risk', state: risk[0], tone: risk[1] },
    { name: 'AI judge', state: ai[0], tone: ai[1] },
  ]
}

function Signals({ d }) {
  return (
    <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
      {signalStates(d).map((s) => (
        <span key={s.name} className="flex items-center gap-2 text-xs">
          <i className={`h-1.5 w-1.5 rounded-full ${SIG_DOT[s.tone]}`} />
          <span className="text-faint">{s.name}</span>
          <span className={SIG_TEXT[s.tone]}>{s.state}</span>
        </span>
      ))}
    </div>
  )
}

// --- Overview: KPIs ----------------------------------------------------------
function Metrics({ s, order, setOrder, onNav }) {
  const flaggedRate = s.total ? Math.round(((s.STEP_UP + s.BLOCK) / s.total) * 100) : 0
  const cellMap = {
    screened: { label: 'Screened', value: s.total, sub: 'payment intents', to: 'decisions' },
    cleared: { label: 'Cleared', value: s.ALLOW, sub: `${rupees(s.cleared_paise)} · ${s.executed} on rail`, to: 'decisions' },
    held: { label: 'Held / denied', value: s.STEP_UP + s.BLOCK, sub: `${flaggedRate}% flagged`, to: 'pending' },
    stopped: { label: 'Value stopped', value: s.flagged_paise, format: rupees, sub: 'held or denied', to: 'pending' },
  }
  return (
    <section>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {order.map((key) => {
          const c = cellMap[key]
          return (
            <DragCard key={key} id={key} order={order} setOrder={setOrder}>
              <div onClick={() => onNav(c.to)} className="panel h-full p-4">
                <div className="eyebrow">{c.label}</div>
                <div className="mono mt-2 text-[26px] font-semibold leading-none tracking-tight tnum text-paper">
                  <CountNum value={c.value} format={c.format} />
                </div>
                <div className="mt-2 text-xs text-faint">{c.sub}</div>
              </div>
            </DragCard>
          )
        })}
      </div>

      {s.total > 0 && (
        <div className="mt-4 flex flex-wrap items-center gap-x-6 gap-y-2">
          <div className="track flex h-1.5 min-w-[220px] flex-1 gap-px">
            {[['ALLOW', s.ALLOW, 'bg-cleared'], ['STEP_UP', s.STEP_UP, 'bg-held'], ['BLOCK', s.BLOCK, 'bg-denied']].map(([k, n, c]) =>
              n > 0 && <div key={k} className={`${c} transition-[width] duration-500 ease-out`} style={{ width: `${(n / s.total) * 100}%` }} />)}
          </div>
          <div className="flex flex-wrap gap-x-5 gap-y-1 text-xs text-faint">
            <span className="flex items-center gap-1.5"><i className="h-1.5 w-1.5 rounded-full bg-cleared" />{s.ALLOW} cleared</span>
            <span className="flex items-center gap-1.5"><i className="h-1.5 w-1.5 rounded-full bg-held" />{s.STEP_UP} step-up</span>
            <span className="flex items-center gap-1.5"><i className="h-1.5 w-1.5 rounded-full bg-denied" />{s.BLOCK} blocked</span>
          </div>
        </div>
      )}
    </section>
  )
}

// --- Overview: latest decision ----------------------------------------------
function Hero({ d, loaded, onOpen }) {
  const amount = useCountUp(d?.amount_paise || 0)
  if (!loaded) {
    return (
      <div className="panel p-6">
        <div className="sk h-3 w-28" />
        <div className="sk mt-5 h-9 w-48" />
        <div className="sk mt-6 h-4 w-2/3" />
      </div>
    )
  }
  if (!d) {
    return (
      <div className="panel px-6 py-10 text-center">
        <p className="text-sm text-mute">No decisions yet.</p>
        <p className="mt-1 text-sm text-faint">Screen a payment to see the latest clearance here.</p>
      </div>
    )
  }
  const reasons = (d.reasons || []).filter((r) => !r.startsWith('held pending'))
  return (
    <section key={d.request_id} onClick={onOpen} className="panel row-rise p-6">
      <div className="flex items-center justify-between">
        <span className="flex items-center gap-2">
          <i className="live-dot h-1.5 w-1.5 rounded-full bg-cleared" />
          <span className="eyebrow">Latest decision · {clock(d.timestamp)}</span>
        </span>
        <Verdict d={d.decision} className="text-sm" />
      </div>

      <div className="mt-4 flex items-baseline gap-3">
        <span className="mono text-[2.5rem] font-semibold leading-none tracking-tight tnum text-paper">{rupees(amount)}</span>
        <span className="text-sm text-mute">to {d.merchant || '—'}</span>
      </div>

      <div className="mt-5"><Signals d={d} /></div>

      <ul className="mt-5 space-y-1.5">
        {reasons.map((r, i) => <li key={i} className="text-sm leading-relaxed text-mute">{r}</li>)}
      </ul>

      <div className="mt-5 flex items-center gap-2 border-t border-line pt-4 text-xs text-faint">
        <span className="seal">seal {(d.entry_hash || '').slice(0, 12) || '—'}</span>
        {d.order_id && <><span>·</span><span className="seal">{d.order_id}</span></>}
      </div>
    </section>
  )
}

// --- Overview: breakdown + system -------------------------------------------
function CaughtBy({ s, onOpen }) {
  const flagged = s.STEP_UP + s.BLOCK
  const rows = [['Rules', s.by.rules], ['Risk model', s.by['risk model']], ['AI judge', s.by['AI judge']]]
  return (
    <section onClick={onOpen} className="panel h-full p-5">
      <h2 className="head">
        <span className="inline-block origin-left transition-transform duration-200 group-hover:scale-[1.06]">What's catching payments</span>
        {onOpen && <span className="ml-auto text-faint transition-transform duration-200 group-hover:translate-x-1">→</span>}
      </h2>
      <p className="mt-2 text-xs text-faint">Which layer drove each held or blocked verdict.</p>
      {flagged === 0 ? (
        <p className="mt-6 text-sm text-mute">Nothing flagged — every payment cleared.</p>
      ) : (
        <div className="mt-5 space-y-3.5">
          {rows.map(([name, n]) => {
            const pct = Math.round((n / flagged) * 100)
            return (
              <div key={name} className="flex items-center gap-4">
                <span className="w-20 shrink-0 text-xs text-mute">{name}</span>
                <div className="track h-1.5 flex-1"><div className="h-full bg-mute transition-[width] duration-500 ease-out" style={{ width: `${n > 0 ? Math.max(pct, 4) : 0}%` }} /></div>
                <span className="mono w-14 shrink-0 text-right text-xs tnum text-mute">{n} · {pct}%</span>
              </div>
            )
          })}
        </div>
      )}
    </section>
  )
}

function SystemPanel({ health, integrity, s }) {
  const rows = [
    ['Backend', health?.status === 'ok' ? 'online' : 'unreachable', health?.status === 'ok'],
    ['Razorpay rail', health?.razorpay_configured ? 'connected · test' : 'not configured', !!health?.razorpay_configured],
    ['Audit chain', integrity?.valid ? `sealed · ${integrity.entries} entries` : 'broken', !!integrity?.valid],
  ]
  const railRate = s.ALLOW ? Math.round((s.executed / s.ALLOW) * 100) : 0
  return (
    <section className="panel h-full p-5">
      <h2 className="head">System &amp; integrity</h2>
      <p className="mt-2 text-xs text-faint">Every decision is hash-chained and tamper-evident.</p>
      <div className="mt-4">
        {rows.map(([name, state, ok]) => (
          <div key={name} className="flex items-center justify-between border-t border-line py-3 first:border-t-0 first:pt-1">
            <span className="flex items-center gap-2 text-sm text-paper">
              <i className={`h-1.5 w-1.5 rounded-full ${ok ? 'bg-cleared' : 'bg-denied'}`} />{name}
            </span>
            <span className={`text-xs ${ok ? 'text-mute' : 'text-denied'}`}>{state}</span>
          </div>
        ))}
        <div className="flex items-center justify-between border-t border-line py-3">
          <span className="text-sm text-paper">Rail execution</span>
          <span className="mono text-xs tnum text-mute">{railRate}% of cleared</span>
        </div>
      </div>
    </section>
  )
}

// --- Overview: decision volume over time ------------------------------------
// Buckets decisions into up to 12 equal time slices across the observed range,
// counting each verdict. Honest histogram — no smoothing, no invented points.
function buildSeries(decisions) {
  const pts = decisions
    .map((d) => ({ t: new Date(d.timestamp).getTime(), v: d.decision }))
    .filter((p) => !Number.isNaN(p.t))
    .sort((a, b) => a.t - b.t)
  if (!pts.length) return null
  const min = pts[0].t, max = pts[pts.length - 1].t
  const span = Math.max(max - min, 1)
  const N = Math.min(12, Math.max(pts.length, 2))
  const size = span / N
  const buckets = Array.from({ length: N }, (_, i) => ({ t0: min + i * size, ALLOW: 0, STEP_UP: 0, BLOCK: 0, total: 0 }))
  for (const p of pts) {
    let idx = Math.floor((p.t - min) / size)
    if (idx >= N) idx = N - 1
    if (idx < 0) idx = 0
    buckets[idx][p.v] += 1
    buckets[idx].total += 1
  }
  const maxTotal = Math.max(1, ...buckets.map((b) => b.total))
  const byDay = max - min > 2 * 86400000
  const fmt = (t) => byDay
    ? new Date(t).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' })
    : new Date(t).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })
  return { buckets, maxTotal, fmt, min, max }
}

function ActivityChart({ decisions, loaded }) {
  const series = useMemo(() => buildSeries(decisions), [decisions])
  const [hover, setHover] = useState(null)
  const segs = [['ALLOW', 'bg-cleared'], ['STEP_UP', 'bg-held'], ['BLOCK', 'bg-denied']]
  return (
    <section className="panel p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="head">Decision volume</h2>
        <div className="flex flex-wrap gap-x-5 gap-y-1 text-xs text-faint">
          {[['Cleared', 'bg-cleared'], ['Step-up', 'bg-held'], ['Blocked', 'bg-denied']].map(([l, c]) => (
            <span key={l} className="flex items-center gap-1.5"><i className={`h-1.5 w-1.5 rounded-full ${c}`} />{l}</span>
          ))}
        </div>
      </div>
      <p className="mt-2 text-xs text-faint">Payments screened over time, by verdict.</p>

      {!loaded ? (
        <div className="sk mt-5 h-[168px] w-full" />
      ) : !series ? (
        <div className="mt-5 grid h-[168px] place-items-center text-sm text-faint">No activity yet — screen a payment to start the timeline.</div>
      ) : (
        <div className="mt-5">
          <div className="relative flex h-[168px] items-end gap-[3px]">
            {/* gridlines */}
            <div className="pointer-events-none absolute inset-0 flex flex-col justify-between">
              {[0, 1, 2].map((i) => <div key={i} className="h-px w-full bg-line/70" />)}
              <div className="h-px w-full bg-line" />
            </div>
            <span className="mono absolute right-0 top-0 text-[10px] tnum text-faint">{series.maxTotal}</span>
            {series.buckets.map((b, i) => (
              <div key={i} className="group relative flex h-full flex-1 flex-col justify-end"
                onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover((h) => (h === i ? null : h))}>
                {b.total > 0 && (
                  <div className="flex flex-col overflow-hidden rounded-[3px] transition-opacity duration-150"
                    style={{ height: `${(b.total / series.maxTotal) * 100}%`, opacity: hover === null || hover === i ? 1 : 0.4 }}>
                    {segs.map(([k, c]) => b[k] > 0 && (
                      <div key={k} className={c} style={{ flexGrow: b[k], minHeight: '2px' }} />
                    ))}
                  </div>
                )}
                {hover === i && b.total > 0 && (
                  <div className="pointer-events-none absolute bottom-full left-1/2 z-10 mb-2 -translate-x-1/2 whitespace-nowrap rounded-md border border-line2 bg-slab2 px-2.5 py-1.5 text-[11px] shadow-[0_10px_24px_-12px_rgba(0,0,0,0.9)]">
                    <div className="mono tnum text-paper">{series.fmt(b.t0)}</div>
                    <div className="mt-0.5 flex gap-2 text-faint">
                      <span className="text-cleared">{b.ALLOW}✓</span>
                      <span className="text-held">{b.STEP_UP}</span>
                      <span className="text-denied">{b.BLOCK}</span>
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
          <div className="mono mt-2 flex justify-between text-[10px] tnum text-faint">
            <span>{series.fmt(series.min)}</span>
            <span>{series.fmt(series.max)}</span>
          </div>
        </div>
      )}
    </section>
  )
}

// Ticks once a second to show how fresh the live feed is.
function UpdatedAgo({ at }) {
  const [, tick] = useState(0)
  useEffect(() => { const t = setInterval(() => tick((n) => n + 1), 1000); return () => clearInterval(t) }, [])
  if (!at) return null
  const s = Math.max(0, Math.round((Date.now() - at) / 1000))
  const label = s < 5 ? 'just now' : s < 60 ? `${s}s ago` : `${Math.floor(s / 60)}m ago`
  return <span className="text-faint">updated {label}</span>
}

// Actionable nudge on Overview when payments are held for confirmation.
function PendingBanner({ count, onReview }) {
  if (!count) return null
  return (
    <button onClick={onReview} className="press flex w-full items-center justify-between rounded-lg border border-held/40 bg-held/[0.06] px-4 py-3 text-left hover:bg-held/[0.1]">
      <span className="text-sm text-paper">
        <span className="mono tnum text-held">{count}</span> payment{count > 1 ? 's' : ''} awaiting your confirmation
      </span>
      <span className="text-xs text-held">Review →</span>
    </button>
  )
}

// --- Overview: ledger --------------------------------------------------------
function Ledger({ decisions, integrity, onVerify, flashId, loaded, updatedAt, onOpen }) {
  return (
    <section>
      <div className="mb-3 flex items-baseline justify-between">
        <button onClick={onOpen} className="head group press -m-1 rounded p-1 text-left hover:text-paper">
          <span className="inline-block origin-left transition-transform duration-200 group-hover:scale-[1.06]">Recent decisions</span>
          <span className="flex items-center gap-1 text-[10px] font-medium text-faint"><i className="live-dot h-1.5 w-1.5 rounded-full bg-cleared" />live</span>
          <span className="text-faint transition-transform duration-200 group-hover:translate-x-1">→</span>
        </button>
        <div className="flex items-center gap-3 text-xs">
          <UpdatedAgo at={updatedAt} />
          <button onClick={(e) => { e.stopPropagation(); onVerify() }} className="press text-faint hover:text-paper">
            {integrity ? (integrity.valid ? `sealed · ${integrity.entries} entries` : 'chain broken') : 'verify'}
          </button>
        </div>
      </div>
      {!loaded ? (
        <div className="panel space-y-2 p-4">{[0, 1, 2, 3].map((i) => <div key={i} className="sk h-7 w-full" />)}</div>
      ) : decisions.length === 0 ? (
        <div className="panel px-5 py-10 text-center text-sm text-faint">The ledger is empty.</div>
      ) : (
        <div className="panel overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line text-left">
                <th className="eyebrow px-5 py-3 font-medium">Time</th>
                <th className="eyebrow py-3 pr-4 font-medium">Payee</th>
                <th className="eyebrow py-3 pr-4 text-right font-medium">Amount</th>
                <th className="eyebrow hidden py-3 pr-4 font-medium sm:table-cell">Seal</th>
                <th className="eyebrow py-3 pr-5 text-right font-medium">Verdict</th>
              </tr>
            </thead>
            <tbody>
              {(() => {
                const rows = []
                let lastDay = null, first = true
                for (const d of decisions) {
                  const label = dayLabel(d.timestamp)
                  if (label !== lastDay) {
                    rows.push(
                      <tr key={`sep-${d.request_id}`}>
                        <td colSpan={5} className={`eyebrow bg-ink/40 px-5 py-1.5 ${first ? '' : 'border-t border-line'}`}>{label}</td>
                      </tr>
                    )
                    lastDay = label; first = false
                  }
                  rows.push(
                    <tr key={d.request_id} onClick={onOpen} className={`border-t border-line/70 transition-colors hover:bg-slab2 ${onOpen ? 'cursor-pointer' : ''} ${d.request_id === flashId ? 'row-rise' : ''}`}>
                      <td className="mono px-5 py-3 tnum text-faint">{clock(d.timestamp)}</td>
                      <td className="py-3 pr-4 text-paper">{d.merchant || '—'}</td>
                      <td className="mono py-3 pr-4 text-right tnum text-paper">{rupees(d.amount_paise)}</td>
                      <td className="seal hidden py-3 pr-4 text-faint sm:table-cell">{(d.entry_hash || '').slice(0, 8)}</td>
                      <td className="py-3 pr-5 text-right"><Verdict d={d.decision} className="justify-end text-xs" /></td>
                    </tr>
                  )
                }
                return rows
              })()}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}

// --- Simulate ----------------------------------------------------------------
const EMPTY_FORM = { amount_rupees: '', merchant: '', category: '', user_intent: '', agent_reason: '' }
const FIELDS = [
  ['merchant', 'Merchant', 'BlueBottle Coffee'],
  ['category', 'Category', 'food'],
  ['user_intent', 'What you authorized', 'buy a coffee'],
  ['agent_reason', "Agent's stated reason", 'purchasing a coffee'],
]

function ResultCard({ res, busy, onGoPending }) {
  if (busy) return <div className="panel p-6"><div className="sk h-3 w-16" /><div className="sk mt-4 h-9 w-40" /><div className="sk mt-5 h-4 w-3/4" /></div>
  if (!res) {
    return (
      <div className="panel grid min-h-[15rem] place-items-center px-6 text-center">
        <p className="max-w-xs text-sm text-faint">Send an intent to see the verdict, with the rules, risk, and AI reasons behind it.</p>
      </div>
    )
  }
  const reasons = (res.reasons || []).filter((r) => !r.startsWith('held pending'))
  const note = res.decision === 'ALLOW'
    ? (res.executed ? `Executed on the rail · order ${res.order_id}` : (res.execution_error || 'Cleared.'))
    : res.decision === 'STEP_UP' ? 'Held for confirmation — approve it under Pending.'
      : 'Blocked — no money action was taken.'
  return (
    <div key={res.request_id} className="panel row-rise p-6">
      <div className="flex items-center justify-between">
        <span className="eyebrow">Verdict</span>
        <Verdict d={res.decision} className="text-sm" />
      </div>
      <div className="mono mt-3 text-[2rem] font-semibold leading-none tracking-tight tnum text-paper">{rupeesStr(res.amount_rupees)}</div>
      <ul className="mt-5 space-y-1.5">
        {reasons.map((r, i) => <li key={i} className="text-sm leading-relaxed text-mute">{r}</li>)}
      </ul>
      <div className="mt-5 flex items-center justify-between gap-3 border-t border-line pt-4">
        <p className="text-xs text-faint">{note}</p>
        {res.decision === 'STEP_UP' && onGoPending && (
          <button onClick={onGoPending} className="btn-line shrink-0 py-1 text-xs">Review in Pending</button>
        )}
      </div>
    </div>
  )
}

function Simulate({ onDone, user, onGoPending }) {
  const [form, setForm] = useState({ ...EMPTY_FORM })
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)
  const [res, setRes] = useState(null)
  const [drafting, setDrafting] = useState(null)
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }))

  async function draftReason(style) {
    setDrafting(style); setErr(null)
    try {
      const out = await api('/simulate/agent-note', {
        method: 'POST',
        body: JSON.stringify({ style, amount_rupees: String(form.amount_rupees || ''), merchant: form.merchant, category: form.category, user_intent: form.user_intent }),
      })
      setForm((f) => ({ ...f, agent_reason: out.agent_reason }))
    } catch (e) { setErr(e.message) }
    finally { setDrafting(null) }
  }

  const complete =
    String(form.amount_rupees).trim() && Number(form.amount_rupees) > 0 &&
    FIELDS.every(([k]) => String(form[k]).trim())

  async function submit(e) {
    e.preventDefault()
    if (!complete) { setErr('Fill in every field before sending.'); return }
    setBusy(true); setErr(null); setRes(null)
    try {
      const body = { user_id: user.id, agent_id: 'sim-agent', currency: 'INR', ...form, amount_rupees: String(form.amount_rupees) }
      const out = await api('/authorize', { method: 'POST', body: JSON.stringify(body) })
      setRes(out); onDone?.()
    } catch (e) { setErr(e.message) }
    finally { setBusy(false) }
  }

  return (
    <section>
      <h2 className="head">Screen a payment intent</h2>
      {/* heading kept action-focused; nav label is "Payments" */}
      <p className="mt-2 max-w-xl text-xs text-faint">Describe a payment an agent wants to make on your behalf. AURA clears, holds, or blocks it — live.</p>

      <div className="mt-5 grid gap-6 lg:grid-cols-2">
        <form onSubmit={submit} className="space-y-4">
          <label className="block">
            <span className="eyebrow">Amount (₹)</span>
            <input className="field mono mt-2 tnum" inputMode="decimal" value={form.amount_rupees} onChange={set('amount_rupees')} placeholder="" />
          </label>
          {FIELDS.map(([k, label]) => (
            <label key={k} className="block">
              <span className="eyebrow">{label}</span>
              <input className="field mt-2" value={form[k]} onChange={set(k)} placeholder="" />
            </label>
          ))}
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="text-faint">Draft the agent's reason with AI:</span>
            {[['honest', 'Honest'], ['borderline', 'Borderline'], ['manipulative', 'Manipulative']].map(([s, label]) => (
              <button key={s} type="button" onClick={() => draftReason(s)} disabled={!!drafting}
                className="press rounded-md border border-line px-2 py-1 text-mute hover:border-mute hover:text-paper disabled:opacity-40">
                {drafting === s ? '…' : label}
              </button>
            ))}
          </div>
          {err && <p className="text-sm text-denied">{err}</p>}
          <div className="flex items-center gap-4 pt-1">
            <button type="submit" disabled={busy || !complete} className="btn-solid">{busy ? 'Screening…' : 'Send through AURA'}</button>
            <button type="button" onClick={() => { setForm({ ...EMPTY_FORM }); setErr(null); setRes(null) }} className="press text-xs text-faint hover:text-paper">Clear</button>
            <span className="ml-auto text-xs text-faint">signed in as {user.handle || user.name}</span>
          </div>
        </form>

        <ResultCard res={res} busy={busy} onGoPending={onGoPending} />
      </div>
    </section>
  )
}

// --- Decisions ---------------------------------------------------------------
const FILTERS = [['ALL', 'All'], ['ALLOW', 'Cleared'], ['STEP_UP', 'Step-up'], ['BLOCK', 'Blocked']]

function DecisionRow({ d, userLabel, open, onToggle }) {
  const reasons = (d.reasons || []).filter((r) => !r.startsWith('held pending'))
  return (
    <>
      <tr onClick={onToggle} className="cursor-pointer border-t border-line/70 transition-colors hover:bg-slab2">
        <td className="mono px-5 py-3 tnum text-faint">{clock(d.timestamp)}</td>
        <td className="py-3 pr-4 text-paper">{d.merchant || '—'}</td>
        <td className="hidden py-3 pr-4 text-faint sm:table-cell">{userLabel}</td>
        <td className="mono py-3 pr-4 text-right tnum text-paper">{rupees(d.amount_paise)}</td>
        <td className="py-3 pr-4 text-right"><Verdict d={d.decision} className="justify-end text-xs" /></td>
        <td className="py-3 pr-5 text-right text-faint"><span className={`inline-block transition-transform ${open ? 'rotate-90' : ''}`}>›</span></td>
      </tr>
      {open && (
        <tr className="border-t border-line/70 bg-ink">
          <td colSpan={6} className="px-5 py-4">
            <Signals d={d} />
            <ul className="mt-4 space-y-1.5">
              {reasons.map((r, i) => <li key={i} className="text-sm leading-relaxed text-mute">{r}</li>)}
            </ul>
            {d.entry_hash && <div className="seal mt-3 text-xs text-faint">seal {d.entry_hash.slice(0, 16)}…</div>}
          </td>
        </tr>
      )}
    </>
  )
}

function Decisions({ decisions, integrity, onVerify, loaded, user }) {
  const userLabel = user.handle || user.name || user.id
  const [filter, setFilter] = useState('ALL')
  const [q, setQ] = useState('')
  const [open, setOpen] = useState(null)
  const counts = useMemo(() => {
    const c = { ALL: decisions.length, ALLOW: 0, STEP_UP: 0, BLOCK: 0 }
    for (const d of decisions) c[d.decision] = (c[d.decision] || 0) + 1
    return c
  }, [decisions])
  const query = q.trim().toLowerCase()
  const shown = decisions.filter((d) =>
    (filter === 'ALL' || d.decision === filter) &&
    (!query || (d.merchant || '').toLowerCase().includes(query) || (d.user_id || '').toLowerCase().includes(query)))

  return (
    <section>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="head">Ledger
          <span className="flex items-center gap-1 text-[10px] font-medium text-faint"><i className="live-dot h-1.5 w-1.5 rounded-full bg-cleared" />live</span>
        </h2>
        <button onClick={onVerify} className="press text-xs text-faint hover:text-paper">
          {integrity ? (integrity.valid ? `chain sealed · ${integrity.entries} entries` : 'chain broken') : 'verify'}
        </button>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <div className="inline-flex rounded-md border border-line p-0.5">
          {FILTERS.map(([id, label]) => (
            <button key={id} onClick={() => setFilter(id)}
              className={`press rounded px-2.5 py-1 text-xs ${filter === id ? 'bg-slab2 text-paper' : 'text-mute hover:text-paper'}`}>
              {label} <span className="tnum text-faint">{counts[id] ?? 0}</span>
            </button>
          ))}
        </div>
        <input className="field ml-auto max-w-[15rem]" placeholder="" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>

      {!loaded ? (
        <div className="panel mt-4 space-y-2 p-4">{[0, 1, 2, 3, 4].map((i) => <div key={i} className="sk h-7 w-full" />)}</div>
      ) : shown.length === 0 ? (
        <div className="panel mt-4 px-5 py-10 text-center text-sm text-faint">No decisions match.</div>
      ) : (
        <div className="panel mt-4 overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line text-left">
                <th className="eyebrow px-5 py-3 font-medium">Time</th>
                <th className="eyebrow py-3 pr-4 font-medium">Payee</th>
                <th className="eyebrow hidden py-3 pr-4 font-medium sm:table-cell">User</th>
                <th className="eyebrow py-3 pr-4 text-right font-medium">Amount</th>
                <th className="eyebrow py-3 pr-4 text-right font-medium">Verdict</th>
                <th className="py-3 pr-5" />
              </tr>
            </thead>
            <tbody>
              {shown.map((d) => <DecisionRow key={d.request_id} d={d} userLabel={userLabel} open={open === d.request_id} onToggle={() => setOpen(open === d.request_id ? null : d.request_id)} />)}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}

// --- Policy ------------------------------------------------------------------
function TagInput({ label, hint, values, onChange, placeholder }) {
  const [draft, setDraft] = useState('')
  const add = (v) => { v = v.trim(); if (v && !values.includes(v)) onChange([...values, v]); setDraft('') }
  // Commit synchronously on blur so a value typed but not "Entered" is still
  // captured before a Save click reads the policy state.
  const commit = (v) => { if (v.trim()) flushSync(() => add(v)) }
  return (
    <div>
      <span className="eyebrow">{label}</span>
      {hint && <span className="ml-2 text-[11px] text-faint">{hint}</span>}
      <div className="mt-2 flex flex-wrap items-center gap-1.5 rounded-md border border-line bg-ink px-2.5 py-2 transition-colors focus-within:border-mute">
        {values.map((v) => (
          <span key={v} className="inline-flex items-center gap-1.5 rounded border border-line2 px-2 py-0.5 text-xs text-paper">
            {v}<button type="button" onClick={() => onChange(values.filter((x) => x !== v))} className="text-faint hover:text-denied">×</button>
          </span>
        ))}
        <input value={draft} onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); add(draft) } }}
          onBlur={() => commit(draft)} placeholder={values.length ? '' : placeholder}
          className="min-w-[7rem] flex-1 bg-transparent text-sm text-paper outline-none placeholder-faint" />
      </div>
    </div>
  )
}

const CAP_FIELDS = [['per_txn_cap', 'Per transaction (₹)'], ['daily_cap', 'Daily cap (₹)'], ['monthly_cap', 'Monthly cap (₹)']]
const VEL_FIELDS = [['max_txns_per_hour', 'Max / hour'], ['max_txns_per_day', 'Max / day']]

function normalizePolicy(p) {
  return {
    per_txn_cap: p.per_txn_cap ?? '', daily_cap: p.daily_cap ?? '', monthly_cap: p.monthly_cap ?? '',
    max_txns_per_hour: p.max_txns_per_hour ?? '', max_txns_per_day: p.max_txns_per_day ?? '',
    merchant_allowlist: p.merchant_allowlist ?? [], merchant_denylist: p.merchant_denylist ?? [], category_allowlist: p.category_allowlist ?? [],
  }
}

function Policy({ user }) {
  const [p, setP] = useState(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState(null)
  const [err, setErr] = useState(null)

  async function fetchPolicy(uid) {
    setLoading(true); setErr(null); setMsg(null)
    try { const r = await api(`/policy/${encodeURIComponent(uid)}`); setP(normalizePolicy(r.policy)) }
    catch (e) { setErr(e.message) } finally { setLoading(false) }
  }
  useEffect(() => { fetchPolicy(user.id) }, [user.id])
  const setCap = (k) => (e) => { setP((s) => ({ ...s, [k]: e.target.value })); setMsg(null) }

  async function save(e) {
    e.preventDefault(); setErr(null); setMsg(null)
    if (!p.per_txn_cap || Number(p.per_txn_cap) <= 0) { setErr('Per-transaction cap is required and must be greater than 0.'); return }
    setBusy(true)
    try {
      const body = {
        per_txn_cap: String(p.per_txn_cap),
        daily_cap: p.daily_cap === '' ? null : String(p.daily_cap),
        monthly_cap: p.monthly_cap === '' ? null : String(p.monthly_cap),
        max_txns_per_hour: p.max_txns_per_hour === '' ? null : Number(p.max_txns_per_hour),
        max_txns_per_day: p.max_txns_per_day === '' ? null : Number(p.max_txns_per_day),
        merchant_allowlist: p.merchant_allowlist, merchant_denylist: p.merchant_denylist, category_allowlist: p.category_allowlist,
      }
      await api(`/policy/${encodeURIComponent(user.id)}`, { method: 'PUT', body: JSON.stringify(body) })
      setMsg('Policy saved.')
    } catch (e) { setErr(e.message) } finally { setBusy(false) }
  }

  return (
    <section>
      <h2 className="head">Policy — the hard floor</h2>
      <p className="mt-2 max-w-2xl text-xs text-faint">Caps and lists the deterministic engine enforces before any AI runs. The AI can only make a verdict stricter, never looser.</p>

      <div className="mt-4 text-xs text-faint">
        Editing policy for <span className="text-paper">{user.name}</span>
        {user.handle ? <span className="text-mute"> · {user.handle}</span> : null}
      </div>

      {loading || !p ? (
        <div className="mt-6 grid gap-6 lg:grid-cols-2"><div className="sk h-48 w-full" /><div className="sk h-48 w-full" /></div>
      ) : (
        <form onSubmit={save} className="mt-6 grid gap-x-10 gap-y-8 lg:grid-cols-2">
          <div className="space-y-6">
            <div>
              <h3 className="text-[13px] font-semibold text-paper">Spending caps</h3>
              <div className="mt-3 grid grid-cols-3 gap-3">
                {CAP_FIELDS.map(([k, label]) => (
                  <label key={k} className="block">
                    <span className="eyebrow">{label}</span>
                    <input className="field mono mt-2 tnum" inputMode="decimal" value={p[k]} onChange={setCap(k)} placeholder="" />
                  </label>
                ))}
              </div>
            </div>
            <div>
              <h3 className="text-[13px] font-semibold text-paper">Payment frequency</h3>
              <div className="mt-3 grid grid-cols-2 gap-3">
                {VEL_FIELDS.map(([k, label]) => (
                  <label key={k} className="block">
                    <span className="eyebrow">{label}</span>
                    <input className="field mono mt-2 tnum" inputMode="numeric" value={p[k]} onChange={setCap(k)} placeholder="" />
                  </label>
                ))}
              </div>
            </div>
          </div>

          <div className="space-y-5">
            <h3 className="text-[13px] font-semibold text-paper">Merchants &amp; categories</h3>
            <TagInput label="Trusted merchants" hint="always allowed" values={p.merchant_allowlist} onChange={(v) => setP((s) => ({ ...s, merchant_allowlist: v }))} placeholder="" />
            <TagInput label="Blocked merchants" hint="always denied" values={p.merchant_denylist} onChange={(v) => setP((s) => ({ ...s, merchant_denylist: v }))} placeholder="" />
            <TagInput label="Allowed categories" hint="blank = all allowed" values={p.category_allowlist} onChange={(v) => setP((s) => ({ ...s, category_allowlist: v }))} placeholder="" />
          </div>

          <div className="flex items-center gap-4 lg:col-span-2">
            <button type="submit" disabled={busy} className="btn-solid">{busy ? 'Saving…' : 'Save policy'}</button>
            {msg && <span className="text-sm text-cleared">{msg}</span>}
            {err && <span className="text-sm text-denied">{err}</span>}
          </div>
        </form>
      )}
    </section>
  )
}

// --- Pending -----------------------------------------------------------------
function Pending({ pending, loaded, onChange }) {
  const [busy, setBusy] = useState(null)
  const [err, setErr] = useState(null)
  async function approve(id, remember) {
    setBusy(id + remember); setErr(null)
    try { await api(`/confirm/${encodeURIComponent(id)}?remember=${remember}`, { method: 'POST' }); await onChange?.() }
    catch (e) { setErr(e.message) } finally { setBusy(null) }
  }
  return (
    <section>
      <div className="flex items-baseline justify-between">
        <h2 className="head">Pending confirmations</h2>
        {pending.length > 0 && <span className="mono text-xs tnum text-mute">{pending.length} held</span>}
      </div>
      <p className="mt-2 text-xs text-faint">Payments AURA stepped up. They execute only when you approve them here.</p>
      {err && <p className="mt-3 text-sm text-denied">{err}</p>}

      {!loaded ? (
        <div className="panel mt-5 space-y-3 p-5">{[0, 1].map((i) => <div key={i} className="sk h-12 w-full" />)}</div>
      ) : pending.length === 0 ? (
        <div className="panel mt-5 px-5 py-12 text-center">
          <p className="text-sm text-mute">Nothing waiting.</p>
          <p className="mt-1 text-sm text-faint">Held payments will appear here for approval.</p>
        </div>
      ) : (
        <div className="panel mt-5">
          {pending.map((r) => (
            <div key={r.request_id} className="row-rise flex flex-wrap items-center justify-between gap-4 border-t border-line px-5 py-4 first:border-t-0">
              <div>
                <div className="flex items-baseline gap-3">
                  <span className="mono text-lg font-semibold tnum text-paper">{rupees(r.amount_paise)}</span>
                  <span className="text-sm text-mute">to {r.merchant || '—'}</span>
                  <Verdict d="STEP_UP" className="text-xs" />
                </div>
                <div className="mt-1.5 text-xs text-faint">
                  {r.user_intent ? <>“{r.user_intent}” · </> : null}{r.category || 'uncategorised'} · {r.user_id} · {clock(r.timestamp)}
                </div>
              </div>
              <div className="flex items-center gap-2">
                <button onClick={() => approve(r.request_id, true)} disabled={!!busy} className="btn-line">{busy === r.request_id + true ? '…' : 'Approve & remember'}</button>
                <button onClick={() => approve(r.request_id, false)} disabled={!!busy} className="btn-solid">{busy === r.request_id + false ? '…' : 'Approve'}</button>
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  )
}

// --- Developers: API keys + integration -------------------------------------
function CopyButton({ text, className = '', label = 'Copy' }) {
  const [done, setDone] = useState(false)
  async function copy() {
    try { await navigator.clipboard.writeText(text); setDone(true); setTimeout(() => setDone(false), 1400) }
    catch { /* clipboard blocked — ignore */ }
  }
  return (
    <button type="button" onClick={copy} className={`press text-xs ${done ? 'text-cleared' : 'text-faint hover:text-paper'} ${className}`}>
      {done ? 'Copied' : label}
    </button>
  )
}

// The integration snippets shown on the landing page and Developers tab. `origin`
// is the live host; `key` is the user's key (or a readable placeholder).
function codeSamples(origin, key) {
  const k = key || 'aura_sk_test_your_key_here'
  return {
    cURL: `curl -X POST ${origin}/authorize \\
  -H "Authorization: Bearer ${k}" \\
  -H "Idempotency-Key: order-8f3a1c" \\
  -H "Content-Type: application/json" \\
  -d '{
    "agent_id": "my-shopping-agent",
    "amount_rupees": "1499.00",
    "merchant": "BlueBottle Coffee",
    "category": "food",
    "user_intent": "buy a coffee",
    "agent_reason": "purchasing a coffee for the user"
  }'`,
    Python: `import requests

resp = requests.post(
    "${origin}/authorize",
    headers={
        "Authorization": "Bearer ${k}",
        "Idempotency-Key": "order-8f3a1c",   # retry-safe: same key replays the verdict
    },
    json={
        "agent_id": "my-shopping-agent",
        "amount_rupees": "1499.00",
        "merchant": "BlueBottle Coffee",
        "category": "food",
        "user_intent": "buy a coffee",
        "agent_reason": "purchasing a coffee for the user",
    },
)
verdict = resp.json()          # -> {"decision": "ALLOW" | "STEP_UP" | "BLOCK", ...}
if verdict["decision"] != "ALLOW":
    raise PermissionError(verdict["reasons"])`,
    JavaScript: `const resp = await fetch("${origin}/authorize", {
  method: "POST",
  headers: {
    "Authorization": "Bearer ${k}",
    "Idempotency-Key": "order-8f3a1c",   // retry-safe: same key replays the verdict
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    agent_id: "my-shopping-agent",
    amount_rupees: "1499.00",
    merchant: "BlueBottle Coffee",
    category: "food",
    user_intent: "buy a coffee",
    agent_reason: "purchasing a coffee for the user",
  }),
})
const verdict = await resp.json()   // { decision: "ALLOW" | "STEP_UP" | "BLOCK", ... }
if (verdict.decision !== "ALLOW") throw new Error(verdict.reasons.join("; "))`,
  }
}

function CodeBlock({ samples }) {
  const langs = Object.keys(samples)
  const [lang, setLang] = useState(langs[0])
  return (
    <div className="panel overflow-hidden">
      <div className="flex items-center justify-between border-b border-line px-3 py-2">
        <div className="inline-flex gap-0.5">
          {langs.map((l) => (
            <button key={l} onClick={() => setLang(l)}
              className={`press rounded px-2 py-1 text-xs ${lang === l ? 'bg-slab2 text-paper' : 'text-mute hover:text-paper'}`}>{l}</button>
          ))}
        </div>
        <CopyButton text={samples[lang]} />
      </div>
      <pre className="mono overflow-x-auto px-4 py-3.5 text-[12.5px] leading-relaxed text-mute"><code>{samples[lang]}</code></pre>
    </div>
  )
}

function relTime(iso) {
  if (!iso) return 'never'
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000))
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return new Date(iso).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' })
}

function Developers({ user }) {
  const [keys, setKeys] = useState(null)
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)
  const [fresh, setFresh] = useState(null)   // the one-time plaintext key just minted
  const [test, setTest] = useState(null)     // result of a live "test this key" call
  const origin = typeof window !== 'undefined' ? window.location.origin : ''

  async function load() {
    try { const r = await api(`/keys?user_id=${encodeURIComponent(user.id)}`); setKeys(r.keys || []) }
    catch (e) { setErr(e.message) }
  }
  useEffect(() => { load() }, [user.id])

  async function create(e) {
    e.preventDefault(); setBusy(true); setErr(null); setTest(null)
    try {
      const r = await api('/keys', { method: 'POST', body: JSON.stringify({ user_id: user.id, name: name.trim() }) })
      setFresh(r); setName(''); await load()
    } catch (e) { setErr(e.message) } finally { setBusy(false) }
  }

  // Fire a real key-authenticated /authorize with a sample payment, so the user
  // sees their key work end-to-end. Only possible right after creation, while we
  // still hold the plaintext (existing keys are stored hashed).
  async function testKey() {
    setTest({ busy: true })
    try {
      const out = await api('/authorize', {
        method: 'POST',
        headers: { Authorization: `Bearer ${fresh.key}` },
        body: JSON.stringify({
          agent_id: 'test-agent', amount_rupees: '1499.00', merchant: 'BlueBottle Coffee',
          category: 'food', user_intent: 'buy a coffee', agent_reason: 'purchasing a coffee for the user',
        }),
      })
      setTest({ res: out })
    } catch (e) { setTest({ err: e.message }) }
  }

  async function revoke(id) {
    setErr(null)
    try { await api(`/keys/${encodeURIComponent(id)}?user_id=${encodeURIComponent(user.id)}`, { method: 'DELETE' }); setFresh((f) => (f?.id === id ? null : f)); await load() }
    catch (e) { setErr(e.message) }
  }

  const samples = codeSamples(origin, fresh?.key)

  return (
    <section>
      <h2 className="head">Developers — connect an agent</h2>
      <p className="mt-2 max-w-2xl text-xs text-faint">
        Give an AI agent an API key and it screens every payment through AURA before spending. The key
        authenticates as <span className="text-mute">{user.handle || user.name}</span> — its verdicts, policy, and audit trail are all yours.
      </p>

      <div className="mt-6 grid gap-x-10 gap-y-8 lg:grid-cols-2">
        {/* keys */}
        <div className="space-y-5">
          <div>
            <h3 className="text-[13px] font-semibold text-paper">API keys</h3>
            <form onSubmit={create} className="mt-3 flex gap-2">
              <input className="field" value={name} onChange={(e) => setName(e.target.value)} placeholder="Name this key (e.g. shopping agent)" />
              <button type="submit" disabled={busy} className="btn-solid shrink-0">{busy ? 'Creating…' : 'Create key'}</button>
            </form>
            {err && <p className="mt-2 text-sm text-denied">{err}</p>}
          </div>

          {fresh && (
            <div className="row-rise rounded-lg border border-cleared/40 bg-cleared/[0.05] p-4">
              <div className="flex items-center justify-between">
                <span className="eyebrow text-cleared">New key — copy it now</span>
                <CopyButton text={fresh.key} label="Copy key" />
              </div>
              <div className="mono mt-2 break-all text-[12.5px] text-paper">{fresh.key}</div>
              <p className="mt-2 text-xs text-faint">This is the only time the full key is shown. Store it somewhere safe — we keep only a hash.</p>
              <div className="mt-3 flex flex-wrap items-center gap-3 border-t border-cleared/20 pt-3">
                <button onClick={testKey} disabled={test?.busy} className="btn-line py-1 text-xs">{test?.busy ? 'Testing…' : 'Send a test request'}</button>
                {test?.res && (
                  <span className="flex items-center gap-2 text-xs">
                    <Verdict d={test.res.decision} className="text-xs" />
                    <span className="text-faint">— a real test-mode screening ran with this key</span>
                  </span>
                )}
                {test?.err && <span className="text-xs text-denied">{test.err}</span>}
              </div>
            </div>
          )}

          <div className="panel">
            {keys === null ? (
              <div className="space-y-2 p-4">{[0, 1].map((i) => <div key={i} className="sk h-10 w-full" />)}</div>
            ) : keys.length === 0 ? (
              <div className="px-5 py-10 text-center text-sm text-faint">No keys yet. Create one to connect an agent.</div>
            ) : keys.map((k) => (
              <div key={k.id} className="flex flex-wrap items-center justify-between gap-3 border-t border-line px-4 py-3 first:border-t-0">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm text-paper">{k.name || 'Untitled key'}</span>
                    <span className="mono text-xs text-faint">{k.prefix}••••••</span>
                  </div>
                  <div className="mt-0.5 text-xs text-faint">created {relTime(k.created_at)} · used {relTime(k.last_used_at)}</div>
                </div>
                <button onClick={() => revoke(k.id)} className="press text-xs text-faint hover:text-denied">Revoke</button>
              </div>
            ))}
          </div>
        </div>

        {/* integration */}
        <div className="space-y-3">
          <h3 className="text-[13px] font-semibold text-paper">Screen a payment</h3>
          <p className="text-xs text-faint">
            One call before the agent spends. AURA returns <span className="mono text-cleared">ALLOW</span>,
            <span className="mono text-held"> STEP_UP</span>, or <span className="mono text-denied"> BLOCK</span> — execute only on ALLOW.
          </p>
          <p className="text-xs text-faint">
            This is an <span className="text-mute">example</span> — the amount, merchant, and reason are placeholders your agent replaces with the real payment on each call.
          </p>
          <CodeBlock samples={samples} />
          <p className="text-xs leading-relaxed text-faint">
            Base URL <span className="mono text-mute">{origin}</span> · test mode, no real money moves.
            Send an <span className="mono text-mute">Idempotency-Key</span> so a retry replays the same verdict instead of paying twice. Keys are rate-limited per minute.
          </p>
        </div>
      </div>
    </section>
  )
}

// Remembers a card order in localStorage across refreshes.
function usePersistedOrder(key, initial) {
  const [order, setOrder] = useState(() => {
    try { const s = JSON.parse(localStorage.getItem(key)); if (Array.isArray(s) && s.length === initial.length) return s } catch { /* ignore */ }
    return initial
  })
  useEffect(() => { try { localStorage.setItem(key, JSON.stringify(order)) } catch { /* ignore */ } }, [key, order])
  return [order, setOrder]
}

// A draggable card that swaps places with another on drop. Clicking still works
// (a click without a drag), so the card's own action is preserved.
function DragCard({ id, order, setOrder, className = '', children }) {
  const [dragging, setDragging] = useState(false)
  const [over, setOver] = useState(false)
  function swapWith(from) {
    if (!from || from === id) return
    const next = [...order]
    const fi = next.indexOf(from), ti = next.indexOf(id)
    if (fi < 0 || ti < 0) return
    ;[next[fi], next[ti]] = [next[ti], next[fi]]
    setOrder(next)
  }
  return (
    <div
      draggable
      onDragStart={(e) => { e.dataTransfer.setData('text/plain', id); e.dataTransfer.effectAllowed = 'move'; setDragging(true) }}
      onDragEnd={() => setDragging(false)}
      onDragOver={(e) => { e.preventDefault(); setOver(true) }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => { e.preventDefault(); setOver(false); swapWith(e.dataTransfer.getData('text/plain')) }}
      className={`group cursor-grab rounded-lg transition-[transform,box-shadow,opacity] duration-200 active:cursor-grabbing
        hover:-translate-y-1 hover:shadow-[0_16px_34px_-16px_rgba(0,0,0,0.85)]
        ${dragging ? 'opacity-40' : ''} ${over ? 'ring-1 ring-mute/50' : ''} ${className}`}
    >
      {children}
    </div>
  )
}

// --- Dashboard ---------------------------------------------------------------
function Dashboard({ user, onLogout }) {
  const [tab, setTab] = useState('overview')
  const [health, setHealth] = useState(null)
  const [integrity, setIntegrity] = useState(null)
  const [decisions, setDecisions] = useState([])
  const [pending, setPending] = useState([])
  const [error, setError] = useState(null)
  const [loaded, setLoaded] = useState(false)
  const [flashId, setFlashId] = useState(null)
  const [updatedAt, setUpdatedAt] = useState(null)
  const [kpiOrder, setKpiOrder] = usePersistedOrder('aura_kpi_order', ['screened', 'cleared', 'held', 'stopped'])
  const [midOrder, setMidOrder] = usePersistedOrder('aura_mid_order', ['caught', 'system'])
  const [bigOrder, setBigOrder] = usePersistedOrder('aura_big_order', ['hero', 'ledger'])
  const topRef = useRef(null)
  const firstRef = useRef(true)

  const summary = useMemo(() => summarize(decisions), [decisions])

  async function load() {
    try {
      const uq = encodeURIComponent(user.id)
      const [h, v, r, p] = await Promise.all([
        api('/health'), api('/audit/verify'),
        api(`/audit/recent?limit=60&user_id=${uq}`), api('/pending'),
      ])
      setHealth(h); setIntegrity(v); setDecisions(r.decisions || [])
      setPending((p.pending || []).filter((x) => x.user_id === user.id)); setError(null)
      setUpdatedAt(Date.now())
    } catch (e) { setError(e.message) }
    finally { setLoaded(true) }
  }
  useEffect(() => { load(); const t = setInterval(load, 5000); return () => clearInterval(t) }, [user.id])

  useEffect(() => {
    const top = decisions[0]?.request_id
    if (!top) return
    if (firstRef.current) { firstRef.current = false; topRef.current = top; return }
    if (top !== topRef.current) {
      topRef.current = top; setFlashId(top)
      const t = setTimeout(() => setFlashId(null), 1400)
      return () => clearTimeout(t)
    }
  }, [decisions])

  useEffect(() => { window.scrollTo({ top: 0, behavior: 'smooth' }) }, [tab])

  // The two swappable full-width sections on the overview.
  const bigCards = {
    hero: <Hero d={decisions[0]} loaded={loaded} onOpen={() => setTab('decisions')} />,
    ledger: <Ledger decisions={decisions} integrity={integrity} onVerify={load} flashId={flashId} loaded={loaded} updatedAt={updatedAt} onOpen={() => setTab('decisions')} />,
  }

  return (
    <div className="min-h-screen">
      <div className="mx-auto max-w-6xl px-6 py-8">
        {/* masthead */}
        <header className="flex items-center justify-between gap-4 border-b border-line pb-5">
          <div>
            <h1 className="text-[22px] font-extrabold leading-none tracking-tight text-paper">AURA</h1>
            <p className="eyebrow mt-2">Payment Intent Firewall</p>
          </div>
          <div className="flex items-center gap-3 text-[11px] text-faint">
            <span>{user.name}<span className="text-mute"> · {user.handle || user.id}</span></span>
            <span className="flex items-center gap-3 border-l border-line pl-3">
              <DeleteData user={user} onDone={load} />
              <button onClick={onLogout} className="press hover:text-paper">Sign out</button>
            </span>
          </div>
        </header>

        {error && (
          <div className="mt-4 flex items-center justify-between gap-4 border-l-2 border-denied pl-3">
            <span className="text-sm text-denied">Can't reach the backend — {error}</span>
            <button onClick={load} className="btn-line py-1 text-xs">Retry</button>
          </div>
        )}

        <div className="mt-8 grid gap-x-10 gap-y-8 md:grid-cols-[8rem_1fr]">
          {/* index */}
          <nav className="flex gap-1 md:flex-col md:gap-0.5">
            {NAV.map((n) => {
              const active = tab === n.id
              return (
                <button key={n.id} onClick={() => setTab(n.id)}
                  className={`press flex items-center gap-2.5 py-1.5 text-[13px] md:w-full ${active ? 'text-paper' : 'text-mute hover:text-paper'}`}>
                  <span className={`h-3.5 w-px ${active ? 'bg-paper' : 'bg-transparent'}`} />
                  <span>{n.label}</span>
                  {n.id === 'pending' && pending.length > 0 && <span className="mono ml-auto text-[11px] tnum text-faint">{pending.length}</span>}
                </button>
              )
            })}
          </nav>

          {/* content */}
          <div key={tab} className="row-rise min-w-0">
            {tab === 'overview' ? (
              <div className="space-y-10">
                <PendingBanner count={pending.length} onReview={() => setTab('pending')} />
                <Metrics s={summary} order={kpiOrder} setOrder={setKpiOrder} onNav={setTab} />
                <ActivityChart decisions={decisions} loaded={loaded} />
                <DragCard id={bigOrder[0]} order={bigOrder} setOrder={setBigOrder}>{bigCards[bigOrder[0]]}</DragCard>
                <div className="grid items-stretch gap-6 lg:grid-cols-2">
                  {midOrder.map((key) => (
                    <DragCard key={key} id={key} order={midOrder} setOrder={setMidOrder}>
                      {key === 'caught'
                        ? <CaughtBy s={summary} onOpen={() => setTab('pending')} />
                        : <SystemPanel health={health} integrity={integrity} s={summary} />}
                    </DragCard>
                  ))}
                </div>
                <DragCard id={bigOrder[1]} order={bigOrder} setOrder={setBigOrder}>{bigCards[bigOrder[1]]}</DragCard>
              </div>
            ) : tab === 'simulate' ? (
              <Simulate onDone={load} user={user} onGoPending={() => setTab('pending')} />
            ) : tab === 'decisions' ? (
              <Decisions decisions={decisions} integrity={integrity} onVerify={load} loaded={loaded} user={user} />
            ) : tab === 'policy' ? (
              <Policy user={user} />
            ) : tab === 'keys' ? (
              <Developers user={user} />
            ) : (
              <Pending pending={pending} loaded={loaded} onChange={load} />
            )}
          </div>
        </div>

        <footer className="mt-14 border-t border-line pt-4 text-xs text-faint">
          Test mode — no real money moves. Four signals (rules, ML risk, Groq, Gemini) combine most-restrictively; the AI can only escalate.
        </footer>
      </div>
    </div>
  )
}

// --- Login -------------------------------------------------------------------
const GOOGLE_CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID || ''

function decodeJwt(token) {
  try { return JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))) }
  catch { return null }
}

// Google Identity Services button. Renders only when a client ID is configured
// (VITE_GOOGLE_CLIENT_ID); otherwise it stays out of the way.
function GoogleSignIn({ onLogin }) {
  const ref = useRef(null)
  const cb = useRef(onLogin)
  cb.current = onLogin
  useEffect(() => {
    if (!GOOGLE_CLIENT_ID) return
    const handle = (resp) => {
      const p = decodeJwt(resp.credential)
      if (p?.email) cb.current({ id: p.email, name: p.name || p.email, picture: p.picture, google: true })
    }
    // Render the button at the container's width so it lines up with the
    // full-width fields below it. GIS caps width at 400px.
    const renderBtn = () => {
      if (!window.google?.accounts?.id || !ref.current) return
      const w = Math.min(400, Math.max(240, Math.floor(ref.current.clientWidth || 320)))
      ref.current.innerHTML = ''
      window.google.accounts.id.renderButton(ref.current, {
        theme: 'outline', size: 'large', text: 'continue_with',
        shape: 'rectangular', logo_alignment: 'center', width: w,
      })
    }
    const init = () => {
      if (!window.google?.accounts?.id || !ref.current) return false
      window.google.accounts.id.initialize({ client_id: GOOGLE_CLIENT_ID, callback: handle })
      renderBtn()
      return true
    }
    let attached = false
    if (init()) { window.addEventListener('resize', renderBtn); attached = true }
    else {
      const s = document.createElement('script')
      s.src = 'https://accounts.google.com/gsi/client'; s.async = true; s.defer = true
      s.onload = () => { if (init()) { window.addEventListener('resize', renderBtn); attached = true } }
      document.head.appendChild(s)
    }
    return () => { if (attached) window.removeEventListener('resize', renderBtn) }
  }, [])
  if (!GOOGLE_CLIENT_ID) return null
  return (
    <>
      {/* min-height reserves space so the card doesn't jump before GIS renders */}
      <div ref={ref} className="flex min-h-[40px] w-full justify-center [color-scheme:light]" />
      <div className="flex items-center gap-3 text-[11px] text-faint">
        <span className="h-px flex-1 bg-line" />or<span className="h-px flex-1 bg-line" />
      </div>
    </>
  )
}

function Login({ onLogin, onBack }) {
  const [id, setId] = useState('')
  const [name, setName] = useState('')
  const [err, setErr] = useState(null)

  function submit(e) {
    e.preventDefault()
    const clean = id.trim().replace(/\s+/g, '_').toLowerCase()
    if (!clean) { setErr('Enter a user ID to continue.'); return }
    onLogin({ id: clean, name: name.trim() || clean })
  }

  return (
    <div className="grid min-h-screen place-items-center px-6">
      <div className="w-full max-w-sm row-rise">
        <div className="text-center">
          <h1 className="text-[26px] font-extrabold tracking-tight text-paper">AURA</h1>
          <p className="eyebrow mt-2">Payment Intent Firewall</p>
        </div>
        <div className="panel mt-8 space-y-4 p-6">
          <div className="flex items-center justify-between">
            <div className="eyebrow">Sign in</div>
            {onBack && <button onClick={onBack} className="press text-xs text-faint hover:text-paper">← Back</button>}
          </div>
          <GoogleSignIn onLogin={onLogin} />
          <form onSubmit={submit} className="space-y-4">
            <label className="block">
              <span className="eyebrow">User ID</span>
              <input autoFocus className="field mt-2" value={id} onChange={(e) => { setId(e.target.value); setErr(null) }} placeholder="" />
            </label>
            <label className="block">
              <span className="eyebrow">Display name <span className="text-faint">(optional)</span></span>
              <input className="field mt-2" value={name} onChange={(e) => setName(e.target.value)} placeholder="" />
            </label>
            {err && <p className="text-sm text-denied">{err}</p>}
            <button type="submit" className="btn-solid w-full">Continue</button>
          </form>
        </div>
        <p className="mt-4 text-center text-xs text-faint">Test mode — your identity scopes your payments and policy.</p>
      </div>
    </div>
  )
}

// Erase the signed-in profile's data (audit entries, policy, pending). Two-step
// confirm so a demo reset is never one stray click away.
function DeleteData({ user, onDone }) {
  const [confirm, setConfirm] = useState(false)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (!confirm) return
    const t = setTimeout(() => setConfirm(false), 4000)
    return () => clearTimeout(t)
  }, [confirm])
  async function del() {
    setBusy(true)
    try { await api(`/profile/${encodeURIComponent(user.id)}`, { method: 'DELETE' }); await onDone?.() }
    finally { setBusy(false); setConfirm(false) }
  }
  return confirm
    ? <button onClick={del} disabled={busy} className="press text-denied hover:opacity-80">{busy ? 'Deleting…' : 'Confirm delete'}</button>
    : <button onClick={() => setConfirm(true)} className="press hover:text-paper">Delete data</button>
}

// --- Clerk auth --------------------------------------------------------------
const CLERK_KEY = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY || ''

// Dark appearance so Clerk's UI matches the console.
const CLERK_APPEARANCE = {
  variables: {
    colorBackground: '#141518',
    colorText: '#E7E8EB',
    colorTextSecondary: '#9B9DA4',
    colorPrimary: '#E7E8EB',
    colorInputBackground: '#0B0C0E',
    colorInputText: '#E7E8EB',
    colorNeutral: '#E7E8EB',
    borderRadius: '8px',
    fontFamily: 'Archivo, system-ui, sans-serif',
  },
  elements: {
    card: 'shadow-none',
    formButtonPrimary: 'text-[13px] normal-case',
  },
}

function ClerkDashboard() {
  const { user } = useUser()
  const { signOut } = useClerk()
  if (!user) return null
  const username = user.username
  const email = user.primaryEmailAddress?.emailAddress
  const name = user.fullName || username || email || 'User'
  // A friendly handle for display; data is still scoped by the stable Clerk id.
  const handle = username ? `@${username}` : (email || `${user.id.slice(0, 10)}…`)
  return <Dashboard user={{ id: user.id, name, handle }} onLogout={() => signOut()} />
}

function ClerkLogin({ onBack }) {
  return (
    <div className="grid min-h-screen place-items-center px-6">
      <div className="row-rise">
        <div className="mb-8 text-center">
          <h1 className="text-[26px] font-extrabold tracking-tight text-paper">AURA</h1>
          <p className="eyebrow mt-2">Payment Intent Firewall</p>
        </div>
        <SignIn routing="hash" appearance={CLERK_APPEARANCE} />
        <div className="mt-4 text-center text-xs text-faint">
          {onBack && <button onClick={onBack} className="press hover:text-paper">← Back to home</button>}
          <p className="mt-2">Test mode — your account scopes your payments and policy.</p>
        </div>
      </div>
    </div>
  )
}

// --- Landing -----------------------------------------------------------------
function Wordmark() {
  return (
    <span className="inline-flex items-center gap-2">
      <span className="grid h-6 w-6 place-items-center rounded-md border border-line2 bg-slab text-[13px] font-extrabold text-paper">A</span>
      <span className="text-[17px] font-extrabold tracking-tight text-paper">AURA</span>
    </span>
  )
}

// A static, on-brand replica of a real verdict — the hero's product shot.
function HeroVerdict() {
  const sig = [['Rules', 'cleared', 'within caps'], ['Risk', 'cleared', 'normal'], ['AI judge', 'held', 'intent mismatch']]
  return (
    <div className="panel row-rise p-6">
      <div className="flex items-center justify-between">
        <span className="flex items-center gap-2">
          <i className="live-dot h-1.5 w-1.5 rounded-full bg-cleared" />
          <span className="eyebrow">Screened · just now</span>
        </span>
        <Verdict d="STEP_UP" className="text-sm" />
      </div>
      <div className="mt-4 flex items-baseline gap-3">
        <span className="mono text-[2.25rem] font-semibold leading-none tracking-tight tnum text-paper">₹8,400.00</span>
        <span className="text-sm text-mute">to Unknown Merchant</span>
      </div>
      <div className="mt-5 flex flex-wrap gap-x-6 gap-y-2">
        {sig.map(([n, tone, s]) => (
          <span key={n} className="flex items-center gap-2 text-xs">
            <i className={`h-1.5 w-1.5 rounded-full ${SIG_DOT[tone]}`} />
            <span className="text-faint">{n}</span><span className={SIG_TEXT[tone]}>{s}</span>
          </span>
        ))}
      </div>
      <ul className="mt-5 space-y-1.5 text-sm text-mute">
        <li>Agent's reason doesn't match what you authorized.</li>
        <li>Held for your confirmation before any money moves.</li>
      </ul>
      <div className="mt-5 flex items-center gap-2 border-t border-line pt-4 text-xs text-faint">
        <span className="seal">seal 4f9c1a2e7b30</span><span>·</span><span>tamper-evident</span>
      </div>
    </div>
  )
}

const STEPS = [
  ['01', 'The agent requests', 'Before spending, your AI agent sends the payment intent — amount, merchant, and why — to AURA with its API key.'],
  ['02', 'AURA screens it', 'Four signals combine most-restrictively: your policy floor, an ML risk model, and two AI judges checking intent and manipulation.'],
  ['03', 'Allow · step-up · block', 'A clear verdict comes back in one call. Clean payments execute on the Razorpay rail; risky ones are held for you or blocked outright.'],
]

const FEATURES = [
  ['Deterministic policy floor', 'Per-transaction, daily, and monthly caps, frequency limits, and allow/deny lists — enforced before any AI runs. The hard floor the AI can only make stricter.'],
  ['ML risk model', 'A per-user anomaly detector learns your normal spending and flags outliers — an unfamiliar amount or an odd burst of payments.'],
  ['AI intent judge', 'Groq with a Gemini fallback checks the agent\'s stated reason against what you actually authorized, and watches for prompt-injection and manipulation.'],
  ['Tamper-evident audit', 'Every decision is written to a SHA-256 hash-chained ledger. Any edit, insert, or delete breaks the chain and is caught on verify.'],
  ['Human step-up', 'Borderline payments pause for a one-tap approval instead of failing. Approve once and optionally trust that merchant next time.'],
  ['Drop-in API', 'One authenticated POST before the agent spends. Fail-safe by design — an error never resolves to a silent allow.'],
]

function Landing({ onEnter }) {
  const origin = typeof window !== 'undefined' ? window.location.origin : ''
  const samples = codeSamples(origin, null)
  return (
    <div className="min-h-screen">
      {/* top bar */}
      <header className="sticky top-0 z-20 border-b border-line bg-ink/85 backdrop-blur-sm">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-3.5">
          <Wordmark />
          <nav className="hidden items-center gap-7 text-[13px] text-mute md:flex">
            <a href="#how" className="press hover:text-paper">How it works</a>
            <a href="#features" className="press hover:text-paper">Features</a>
            <a href="#developers" className="press hover:text-paper">Developers</a>
          </nav>
          <button onClick={onEnter} className="btn-solid py-1.5">Sign in</button>
        </div>
      </header>

      {/* hero */}
      <section className="mx-auto max-w-6xl px-6 pb-16 pt-16 sm:pt-24">
        <div className="grid items-center gap-12 lg:grid-cols-[1.05fr_1fr]">
          <div className="row-rise">
            <span className="eyebrow">Agentic UPI Firewall</span>
            <h1 className="mt-4 text-[2.6rem] font-extrabold leading-[1.05] tracking-tight text-paper sm:text-[3.25rem]">
              A firewall between<br />your AI agent and<br />your money.
            </h1>
            <p className="mt-5 max-w-md text-[15px] leading-relaxed text-mute">
              AURA sits in front of Razorpay and screens every payment an agent tries to make — clearing the safe ones,
              holding the doubtful ones, and blocking abuse. Rules, ML risk, and AI, in one call.
            </p>
            <div className="mt-8 flex flex-wrap items-center gap-3">
              <button onClick={onEnter} className="btn-solid px-5 py-2.5">Get started</button>
              <a href="#how" className="btn-line px-5 py-2.5">See how it works</a>
            </div>
            <div className="mt-8 flex flex-wrap gap-x-6 gap-y-2 text-xs text-faint">
              {['Rules', 'ML risk', 'AI judge', 'Sealed audit'].map((x) => (
                <span key={x} className="flex items-center gap-1.5"><i className="h-1.5 w-1.5 rounded-full bg-cleared" />{x}</span>
              ))}
            </div>
          </div>
          <HeroVerdict />
        </div>
      </section>

      {/* how it works */}
      <section id="how" className="border-t border-line bg-slab/30">
        <div className="mx-auto max-w-6xl px-6 py-16">
          <span className="eyebrow">How it works</span>
          <h2 className="mt-3 max-w-lg text-[1.7rem] font-bold tracking-tight text-paper">One call turns an agent's payment into a screened decision.</h2>
          <div className="mt-10 grid gap-px overflow-hidden rounded-lg border border-line bg-line sm:grid-cols-3">
            {STEPS.map(([n, t, d]) => (
              <div key={n} className="bg-ink p-6">
                <span className="mono text-xs tnum text-faint">{n}</span>
                <h3 className="mt-3 text-[15px] font-semibold text-paper">{t}</h3>
                <p className="mt-2 text-sm leading-relaxed text-mute">{d}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* features */}
      <section id="features" className="border-t border-line">
        <div className="mx-auto max-w-6xl px-6 py-16">
          <span className="eyebrow">What's inside</span>
          <h2 className="mt-3 max-w-lg text-[1.7rem] font-bold tracking-tight text-paper">Four signals, combined most-restrictively.</h2>
          <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {FEATURES.map(([t, d]) => (
              <div key={t} className="panel p-5 transition-colors duration-200 hover:border-line2">
                <div className="h-1.5 w-1.5 rounded-full bg-paper" />
                <h3 className="mt-4 text-[14px] font-semibold text-paper">{t}</h3>
                <p className="mt-2 text-sm leading-relaxed text-mute">{d}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* developers */}
      <section id="developers" className="border-t border-line bg-slab/30">
        <div className="mx-auto max-w-6xl px-6 py-16">
          <div className="grid items-start gap-10 lg:grid-cols-[0.85fr_1.15fr]">
            <div>
              <span className="eyebrow">Built for agents</span>
              <h2 className="mt-3 text-[1.7rem] font-bold tracking-tight text-paper">Drop it in before every payment.</h2>
              <p className="mt-4 max-w-sm text-sm leading-relaxed text-mute">
                Generate an API key, authenticate as yourself, and screen a payment with a single POST.
                Execute only when the verdict is <span className="mono text-cleared">ALLOW</span>. Fail-safe by design.
              </p>
              <button onClick={onEnter} className="btn-line mt-6 px-5 py-2.5">Get your API key</button>
            </div>
            <CodeBlock samples={samples} />
          </div>
        </div>
      </section>

      {/* final CTA */}
      <section className="border-t border-line">
        <div className="mx-auto max-w-6xl px-6 py-20 text-center">
          <h2 className="mx-auto max-w-xl text-[2rem] font-extrabold tracking-tight text-paper">Put a firewall in front of your agent.</h2>
          <p className="mx-auto mt-4 max-w-md text-sm text-mute">Test mode — connect an agent and watch AURA screen every payment in real time.</p>
          <button onClick={onEnter} className="btn-solid mx-auto mt-8 px-6 py-3">Get started</button>
        </div>
      </section>

      <footer className="border-t border-line">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-6 py-6 text-xs text-faint">
          <Wordmark />
          <span>Test mode — no real money moves. Rules · ML risk · Groq · Gemini, combined most-restrictively.</span>
        </div>
      </footer>
    </div>
  )
}

// --- App gate ----------------------------------------------------------------
// The public landing page is the front door for a signed-out visitor; "Sign in"
// / "Get started" reveal the auth screen, which then hands off to the dashboard.
function LocalAuthApp() {
  const [user, setUser] = useState(() => {
    try { const s = localStorage.getItem('aura_user'); return s ? JSON.parse(s) : null } catch { return null }
  })
  const [entered, setEntered] = useState(false)
  const login = (u) => { try { localStorage.setItem('aura_user', JSON.stringify(u)) } catch { /* ignore */ } setUser(u) }
  const logout = () => { try { localStorage.removeItem('aura_user') } catch { /* ignore */ } setUser(null); setEntered(false) }

  if (user) return <Dashboard user={user} onLogout={logout} />
  if (!entered) return <Landing onEnter={() => setEntered(true)} />
  return <Login onLogin={login} onBack={() => setEntered(false)} />
}

function ClerkGate() {
  const [entered, setEntered] = useState(false)
  return (
    <>
      <SignedOut>
        {entered ? <ClerkLogin onBack={() => setEntered(false)} /> : <Landing onEnter={() => setEntered(true)} />}
      </SignedOut>
      <SignedIn><ClerkDashboard /></SignedIn>
    </>
  )
}

// Clerk is opt-in: it activates ONLY when a key is present AND VITE_USE_CLERK is
// explicitly "true". This prevents a leftover/baked Clerk key from forcing the
// app into Clerk mode — the default is the Google + username sign-in.
const USE_CLERK = !!CLERK_KEY && import.meta.env.VITE_USE_CLERK === 'true'

export default function App() {
  if (!USE_CLERK) return <LocalAuthApp />
  return (
    <ClerkProvider publishableKey={CLERK_KEY} afterSignOutUrl="/" appearance={CLERK_APPEARANCE}>
      <ClerkGate />
    </ClerkProvider>
  )
}
