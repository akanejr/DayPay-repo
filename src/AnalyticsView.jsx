import { useMemo } from 'react'
import { payslipModel, fmtEquiv } from './lib/payslip'

/* DayPay v26 — Analytics destination: personal work & earnings trends.
   Zero-dependency SVG charts over real attendance records (trailing
   window from tracking start, max 12 months ending with the current
   month). Figures reuse payslipModel, so types/amounts match payslips. */
const TYPE_META = [
  { key: 'regular', label: 'Regular', color: '#0757E8' },
  { key: 'weekend', label: 'Weekend 2×', color: '#16A34A' },
  { key: 'overtime', label: 'Overtime', color: '#B45309' },
  { key: 'holiday', label: 'Holiday', color: '#7C3AED' },
  { key: 'leave', label: 'Leave', color: '#64748B' },
]

function windowMonths(startMonthKey, realYear, realMonth) {
  const all = []
  let y = realYear, m = realMonth
  for (let i = 0; i < 12; i++) {
    const key = `${y}-${String(m + 1).padStart(2, '0')}`
    if (startMonthKey && key < startMonthKey) break
    all.unshift({ y, m, key })
    m -= 1
    if (m < 0) { m = 11; y -= 1 }
  }
  return all
}

export default function AnalyticsView({ attendance, startMonthKey, realYear, realMonth, formatNaira, getMonthName }) {
  const data = useMemo(() => {
    const recs = Object.values(attendance || {}).filter(Boolean)
    const months = windowMonths(startMonthKey, realYear, realMonth).map(({ y, m, key }) => {
      const model = payslipModel(recs.filter(r => r.date && r.date.startsWith(`${key}-`)))
      return { y, m, key, label: getMonthName(m, true), total: model.total, actual: model.actualDays, equiv: model.totalEquiv }
    })
    const span = payslipModel(recs.filter(r => months.some(mo => r.date && r.date.startsWith(`${mo.key}-`))))
    const g = Object.fromEntries(span.groups.map(x => [x.key, x.amount]))
    const types = [
      { key: 'regular', amount: g.regular || 0 },
      { key: 'weekend', amount: g.weekend || 0 },
      { key: 'overtime', amount: g.overtime || 0 },
      { key: 'holiday', amount: g.holiday || 0 },
      { key: 'leave', amount: span.leavePay || 0 },
    ]
    const max = Math.max(1, ...months.map(x => x.total))
    const best = months.reduce((a, b) => (b.total > (a ? a.total : -1) ? b : a), null)
    return { months, types, max, best, total: span.total, actual: span.actualDays, equiv: span.totalEquiv }
  }, [attendance, startMonthKey, realYear, realMonth, getMonthName])

  const W = 360, H = 188, PAD_L = 8, PAD_B = 26, PAD_T = 18
  const chartH = H - PAD_T - PAD_B
  const n = Math.max(1, data.months.length)
  const slot = (W - PAD_L * 2) / n
  const barW = Math.min(34, Math.max(10, slot * 0.52))
  const R = 54, CIRC = 2 * Math.PI * R
  let acc = 0
  const donut = data.types.map(t => {
    const frac = data.total > 0 ? t.amount / data.total : 0
    const seg = { ...t, frac, dash: frac * CIRC, off: -acc * CIRC }
    acc += frac
    return seg
  })
  const meta = Object.fromEntries(TYPE_META.map(t => [t.key, t]))

  return (
    <div className="an-wrap">
      <div className="an-tiles">
        <div className="an-tile"><div className="an-tile-num mono">{formatNaira(data.total)}</div><div className="an-tile-cap">Earned · window</div></div>
        <div className="an-tile"><div className="an-tile-num mono">{data.actual}</div><div className="an-tile-cap">Days worked</div></div>
        <div className="an-tile"><div className="an-tile-num mono">{data.actual > 0 ? formatNaira(Math.round(data.total / data.actual)) : formatNaira(0)}</div><div className="an-tile-cap">Avg / day worked</div></div>
        <div className="an-tile"><div className="an-tile-num mono">{data.best && data.best.total > 0 ? `${data.best.label} ’${String(data.best.y).slice(2)}` : '—'}</div><div className="an-tile-cap">Best month{data.best && data.best.total > 0 ? ` · ${formatNaira(data.best.total)}` : ''}</div></div>
      </div>

      <section className="an-card" aria-label="Monthly earnings chart">
        <div className="an-card-title">Monthly earnings</div>
        <svg className="an-bars" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Bar chart of earnings for ${data.months.length} months`}>
          <line x1={PAD_L} y1={PAD_T + chartH} x2={W - PAD_L} y2={PAD_T + chartH} className="an-axis" />
          {data.months.map((mo, i) => {
            const cx = PAD_L + slot * i + slot / 2
            const h = Math.max(mo.total > 0 ? 3 : 0, (mo.total / data.max) * chartH)
            const isBest = data.best && mo.key === data.best.key && mo.total > 0
            return (
              <g key={mo.key}>
                {isBest && <text x={cx} y={PAD_T - 5} textAnchor="middle" className="an-bar-val">{formatNaira(mo.total)}</text>}
                <rect x={cx - barW / 2} y={PAD_T + chartH - h} width={barW} height={h} rx={Math.min(5, barW / 3)} className={isBest ? 'an-bar best' : 'an-bar'} />
                <text x={cx} y={H - 8} textAnchor="middle" className="an-bar-label">{mo.label}</text>
              </g>
            )
          })}
        </svg>
        <div className="an-card-sub mono">{fmtEquiv(data.equiv)} paid-day equiv across the window</div>
      </section>

      <section className="an-card" aria-label="Earnings by work type">
        <div className="an-card-title">Earnings by work type</div>
        <div className="an-donut-row">
          <svg className="an-donut" viewBox="0 0 140 140" role="img" aria-label="Donut chart of earnings by work type">
            <circle cx="70" cy="70" r={R} className="an-track" />
            {donut.filter(s => s.frac > 0).map(s => (
              <circle
                key={s.key} cx="70" cy="70" r={R} fill="none"
                stroke={meta[s.key].color} strokeWidth="20"
                strokeDasharray={`${s.dash} ${CIRC - s.dash}`}
                strokeDashoffset={s.off} transform="rotate(-90 70 70)"
                strokeLinecap="butt"
              />
            ))}
            <text x="70" y="66" textAnchor="middle" className="an-donut-total">{formatNaira(data.total)}</text>
            <text x="70" y="84" textAnchor="middle" className="an-donut-sub">total</text>
          </svg>
          <div className="an-legend">
            {data.types.map(t => (
              <div className="an-leg-row" key={t.key}>
                <span className="an-swatch" style={{ background: meta[t.key].color }} aria-hidden="true" />
                <span className="an-leg-label">{meta[t.key].label}</span>
                <span className="an-leg-val mono">{formatNaira(t.amount)}</span>
              </div>
            ))}
          </div>
        </div>
      </section>
    </div>
  )
}
