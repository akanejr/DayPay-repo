/* DayPay — Africa/Lagos date handling (v26).
   The user's "today", month boundaries, and generated-at stamps follow
   Africa/Lagos wall-clock time. Stored attendance keys are plain
   'YYYY-MM-DD' strings and are never rewritten by this module. */
const LAGOS_TZ = 'Africa/Lagos'
const dKey = new Intl.DateTimeFormat('en-CA', { timeZone: LAGOS_TZ, year: 'numeric', month: '2-digit', day: '2-digit' })
const dFull = new Intl.DateTimeFormat('en-CA', {
  timeZone: LAGOS_TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
})

// Lagos calendar date as 'YYYY-MM-DD' (en-CA renders exactly this shape).
export function lagosKey(d = new Date()) {
  return dKey.format(d)
}

// Lagos wall-clock carried in a local Date: every consumer reads wall
// fields (getFullYear/getMonth/getDate/getHours/...) so all "today"
// boundaries, comparisons, and day arithmetic stay correct.
export function lagosNow(d = new Date()) {
  const m = dFull.format(d).match(/(\d{4})-(\d{2})-(\d{2}),?\s+(\d{2}):(\d{2}):(\d{2})/)
  if (!m) return new Date(d.getTime())
  const h = m[4] === '24' ? 0 : Number(m[4]) // h24 midnight guard
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), h, Number(m[5]), Number(m[6]))
}
