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
  { id: 'decisions', label: 'Decisions' },
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
function Metrics({ s }) {
  const flaggedRate = s.total ? Math.round(((s.STEP_UP + s.BLOCK) / s.total) * 100) : 0
  const cells = [
    { label: 'Screened', value: s.total, sub: 'payment intents' },
    { label: 'Cleared', value: s.ALLOW, sub: `${rupees(s.cleared_paise)} · ${s.executed} on rail` },
    { label: 'Held / denied', value: s.STEP_UP + s.BLOCK, sub: `${flaggedRate}% flagged` },
    { label: 'Value stopped', value: rupees(s.flagged_paise), sub: 'held or denied' },
  ]
  return (
    <section>
      <div className="grid grid-cols-2 rounded-lg border border-line sm:grid-cols-4">
        {cells.map((c, i) => (
          <div key={c.label} className={`px-5 py-4 ${i % 2 !== 0 ? 'border-l border-line' : ''} ${i % 4 !== 0 ? 'sm:border-l sm:border-line' : ''} ${i >= 2 ? 'border-t border-line sm:border-t-0' : ''}`}>
            <div className="eyebrow">{c.label}</div>
            <div className="mono mt-2 text-[26px] font-semibold leading-none tracking-tight tnum text-paper">{c.value}</div>
            <div className="mt-2 text-xs text-faint">{c.sub}</div>
          </div>
        ))}
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
function Hero({ d, loaded }) {
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
    <section key={d.request_id} className="panel row-rise p-6">
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
function CaughtBy({ s }) {
  const flagged = s.STEP_UP + s.BLOCK
  const rows = [['Rules', s.by.rules], ['Risk model', s.by['risk model']], ['AI judge', s.by['AI judge']]]
  return (
    <section className="panel p-5">
      <h2 className="head">What's catching payments</h2>
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
    <section className="panel p-5">
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
function Ledger({ decisions, integrity, onVerify, flashId, loaded, updatedAt }) {
  return (
    <section>
      <div className="mb-3 flex items-baseline justify-between">
        <h2 className="head">Ledger
          <span className="flex items-center gap-1 text-[10px] font-medium text-faint"><i className="live-dot h-1.5 w-1.5 rounded-full bg-cleared" />live</span>
        </h2>
        <div className="flex items-center gap-3 text-xs">
          <UpdatedAgo at={updatedAt} />
          <button onClick={onVerify} className="press text-faint hover:text-paper">
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
              {decisions.map((d) => (
                <tr key={d.request_id} className={`border-t border-line/70 transition-colors hover:bg-slab2 ${d.request_id === flashId ? 'row-rise' : ''}`}>
                  <td className="mono px-5 py-3 tnum text-faint">{clock(d.timestamp)}</td>
                  <td className="py-3 pr-4 text-paper">{d.merchant || '—'}</td>
                  <td className="mono py-3 pr-4 text-right tnum text-paper">{rupees(d.amount_paise)}</td>
                  <td className="seal hidden py-3 pr-4 text-faint sm:table-cell">{(d.entry_hash || '').slice(0, 8)}</td>
                  <td className="py-3 pr-5 text-right"><Verdict d={d.decision} className="justify-end text-xs" /></td>
                </tr>
              ))}
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
        <h2 className="head">Decision ledger
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
                <Metrics s={summary} />
                <Hero d={decisions[0]} loaded={loaded} />
                <div className="grid gap-6 lg:grid-cols-2">
                  <CaughtBy s={summary} />
                  <SystemPanel health={health} integrity={integrity} s={summary} />
                </div>
                <Ledger decisions={decisions} integrity={integrity} onVerify={load} flashId={flashId} loaded={loaded} updatedAt={updatedAt} />
              </div>
            ) : tab === 'simulate' ? (
              <Simulate onDone={load} user={user} onGoPending={() => setTab('pending')} />
            ) : tab === 'decisions' ? (
              <Decisions decisions={decisions} integrity={integrity} onVerify={load} loaded={loaded} user={user} />
            ) : tab === 'policy' ? (
              <Policy user={user} />
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
    const init = () => {
      if (!window.google?.accounts?.id || !ref.current) return false
      window.google.accounts.id.initialize({ client_id: GOOGLE_CLIENT_ID, callback: handle })
      window.google.accounts.id.renderButton(ref.current, { theme: 'filled_black', size: 'large', text: 'continue_with', width: 300, shape: 'rectangular' })
      return true
    }
    if (init()) return
    const s = document.createElement('script')
    s.src = 'https://accounts.google.com/gsi/client'; s.async = true; s.defer = true; s.onload = init
    document.head.appendChild(s)
  }, [])
  if (!GOOGLE_CLIENT_ID) return null
  return (
    <>
      <div ref={ref} className="flex justify-center" />
      <div className="flex items-center gap-3 text-[11px] text-faint">
        <span className="h-px flex-1 bg-line" />or<span className="h-px flex-1 bg-line" />
      </div>
    </>
  )
}

function Login({ onLogin }) {
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
          <div className="eyebrow">Sign in</div>
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

// Fallback auth (no Clerk key configured): the lightweight username sign-in.
function LocalAuthApp() {
  const [user, setUser] = useState(() => {
    try { const s = localStorage.getItem('aura_user'); return s ? JSON.parse(s) : null } catch { return null }
  })
  const login = (u) => { try { localStorage.setItem('aura_user', JSON.stringify(u)) } catch { /* ignore */ } setUser(u) }
  const logout = () => { try { localStorage.removeItem('aura_user') } catch { /* ignore */ } setUser(null) }

  if (!user) return <Login onLogin={login} />
  return <Dashboard user={user} onLogout={logout} />
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

function ClerkLogin() {
  return (
    <div className="grid min-h-screen place-items-center px-6">
      <div className="row-rise">
        <div className="mb-8 text-center">
          <h1 className="text-[26px] font-extrabold tracking-tight text-paper">AURA</h1>
          <p className="eyebrow mt-2">Payment Intent Firewall</p>
        </div>
        <SignIn routing="hash" appearance={CLERK_APPEARANCE} />
        <p className="mt-4 text-center text-xs text-faint">Test mode — your account scopes your payments and policy.</p>
      </div>
    </div>
  )
}

export default function App() {
  if (!CLERK_KEY) return <LocalAuthApp />
  return (
    <ClerkProvider publishableKey={CLERK_KEY} afterSignOutUrl="/" appearance={CLERK_APPEARANCE}>
      <SignedOut><ClerkLogin /></SignedOut>
      <SignedIn><ClerkDashboard /></SignedIn>
    </ClerkProvider>
  )
}
