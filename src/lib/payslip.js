/* DayPay v24.2 — payslip model (pure logic: no React, no jsPDF, no storage).
   Turns stored attendance records into the payslip's information architecture.

   CORE DISTINCTION — actual days worked vs paid-day equivalents:
     Regular day   = 1 paid-day equivalent
     Weekend / weekday-OT / holiday day = its stored multiplier
       (2 at the default 2× weekend/holiday multipliers)
     Leave = paid separately, NEVER counted as worked equivalents.
   Final salary = equivalents × daily rate (+ leave pay, if any).

   The payslip is a REPORT: records are read-only here. Amounts always come
   from stored record values; equations are only shown in the simple form
   when they reconcile exactly (single rate for the month), otherwise each
   group prints its own truthful line (v18 "truthful line" philosophy).
*/

const r2 = n => Math.round(Number(n) * 100) / 100

/* Deterministic naira formatting — explicit comma grouping, never dependent
   on the device locale: ₦16,000 · ₦304,000 · ₦400,000 (whole naira). */
export function fmtMoney(n) {
  const v = Number(n)
  if (!isFinite(v)) return '₦0'
  const neg = v < 0
  const s = Math.abs(Math.round(v)).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return `${neg ? '-' : ''}₦${s}`
}

/* 25 → "25" · 26.5 → "26.5" — up to 2 decimals, no trailing zeros. */
export function fmtEquiv(n) {
  const v = Number(n)
  if (!isFinite(v)) return '0'
  return String(Math.round(v * 100) / 100)
}

/* Paid-day equivalents for ONE stored record. Non-leave records earn their
   stored multiplier (1 regular, 2 weekend/OT/holiday at 2×). Legacy records
   stamped before `multiplier` existed fall back to amount ÷ rate. */
export function equivOf(rec) {
  if (!rec || rec.isLeave) return 0
  if (typeof rec.multiplier === 'number' && isFinite(rec.multiplier)) return rec.multiplier
  if (rec.rate) return (rec.amount || 0) / rec.rate
  return 0
}

/* Classification mirrors monthlyStats precedence: weekend > OT > holiday. */
function classify(rec) {
  if (rec.isWeekend) return 'weekend'
  if (rec.isOvertime) return 'overtime'
  if (rec.isHoliday) return 'holiday'
  return 'regular'
}

const GROUP_LABEL = { regular: 'Regular', weekend: 'Weekend OT', overtime: 'Weekday OT', holiday: 'Holiday' }
const GROUP_SHORT = { weekend: 'Weekend', overtime: 'OT', holiday: 'Holiday' }

/* '2026-08-03' → { text: '03 Aug 2026', day: 'Mon' }. Parsed as a LOCAL date
   (never `new Date(key)`, which is UTC and shifts the weekday in some zones)
   and formatted from fixed tables (never device-locale dependent). */
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MON3 = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
export function payslipDate(key) {
  const [y, m, d] = String(key || '').split('-').map(Number)
  if (!y || !m || !d) return { text: String(key || ''), day: '' }
  const dt = new Date(y, m - 1, d)
  return {
    text: `${String(d).padStart(2, '0')} ${MON3[m - 1] || ''} ${y}`,
    day: DOW[dt.getDay()],
  }
}

/* Payslip timestamp — deterministic and unambiguous: "16 Sep 2026, 10:35 AM".
   Never toLocaleString() (M/D vs D/M ambiguity across device locales). */
export function fmtStamp(d = new Date()) {
  const dd = String(d.getDate()).padStart(2, '0')
  const h24 = d.getHours()
  const ap = h24 >= 12 ? 'PM' : 'AM'
  const h = h24 % 12 === 0 ? 12 : h24 % 12
  return `${dd} ${MON3[d.getMonth()]} ${d.getFullYear()}, ${String(h).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')} ${ap}`
}

const trunc = (s, n) => {
  s = String(s || '')
  return s.length > n ? `${s.slice(0, n - 1)}…` : s
}

/* Full payslip model for one month's records (already filtered to the month).
   leaveName(id) resolves a leave-type id to its display name. */
export function payslipModel(records, { leaveName = () => 'Leave' } = {}) {
  const groups = {}
  for (const key of Object.keys(GROUP_LABEL)) {
    groups[key] = { key, label: GROUP_LABEL[key], actual: 0, equiv: 0, amount: 0, rates: new Set(), mults: new Set(), amts: new Set() }
  }
  let leaveDays = 0
  let leavePay = 0
  const list = Array.isArray(records) ? records : []
  for (const rec of list) {
    if (!rec) continue
    if (rec.isLeave) { leaveDays += 1; leavePay += rec.amount || 0; continue }
    const g = groups[classify(rec)]
    g.actual += 1
    const e = equivOf(rec)
    g.equiv += e
    g.amount += rec.amount || 0
    if (rec.rate) g.rates.add(rec.rate)
    g.mults.add(e)
    g.amts.add(rec.amount)
  }
  const one = s => (s.size === 1 ? [...s][0] : null)
  const groupArr = Object.values(groups).map(g => ({
    key: g.key, label: g.label, actual: g.actual,
    equiv: r2(g.equiv), amount: r2(g.amount),
    rate: one(g.rates), mult: one(g.mults), amt: one(g.amts),
  }))
  const actualDays = groupArr.reduce((s, g) => s + g.actual, 0)
  const totalEquiv = r2(groupArr.reduce((s, g) => s + g.equiv, 0))
  const nonLeavePay = r2(groupArr.reduce((s, g) => s + g.amount, 0))
  leavePay = r2(leavePay)
  const total = r2(nonLeavePay + leavePay)
  const allRates = new Set()
  for (const rec of list) if (rec && !rec.isLeave && rec.rate) allRates.add(rec.rate)
  const singleRate = one(allRates)
  const premiumEquivs = new Set()
  let premiumDays = 0
  for (const rec of list) {
    if (rec && !rec.isLeave && classify(rec) !== 'regular') { premiumDays += 1; premiumEquivs.add(equivOf(rec)) }
  }
  const typicalPremiumMult = premiumDays ? one(premiumEquivs) : null
  const standardTwoX = typicalPremiumMult === 2
  // The simple equation is only shown when the DISPLAYED (rounded) values
  // reconcile exactly — otherwise groups print their own truthful lines.
  const reconciles = singleRate != null
    && Math.round(singleRate * totalEquiv) + Math.round(leavePay) === Math.round(total)
  return {
    groups: groupArr, leaveDays, leavePay,
    actualDays, totalEquiv, nonLeavePay, total,
    singleRate, typicalPremiumMult, standardTwoX, reconciles,
    leaveName,
  }
}

