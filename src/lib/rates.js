/* DayPay — rate periods (v18).
   A rate period is in force from its `from` date ('YYYY-MM-DD', inclusive)
   until the next period starts. Records keep the amounts they were logged
   with — periods govern new logs, re-classifications and projections, so
   a raise never rewrites days already recorded.
   Copyright © 2026 Akaninyene. All rights reserved. */

export function sortPeriods(periods) {
  return [...(periods || [])].sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0))
}

export function normalizePeriods(periods, fallback) {
  return sortPeriods((periods || []).filter(p => p && p.from).map(p => ({
    from: String(p.from),
    dailyRate: Number(p.dailyRate) || fallback.dailyRate,
    weekendMultiplier: Number(p.weekendMultiplier) || fallback.weekendMultiplier,
    holidayMultiplier: Number(p.holidayMultiplier) || fallback.holidayMultiplier,
  })))
}

// Migrate legacy single-rate settings into a first period anchored on the
// earliest logged day (or the start of the current month when nothing is logged).
export function migratePeriods(rawPeriods, settings, earliestKey, monthStartKey) {
  const norm = normalizePeriods(rawPeriods, settings)
  if (norm.length) return norm
  return [{
    from: earliestKey || monthStartKey,
    dailyRate: settings.dailyRate ?? 16000,
    weekendMultiplier: settings.weekendMultiplier ?? 2,
    holidayMultiplier: settings.holidayMultiplier ?? 2,
  }]
}

// The period in force on a given dateKey. Falls back to `fallbackSettings`
// (which must carry dailyRate / weekendMultiplier / holidayMultiplier).
export function rateFor(periods, dateKey, fallbackSettings) {
  if (!periods || !periods.length) return fallbackSettings
  let cur = periods[0]
  for (const p of periods) {
    if (p.from <= dateKey) cur = p
    else break
  }
  return cur
}
