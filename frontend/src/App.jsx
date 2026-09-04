import { useEffect, useMemo, useRef, useState } from 'react'
import { api, rupees } from './lib/api.js'

// Count a number up to its target — draws the eye to a value that just changed.
function useCountUp(target) {
  const [val, setVal] = useState(target)
  const prev = useRef(target)
  useEffect(() => {
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    if (reduce || prev.current === target) { setVal(target); prev.current = target; return }
    const from = prev.current, to = target, start = performance.now(), dur = 520
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
  { id: 'simulate', label: 'Simulate', soon: '7B' },
  { id: 'decisions', label: 'Decisions', soon: '7B' },
  { id: 'policy', label: 'Policy', soon: '7C' },
  { id: 'pending', label: 'Pending', soon: '7C' },
]

const STAMP = { ALLOW: 'stamp-cleared', STEP_UP: 'stamp-held', BLOCK: 'stamp-denied' }
const VERDICT_TEXT = { ALLOW: 'text-cleared', STEP_UP: 'text-held', BLOCK: 'text-denied' }
const VERDICT_HEX = { ALLOW: '#35C08A', STEP_UP: '#E4A93C', BLOCK: '#F0525A' }
const clock = (ts) => {
  try { return new Date(ts).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }) }
  catch { return '—' }
}

function AuraMark() {
  // Concentric rings closing on a lit core — an "aura" around a cleared payment.
  return (
    <svg width="26" height="26" viewBox="0 0 34 34" fill="none" aria-hidden
         style={{ filter: 'drop-shadow(0 0 5px rgba(53,192,138,0.55))' }}>
      <circle cx="17" cy="17" r="15" stroke="#2E3E58" strokeWidth="1.5" />
      <circle cx="17" cy="17" r="9.5" stroke="#35C08A" strokeWidth="1.5" strokeOpacity="0.55" />
      <circle cx="17" cy="17" r="4" fill="#35C08A" />
    </svg>
  )
}

function StatusLine({ health, integrity }) {
  const dot = (ok) => (ok ? 'bg-cleared' : 'bg-denied')
  return (
    <div className="flex items-center gap-4 text-[11px] text-mute">
      <span className="flex items-center gap-1.5"><i className={`h-1.5 w-1.5 rounded-full ${dot(health?.status === 'ok')}`} />backend</span>
      <span className="flex items-center gap-1.5"><i className={`h-1.5 w-1.5 rounded-full ${dot(!!health?.razorpay_configured)}`} />rail</span>
      <span className="flex items-center gap-1.5"><i className={`h-1.5 w-1.5 rounded-full ${dot(!!integrity?.valid)}`} />chain sealed</span>
    </div>
  )
}

// The single layer that drove this verdict (rules floor first, then risk, then AI).
function decidedBy(d) {
  if (d.decision === 'ALLOW') return null
  const det = d.deterministic_result?.decision
  if (d.decision === 'BLOCK') return det === 'BLOCK' ? 'rules' : 'AI judge'
  if (det === 'STEP_UP') return 'rules'
  if (d.risk_anomaly === true) return 'risk model'
  return 'AI judge'
}

// Aggregate everything the overview needs from the decisions already on hand.
function summarize(decisions) {
  const s = {
    total: decisions.length, ALLOW: 0, STEP_UP: 0, BLOCK: 0,
    cleared_paise: 0, flagged_paise: 0, executed: 0,
    by: { rules: 0, 'risk model': 0, 'AI judge': 0 },
  }
  for (const d of decisions) {
    s[d.decision] = (s[d.decision] || 0) + 1
    if (d.decision === 'ALLOW') {
      s.cleared_paise += d.amount_paise || 0
      if (d.executed) s.executed += 1
    } else {
      s.flagged_paise += d.amount_paise || 0
      const b = decidedBy(d)
      if (b && s.by[b] != null) s.by[b] += 1
    }
  }
  return s
}

const TONE = { cleared: 'bg-cleared', held: 'bg-held', denied: 'bg-denied' }