/* Which one-line explanation the summary needs:
   none (empty month) · regular (equiv == actual) · twoX · premium · mixed. */
export function explainerKind(model) {
  if (model.actualDays === 0 && model.leaveDays === 0) return 'none'
  if (model.singleRate == null) return 'mixed'
  const premiumDays = model.groups.reduce((s, g) => s + (g.key === 'regular' ? 0 : g.actual), 0)
  if (!premiumDays) return 'regular'
  return model.standardTwoX ? 'twoX' : 'premium'
}

/* Structured PAY CALCULATION lines. The renderer is dumb — every line here is
   pre-validated to be true. Kinds: step · result · math · total · kv · note. */
export function calcLines(model) {
  if (model.actualDays === 0 && model.leaveDays === 0) {
    return [{ kind: 'total', text: `= ${fmtMoney(model.total)}` }]
  }
  if (model.reconciles && model.singleRate != null) {
    const lines = []
    for (const g of model.groups) {
      if (!g.actual) continue
      if (g.key === 'regular') lines.push({ kind: 'step', text: `${g.actual} Regular day${g.actual === 1 ? '' : 's'}` })
      else lines.push({ kind: 'step', text: `+ ${fmtEquiv(g.equiv)} ${GROUP_SHORT[g.key]} paid-day equivalent${g.equiv === 1 ? '' : 's'}` })
    }
    lines.push({ kind: 'result', text: `= ${fmtEquiv(model.totalEquiv)} paid-day equivalents` })
    let math = `${fmtEquiv(model.totalEquiv)} × ${fmtMoney(model.singleRate)}`
    if (model.leavePay > 0) math += ` + ${fmtMoney(model.leavePay)} leave pay`
    lines.push({ kind: 'math', text: math })
    lines.push({ kind: 'total', text: `= ${fmtMoney(model.total)}` })
    return lines
  }
  // Mixed rates (or unreconciled): per-group truthful lines, never a false "=".
  const lines = []
  for (const g of model.groups) {
    if (!g.actual) continue
    const uniform = g.amt != null && g.actual * g.amt === g.amount
    lines.push({
      kind: 'kv',
      left: g.label,
      right: uniform
        ? `${g.actual} × ${fmtMoney(g.amt)} = ${fmtMoney(g.amount)}`
        : `${g.actual} day${g.actual === 1 ? '' : 's'} = ${fmtMoney(g.amount)}`,
    })
  }
  if (model.leaveDays > 0) {
    lines.push({ kind: 'kv', left: 'Leave', right: `${model.leaveDays} day${model.leaveDays === 1 ? '' : 's'} = ${fmtMoney(model.leavePay)}` })
  }
  lines.push({ kind: 'note', text: 'Rates changed during this period — each day is valued at the rate in force when it was worked.' })
  lines.push({ kind: 'totalKV', left: 'Total', right: fmtMoney(model.total) })
  return lines
}

/* Breakdown table rows: { label, actual, equivText, rateText, amount }. */
export function breakdownRows(model) {
  const rows = model.groups.map(g => {
    const rate = g.rate ?? model.singleRate
    let rateText
    if (rate == null) rateText = 'mixed'
    else if (g.key === 'regular') rateText = fmtMoney(rate)
    else {
      const mult = g.mult ?? model.typicalPremiumMult
      rateText = mult == null || mult === 1 ? fmtMoney(rate) : `${fmtMoney(rate)} ×${fmtEquiv(mult)}`
    }
    return { label: g.label, actual: g.actual, equivText: fmtEquiv(g.equiv), rateText, amount: g.amount }
  })
  rows.push({ label: 'Leave', actual: model.leaveDays, equivText: '—', rateText: '—', amount: model.leavePay })
  return rows
}

/* Attendance detail rows, sorted by date. Only RECORDED days — unworked days
   (e.g. 28 Aug 2026 in the example month) never appear. */
export function attendanceRows(records, { leaveName = () => 'Leave' } = {}) {
  const list = (Array.isArray(records) ? records : []).filter(Boolean).slice()
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
  return list.map(rec => {
    const { text, day } = payslipDate(rec.date)
    let type = 'Regular'
    if (rec.isLeave) type = leaveName(rec.leaveType)
    else if (rec.isWeekend) type = 'Weekend OT'
    else if (rec.isOvertime) type = 'Weekday OT'
    else if (rec.isHoliday) type = `Holiday${rec.holidayName ? ` (${rec.holidayName})` : ''}`
    return {
      date: text, day, type: trunc(type, 30),
      rate: fmtMoney(rec.rate), equiv: rec.isLeave ? '—' : fmtEquiv(equivOf(rec)),
      amount: fmtMoney(rec.amount),
    }
  })
}
