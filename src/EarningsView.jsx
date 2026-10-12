import { useMemo } from 'react'
import { payslipModel, fmtEquiv } from './lib/payslip'

/* DayPay v26 — Earnings destination: personal earnings history.
   Every figure is computed from real attendance records with the same
   payslipModel as payslips (actual days vs paid-day equivalents, stored
   amounts, leave rules). Months run from tracking start through the
   current month, newest first, grouped by year. Tapping a month opens it
   on the Dashboard. */
function monthsDescending(startMonthKey, realYear, realMonth) {
  const out = []
  let y = realYear, m = realMonth
  const guard = (realYear - 1970) * 12 + 60
  while (out.length < guard) {
    const key = `${y}-${String(m + 1).padStart(2, '0')}`
    if (startMonthKey && key < startMonthKey) break
    out.push({ y, m, key })
    m -= 1
    if (m < 0) { m = 11; y -= 1 }
  }
  return out
}

export default function EarningsView({
  attendance, startMonthKey, realYear, realMonth,
  statusFor, unlockedFor, onOpenMonth, formatNaira, getMonthName,
}) {
  const groups = useMemo(() => {
    const recs = Object.values(attendance || {}).filter(Boolean)
    const months = monthsDescending(startMonthKey, realYear, realMonth).map(({ y, m, key }) => {
      const prefix = `${key}-`
      const model = payslipModel(recs.filter(r => r.date && r.date.startsWith(prefix)))
      return {
        y, m, key,
        status: statusFor(y, m),
        unlocked: unlockedFor(key),
        actual: model.actualDays,
        equiv: model.totalEquiv,
        total: model.total,
        leaveDays: model.leaveDays,
      }
    })
    const byYear = []
    for (const mo of months) {
      let g = byYear.find(g => g.year === mo.y)
      if (!g) {
        const yModel = payslipModel(recs.filter(r => r.date && r.date.startsWith(`${mo.y}-`)))
        g = { year: mo.y, months: [], yActual: yModel.actualDays, yEquiv: yModel.totalEquiv, yTotal: yModel.total }
        byYear.push(g)
      }
      g.months.push(mo)
    }
    return byYear
  }, [attendance, startMonthKey, realYear, realMonth, statusFor, unlockedFor])

  const grand = useMemo(() => {
    const model = payslipModel(Object.values(attendance || {}).filter(Boolean))
    return { actual: model.actualDays, equiv: model.totalEquiv, total: model.total }
  }, [attendance])

  return (
    <div className="ev-wrap">
      <div className="ev-hero">
        <div className="ev-hero-label">Total earned{startMonthKey ? ` · since ${getMonthName(parseInt(startMonthKey.slice(5, 7), 10) - 1, true)} ${startMonthKey.slice(0, 4)}` : ''}</div>
        <div className="ev-hero-amount">{formatNaira(grand.total)}</div>
        <div className="ev-hero-sub mono">{grand.actual} days worked · {fmtEquiv(grand.equiv)} paid-day equiv</div>
      </div>
      {groups.length === 0 && (
        <div className="ev-empty">No earnings records yet. Days you log will appear here by month.</div>
      )}
      {groups.map(g => (
        <section className="ev-year" key={g.year} aria-label={`Earnings ${g.year}`}>
          <div className="ev-year-head">
            <span className="ev-year-name">{g.year}</span>
            <span className="ev-year-total mono">{formatNaira(g.yTotal)}</span>
          </div>
          <div className="ev-year-sub mono">{g.yActual} days · {fmtEquiv(g.yEquiv)} equiv</div>
          <div className="ev-rows">
            {g.months.map(mo => (
              <button
                key={mo.key}
                type="button"
                className="ev-row"
                onClick={() => onOpenMonth(mo.y, mo.m)}
                aria-label={`Open ${getMonthName(mo.m)} ${mo.y}, ${formatNaira(mo.total)}`}
              >
                <span className="ev-row-main">
                  <span className="ev-row-name">{getMonthName(mo.m)}</span>
                  <span className={`ev-pill ${mo.status}${mo.unlocked ? ' unlocked' : ''}`}>
                    {mo.status === 'locked' ? (mo.unlocked ? 'Unlocked' : 'Locked') : mo.status === 'active' ? 'Active' : mo.status === 'future' ? 'Upcoming' : 'Before start'}
                  </span>
                </span>
                <span className="ev-row-mid mono">{mo.actual > 0 || mo.total > 0 ? `${mo.actual}d · ${fmtEquiv(mo.equiv)}eq${mo.leaveDays > 0 ? ` · ${mo.leaveDays}lv` : ''}` : '—'}</span>
                <span className="ev-row-amt mono">{formatNaira(mo.total)}</span>
                <span className="ev-row-chev" aria-hidden="true">›</span>
              </button>
            ))}
          </div>
        </section>
      ))}
    </div>
  )
}