// --- Signals strip on the hero (all three layers, for the single latest decision) ---
function signalStates(d) {
  const det = d.deterministic_result?.decision
  const rules = det === 'BLOCK' ? ['blocked', 'denied']
    : det === 'STEP_UP' ? ['needs review', 'held']
    : ['cleared', 'cleared']

  const risk = d.risk_anomaly === true ? ['unusual', 'held']
    : d.risk_anomaly === false ? ['normal', 'cleared']
    : ['not run', 'mute']

  let ai
  if (d.llm_status === 'ok') {
    ai = d.manipulation_suspected ? ['manipulation', 'denied']
      : d.intent_match === false ? ['intent mismatch', 'denied']
      : ['intent match', 'cleared']
  } else if (d.llm_status === 'skipped_block') ai = ['not needed', 'mute']
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
    <div className="mt-5 flex flex-wrap items-center gap-x-6 gap-y-2">
      {signalStates(d).map((s) => (
        <div key={s.name} className="flex items-center gap-2">
          <span className={`h-1.5 w-1.5 rounded-full ${TONE[s.tone] || 'bg-mute/50'}`} />
          <span className="text-xs text-mute">{s.name}</span>
          <span className="text-xs text-paper">{s.state}</span>
        </div>
      ))}
    </div>
  )
}

function HeroSkeleton() {
  return (
    <div className="panel p-6">
      <div className="sk mb-5 h-3 w-28" />
      <div className="flex items-end justify-between">
        <div className="sk h-12 w-44" />
        <div className="sk h-9 w-32" />
      </div>
      <div className="mt-6 space-y-2 border-l-2 border-line pl-4">
        <div className="sk h-4 w-3/4" />
        <div className="sk h-4 w-2/3" />
      </div>
    </div>
  )
}

function Hero({ d, loaded }) {
  const amount = useCountUp(d?.amount_paise || 0)
  if (!loaded) return <HeroSkeleton />
  if (!d) {
    return (
      <div className="panel p-6">
        <p className="text-mute">No decisions yet. Send a payment from Simulate to see a clearance here.</p>
      </div>
    )
  }
  const reasons = (d.reasons || []).filter((r) => !r.startsWith('held pending'))
  const hex = VERDICT_HEX[d.decision]
  return (
    <section key={d.request_id} className="animate-stamp panel-hero p-6">
      {/* verdict-tinted ambient glow, bled off the top-right corner */}
      <div
        aria-hidden
        className="pointer-events-none absolute -right-16 -top-24 h-56 w-56 rounded-full blur-3xl"
        style={{ background: hex, opacity: 0.14 }}
      />
      <div className="relative">
        <div className="mb-5 flex items-center justify-between gap-3">
          <span className="flex items-center gap-2">
            <i className="live-dot h-1.5 w-1.5 rounded-full bg-cleared" />
            <span className="eyebrow">Latest clearance · {clock(d.timestamp)}</span>
          </span>
          <span className={`${STAMP[d.decision]} text-sm`}>
            {d.decision === 'STEP_UP' ? 'STEP-UP' : d.decision}
          </span>
        </div>
        <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-2">
          <div>
            <div className="text-[2.75rem] font-extrabold leading-none tracking-tight tnum text-paper">{rupees(amount)}</div>
            <div className="mt-2 text-base text-mute">to <span className="text-paper">{d.merchant || '—'}</span></div>
          </div>
        </div>

        <Signals d={d} />

        <ul className="mt-6 space-y-1.5 border-l-2 pl-4" style={{ borderColor: hex + '66' }}>
          {reasons.map((r, i) => (
            <li key={i} className="text-sm leading-relaxed text-paper/90">{r}</li>
          ))}
        </ul>

        <div className="mt-5 flex items-center gap-3 text-xs text-mute">
          <span className="seal scan inline-block rounded border border-line/70 bg-ink/40 px-1.5 py-0.5">
            seal {(d.entry_hash || '').slice(0, 10) || '—'}
          </span>
          <span>·</span>
          <span>{clock(d.timestamp)}</span>
          {d.order_id && <><span>·</span><span className="seal">{d.order_id}</span></>}
        </div>
      </div>
    </section>
  )
}

// --- KPI band ----------------------------------------------------------------
function Stat({ label, value, sub, accent, tick, i }) {
  return (
    <div
      style={{ animationDelay: `${i * 60}ms`, '--accent': tick || '#8A97AD' }}
      className="kpi row-rise"
    >
      <div className="eyebrow">{label}</div>
      <div className={`metric mt-2 text-[1.7rem] leading-none ${accent || 'text-paper'}`}>{value}</div>
      {sub && <div className="mt-1.5 text-xs text-mute">{sub}</div>}
    </div>
  )
}

