/* DayPay v23 — Reminder engine.
   Copyright © 2026 Akaninyene. All rights reserved.
   Unauthorized copying, modification, or distribution is prohibited.

   Two delivery paths (hybrid):
   1. In-app / web notification — fired by the page scheduler in App.jsx
      (works while the app is open / installed PWA).
   2. "Make it a real alarm" — a recurring .ics calendar event with a
      VALARM. Imported into the phone's Calendar app it rings at the set
      time via the OS alarm system — the only web-compatible route to a
      true ringing alarm (no browser API can write to the OS clock).
*/

const DAY_CODE = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA']
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

/* Normalize a stored reminder (cloud/local jsonb) into a safe shape.
   days = JS Date.getDay() values 0 (Sun) – 6 (Sat); time = "HH:MM". */
export function normalizeReminder(r) {
  if (!r || typeof r !== 'object') return { enabled: false, days: [], time: '18:00' }
  const days = Array.isArray(r.days)
    ? [...new Set(r.days.map(Number).filter(d => Number.isInteger(d) && d >= 0 && d <= 6))].sort((a, b) => a - b)
    : []
  let time = '18:00'
  if (typeof r.time === 'string' && /^\d{2}:\d{2}$/.test(r.time)) {
    const [h, m] = r.time.split(':').map(Number)
    if (h <= 23 && m <= 59) time = r.time
  }
  return { enabled: !!r.enabled, days, time }
}

/* Next occurrence of (days, time) strictly after `from`, within 8 days. */
export function nextReminder(days, time, from = new Date()) {
  if (!days || !days.length) return null
  const [h, m] = String(time).split(':').map(Number)
  if (isNaN(h) || isNaN(m) || h > 23 || m > 59) return null
  for (let i = 0; i < 8; i++) {
    const d = new Date(from.getFullYear(), from.getMonth(), from.getDate() + i, h, m, 0, 0)
    if (days.includes(d.getDay()) && d.getTime() > from.getTime()) return d
  }
  return null
}

/* Human summary, Monday-first: "Mon · Wed · Fri · 18:00" / "Every day". */
export function describeReminder(days, time) {
  if (!days || !days.length) return 'No days selected'
  if (days.length === 7) return `Every day · ${time}`
  const ordered = [...days].sort((a, b) => (a + 6) % 7 - (b + 6) % 7)
  return `${ordered.map(d => DAY_NAMES[d]).join(' · ')} · ${time}`
}

/* Recurring .ics with a VALARM at the start. DTSTART is a floating local
   time, so the calendar app rings it at that local time on each match.
   iOS and Android both import .ics with alarms natively. */
export function buildReminderIcs(days, time, originUrl) {
  const [h, m] = String(time).split(':').map(Number)
  const pad = n => String(n).padStart(2, '0')
  const now = new Date()
  const start = nextReminder(days, time, new Date(now.getTime() - 60000)) || new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, m, 0, 0)
  const end = new Date(start.getTime() + 10 * 60000)
  const dt = d => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}T${pad(d.getHours())}${pad(d.getMinutes())}00`
  const dtstamp = `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}T${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}Z`
  const rrule = days.length === 7
    ? 'FREQ=DAILY'
    : `FREQ=WEEKLY;BYDAY=${[...days].sort((a, b) => a - b).map(d => DAY_CODE[d]).join(',')}`
  const uid = `daypay-rem-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}@daypay`
  const descText = ['Open DayPay and stamp today’s work.', originUrl || ''].filter(Boolean).join('\\n')
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//DayPay//Reminders 1.0//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `DTSTAMP:${dtstamp}`,
    `DTSTART:${dt(start)}`,
    `DTEND:${dt(end)}`,
    `RRULE:${rrule}`,
    'SUMMARY:DayPay — log your day',
    `DESCRIPTION:${descText}`,
    'BEGIN:VALARM',
    'ACTION:DISPLAY',
    'DESCRIPTION:DayPay — log your day',
    'TRIGGER:-PT0S',
    'END:VALARM',
    'END:VEVENT',
    'END:VCALENDAR',
  ]
  return lines.join('\r\n') + '\r\n'
}