function Legend({ c, t }) {
  return <span className="flex items-center gap-1.5"><i className={`h-2 w-2 rounded-full ${c}`} />{t}</span>
}

function DistBar({ s }) {
  const total = Math.max(1, s.total)
  const seg = [
    ['ALLOW', s.ALLOW, 'linear-gradient(180deg,#3ED79B,#2FA576)'],
    ['STEP_UP', s.STEP_UP, 'linear-gradient(180deg,#F0BC57,#D6912B)'],
    ['BLOCK', s.BLOCK, 'linear-gradient(180deg,#F5666E,#DA3A44)'],
  ]
  return (
    <div className="track flex h-3 w-full gap-px">
      {seg.map(([k, n, g]) => n > 0 && (
        <div
          key={k}
          className="h-full transition-all duration-700 first:rounded-l-full last:rounded-r-full"
          style={{ width: `${(n / total) * 100}%`, background: g }}
        />
      ))}
    </div>
  )
}

function Metrics({ s }) {
  const flaggedRate = s.total ? Math.round(((s.STEP_UP + s.BLOCK) / s.total) * 100) : 0
  return (
    <section className="mt-8">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat i={0} label="Screened" value={s.total} sub="payment intents" tick="#8A97AD" />
        <Stat i={1} label="Cleared" value={s.ALLOW} sub={`${rupees(s.cleared_paise)} · ${s.executed} on rail`} accent="text-cleared" tick="#35C08A" />
        <Stat i={2} label="Held / Denied" value={s.STEP_UP + s.BLOCK} sub={`${flaggedRate}% flagged`} accent="text-held" tick="#E4A93C" />
        <Stat i={3} label="Value stopped" value={rupees(s.flagged_paise)} sub="held or denied" accent="text-denied" tick="#F0525A" />
      </div>
      {s.total > 0 && (
        <div className="mt-5">
          <DistBar s={s} />
          <div className="mt-2.5 flex flex-wrap gap-x-5 gap-y-1 text-xs text-mute">
            <Legend c="bg-cleared" t={`${s.ALLOW} cleared`} />
            <Legend c="bg-held" t={`${s.STEP_UP} stepped up`} />
            <Legend c="bg-denied" t={`${s.BLOCK} denied`} />
          </div>
        </div>
      )}
    </section>
  )
}

// --- Mid section: what's catching payments  +  live system panel -------------
const LAYER_FILL = {
  Rules: 'linear-gradient(90deg,#5B6B85,#8A97AD)',
  'Risk model': 'linear-gradient(90deg,#C98A2E,#F0BC57)',
  'AI judge': 'linear-gradient(90deg,#4E86C9,#7FB0E8)',
}

function CaughtBy({ s }) {
  const flagged = s.STEP_UP + s.BLOCK
  const rows = [['Rules', s.by.rules], ['Risk model', s.by['risk model']], ['AI judge', s.by['AI judge']]]
  return (
    <section className="panel p-5">
      <h2 className="head">What's catching payments</h2>
      <p className="mt-1.5 pl-[13px] text-xs text-mute">Which layer drove each held or denied verdict.</p>
      {flagged === 0 ? (
        <p className="mt-6 pl-[13px] text-sm text-mute">Nothing flagged yet — every payment cleared.</p>
      ) : (
        <div className="mt-5 space-y-3.5">
          {rows.map(([name, n]) => {
            const pct = flagged ? Math.round((n / flagged) * 100) : 0
            return (
              <div key={name} className="flex items-center gap-3">
                <span className="w-20 shrink-0 text-xs text-paper/80">{name}</span>
                <div className="track h-2.5 flex-1">
                  <div
                    className="h-full rounded-full transition-all duration-700"
                    style={{ width: `${Math.max(pct, n > 0 ? 6 : 0)}%`, background: LAYER_FILL[name] }}
                  />
                </div>
                <span className="w-16 shrink-0 text-right text-xs text-mute">
                  <span className="metric text-paper">{n}</span> · {pct}%
                </span>
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
    <section className="panel p-5">
      <h2 className="head">System &amp; integrity</h2>
      <p className="mt-1.5 pl-[13px] text-xs text-mute">Every decision is hash-chained and tamper-evident.</p>
      <div className="mt-5 space-y-3">
        {rows.map(([name, state, ok]) => (
          <div key={name} className="flex items-center justify-between border-b border-line/50 pb-3 last:border-0 last:pb-0">
            <span className="flex items-center gap-2.5 text-sm text-paper">
              <i className={`h-1.5 w-1.5 rounded-full ${ok ? 'bg-cleared' : 'bg-denied'}`} style={ok ? { boxShadow: '0 0 8px #35C08A' } : undefined} />
              {name}
            </span>
            <span className={`text-xs ${ok ? 'text-mute' : 'text-denied'}`}>{state}</span>
          </div>
        ))}
        <div className="flex items-center justify-between pt-0.5">
          <span className="text-sm text-paper">Rail execution</span>
          <span className="text-xs text-mute"><span className="metric text-paper">{railRate}%</span> of cleared</span>
        </div>
      </div>
    </section>
  )
}

// --- Ledger ------------------------------------------------------------------
function Ledger({ decisions, integrity, onVerify, flashId, loaded }) {
  return (
    <section className="mt-8">
      <div className="mb-3 flex items-baseline justify-between">
        <h2 className="head">
          Ledger
          <span className="flex items-center gap-1 text-[10px] font-medium text-mute">
            <i className="live-dot h-1.5 w-1.5 rounded-full bg-cleared" />live
          </span>
        </h2>
        <button onClick={onVerify} className="press text-xs text-mute hover:text-paper">
          {integrity ? (integrity.valid ? `sealed · ${integrity.entries} entries` : 'chain broken') : 'verify'}
        </button>
      </div>
      {!loaded ? (
        <div className="space-y-2 py-2">
          {[0, 1, 2, 3].map((i) => <div key={i} className="sk h-8 w-full" />)}
        </div>
      ) : decisions.length === 0 ? (
        <p className="py-8 text-sm text-mute">The ledger is empty.</p>
      ) : (
        <div className="panel overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line/80 bg-white/[0.015] text-left">
                <th className="eyebrow py-3 pl-4 pr-4">Time</th>
                <th className="eyebrow py-3 pr-4">Payee</th>
                <th className="eyebrow py-3 pr-4 text-right">Amount</th>
                <th className="eyebrow hidden py-3 pr-4 sm:table-cell">Seal</th>
                <th className="eyebrow py-3 pr-4 text-right">Verdict</th>
              </tr>
            </thead>
            <tbody>
              {decisions.map((d, i) => (
                <tr
                  key={d.request_id}
                  style={{ animationDelay: `${Math.min(i, 10) * 35}ms` }}
                  className={`border-t border-line/40 transition-colors hover:bg-white/[0.025] ${d.request_id === flashId ? 'row-new' : 'row-rise'}`}
                >
                  <td className="py-2.5 pl-4 pr-4 tnum text-mute">{clock(d.timestamp)}</td>
                  <td className="py-2.5 pr-4 text-paper">{d.merchant || '—'}</td>
                  <td className="py-2.5 pr-4 text-right tnum text-paper">{rupees(d.amount_paise)}</td>
                  <td className="hidden py-2.5 pr-4 seal text-mute sm:table-cell">{(d.entry_hash || '').slice(0, 8)}</td>
                  <td className="py-2.5 pr-4 text-right">
                    <span className={STAMP[d.decision]}>{d.decision === 'STEP_UP' ? 'STEP-UP' : d.decision}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}

function Arriving({ tab }) {
  const copy = {
    simulate: 'Send an agent payment intent and watch AURA clear, hold, or deny it — with the rules, risk, and AI reasons.',
    decisions: 'The full ledger with filters and integrity checks.',
    policy: 'Set your caps, velocity limits, and allow / deny lists.',
    pending: 'Approve payments AURA is holding for you.',
  }
  return (
    <div className="border-l-2 border-line pl-4 py-6">
      <p className="text-paper">{copy[tab]}</p>
      <p className="mt-1 text-sm text-mute">Arriving in checkpoint {['policy', 'pending'].includes(tab) ? '7C' : '7B'}.</p>
    </div>
  )
}

export default function App() {
  const [tab, setTab] = useState('overview')
  const [health, setHealth] = useState(null)
  const [integrity, setIntegrity] = useState(null)
  const [decisions, setDecisions] = useState([])
  const [error, setError] = useState(null)
  const [loaded, setLoaded] = useState(false)
  const [flashId, setFlashId] = useState(null)
  const topRef = useRef(null)
  const firstRef = useRef(true)

  const summary = useMemo(() => summarize(decisions), [decisions])

  async function load() {
    try {
      const [h, v, r] = await Promise.all([api('/health'), api('/audit/verify'), api('/audit/recent?limit=60')])
      setHealth(h); setIntegrity(v); setDecisions(r.decisions || []); setError(null)
    } catch (e) { setError(e.message) }
    finally { setLoaded(true) }
  }
  useEffect(() => {
    load()
    const t = setInterval(load, 5000)
    return () => clearInterval(t)
  }, [])

  // Flash the row when a genuinely new decision lands (not on first paint).
  useEffect(() => {
    const top = decisions[0]?.request_id
    if (!top) return
    if (firstRef.current) { firstRef.current = false; topRef.current = top; return }
    if (top !== topRef.current) {
      topRef.current = top
      setFlashId(top)
      const t = setTimeout(() => setFlashId(null), 1600)
      return () => clearTimeout(t)
    }
  }, [decisions])

  // Smooth-scroll to the top when switching sections.
  useEffect(() => { window.scrollTo({ top: 0, behavior: 'smooth' }) }, [tab])

  return (
    <div className="min-h-screen">
      <div className="mx-auto max-w-6xl px-6 py-7">
        {/* masthead */}
        <header className="flex items-center justify-between gap-4 border-b border-line pb-5">
          <div className="flex items-center gap-3.5">
            <span
              className="grid h-11 w-11 place-items-center rounded-xl border border-line bg-slab/50"
              style={{ boxShadow: 'inset 0 1px 0 rgba(234,238,246,0.06)' }}
            >
              <AuraMark />
            </span>
            <div>
              <div className="text-[1.75rem] font-extrabold leading-none tracking-tight text-paper">AURA</div>
              <div className="eyebrow mt-1.5">Payment Intent Firewall</div>
            </div>
          </div>
          <StatusLine health={health} integrity={integrity} />
        </header>

        {error && (
          <div className="mt-4 flex items-center justify-between gap-4 border-l-2 border-denied pl-3">
            <span className="text-sm text-denied">Can't reach the backend — {error}</span>
            <button onClick={load} className="btn-line py-1 text-xs">Retry</button>
          </div>
        )}

        <div className="mt-6 grid gap-8 md:grid-cols-[8rem_1fr]">
          {/* quiet index — lifts on hover */}
          <nav className="flex gap-2 md:flex-col md:gap-1.5">
            {NAV.map((n) => {
              const active = tab === n.id
              return (
                <button
                  key={n.id}
                  onClick={() => setTab(n.id)}
                  className={`group flex origin-left items-center gap-2.5 py-1.5 text-[13px] md:w-full cursor-pointer transition-[transform,color] duration-200 ease-out hover:translate-x-1.5 hover:scale-[1.04] ${active ? 'text-paper' : 'text-mute hover:text-paper'}`}
                >
                  <span className={`w-[2px] rounded-full transition-all duration-200 ${active ? 'h-4 bg-paper' : 'h-1.5 bg-transparent group-hover:h-4 group-hover:bg-mute'}`} />
                  <span>{n.label}</span>
                  {n.soon && <span className="ml-auto text-[9px] text-mute/50 transition-opacity group-hover:text-mute">{n.soon}</span>}
                </button>
              )
            })}
          </nav>

          {/* main — eases in on section change */}
          <div key={tab} className="row-rise">
            {tab === 'overview' ? (
              <>
                <Metrics s={summary} />
                <div className="mt-8"><Hero d={decisions[0]} loaded={loaded} /></div>
                <div className="mt-8 grid gap-4 lg:grid-cols-2">
                  <CaughtBy s={summary} />
                  <SystemPanel health={health} integrity={integrity} s={summary} />
                </div>
                <Ledger decisions={decisions} integrity={integrity} onVerify={load} flashId={flashId} loaded={loaded} />
              </>
            ) : (
              <Arriving tab={tab} />
            )}
          </div>
        </div>

        <div className="mt-12 border-t border-line pt-4 text-xs text-mute">
          Test mode — no real money moves. Four signals (rules, ML risk, Groq, Gemini) combine most-restrictively; the AI can only escalate.
        </div>
      </div>
    </div>
  )
}
