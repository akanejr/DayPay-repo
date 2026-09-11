/* DayPay — Know what your work is worth.
   Copyright © 2026 Akaninyene. All rights reserved.
   Unauthorized copying, modification, or distribution is prohibited. */

import { useState, useEffect, useMemo, useRef } from 'react'
import { supabase, isSupabaseConfigured } from './lib/supabase'
import { sortPeriods, migratePeriods, rateFor as rateForPeriod } from './lib/rates'
import jsPDF from 'jspdf'

const STORAGE_KEY = 'work_tracker_v1'
const START_KEY = 'work_tracker_start_v1'

function formatDateKey(d) {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}
function isWeekendDay(dateObj) {
  const day = dateObj.getDay()
  return day === 0 || day === 6
}
function formatNaira(n) {
  return `₦${Number(n).toLocaleString('en-NG')}`
}
// v18: truthful share/PDF line — "N × ₦per-day" only when every day in the
// group paid the same amount; a mixed-rate group shows "N days" instead.
function rateLine(n, pay, amt) {
  const left = (amt && n > 0 && n * amt === pay) ? `${n} × ${formatNaira(amt)}` : `${n} day${n === 1 ? '' : 's'}`
  return `${left} = ${formatNaira(pay)}`
}
function shortDate(key) {
  const d = new Date(`${key}T00:00:00`)
  return isNaN(d) ? key : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
}
// v18 appearance modes — shown in the hamburger "Choose theme" picker and Settings
const THEME_OPTIONS = [
  { id: 'light', label: 'Light', sw: 'sw-light' },
  { id: 'dark', label: 'Dark', sw: 'sw-dark' },
  { id: 'glass-dark', label: 'Glass · Dark', sw: 'sw-glass-dark' },
  { id: 'glass-light', label: 'Glass · Light', sw: 'sw-glass-light' },
]

// v18-C: Export my data — one tap in Settings downloads the raw record.
// JSON = every record + setting (a full backup); CSV = one row per worked day.
function fileDateStamp(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
function sortedDayRecords(attendance) {
  return Object.values(attendance || {}).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
}
function csvCell(v) {
  const s = String(v)
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}
function buildDayPayBackup(attendance, settings, leaveTypes) {
  const records = sortedDayRecords(attendance)
  const total = records.reduce((s, r) => s + (r.amount || 0), 0)
  return JSON.stringify({
    app: 'DayPay',
    format: 'daypay-backup',
    version: 1,
    exportedAt: new Date().toISOString(),
    records,
    settings: {
      dailyRate: settings.dailyRate,
      weekendMultiplier: settings.weekendMultiplier,
      holidayMultiplier: settings.holidayMultiplier,
      salaryGoal: settings.salaryGoal,
      paydayDay: settings.paydayDay,
      startMonthKey: settings.startMonthKey ?? null,
      ratePeriods: settings.ratePeriods ?? [],
      leaveTypes,
    },
    summary: {
      days: records.length,
      totalEarned: total,
      firstDay: records.length ? records[0].date : null,
      lastDay: records.length ? records[records.length - 1].date : null,
    },
  }, null, 2)
}
function buildDayPayCsv(attendance) {
  const rows = ['date,day,type,rate,amount']
  for (const r of sortedDayRecords(attendance)) {
    const d = new Date(`${r.date}T00:00:00`)
    const day = isNaN(d) ? '' : d.toLocaleDateString('en-GB', { weekday: 'short' })
    const type = r.isOvertime ? 'overtime' : r.isWeekend ? 'weekend' : r.isHoliday ? 'holiday' : r.isLeave ? 'leave' : 'work'
    rows.push([r.date, day, type, r.rate ?? 0, r.amount ?? 0].map(csvCell).join(','))
  }
  return rows.join('\r\n') + '\r\n'
}
function triggerDownload(name, content, mime) {
  try {
    const url = URL.createObjectURL(new Blob([content], { type: mime }))
    const a = document.createElement('a')
    a.href = url
    a.download = name
    document.body.appendChild(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 1500)
  } catch {}
}
function getMonthName(monthIndex, short = false) {
  const names = short
    ? ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
    : ['January','February','March','April','May','June','July','August','September','October','November','December']
  return names[monthIndex]
}
function monthKey(year, month) {
  return `${year}-${String(month+1).padStart(2,'0')}`
}
function parseMonthKey(key) {
  const [y,m] = key.split('-').map(Number)
  return { year: y, month: m-1 }
}
function ordDay(n) {
  if (n >= 11 && n <= 13) return `${n}th`
  switch (n % 10) { case 1: return `${n}st`; case 2: return `${n}nd`; case 3: return `${n}rd`; default: return `${n}th` }
}
// Leave & absence types. Paid leave accrues the regular daily rate (salaried
// pay doesn't drop); unpaid leave accrues nothing. Stored on the attendance
// record so locking, sync, projection and export all follow automatically.
// Default leave types — user-managed in Settings (add / rename / delete / set pay).
// payMode 'percent' = share of the daily rate · 'flat' = fixed ₦ per day.
// Existing logged entries always keep their original amounts (future-only changes).
const DEFAULT_LEAVE_TYPES = [
  { id: 'annual', name: 'Annual leave', payMode: 'percent', payValue: 100 },
  { id: 'sick', name: 'Sick leave', payMode: 'percent', payValue: 100 },
  { id: 'permission', name: 'Permission', payMode: 'percent', payValue: 100 },
  { id: 'unpaid', name: 'Unpaid leave', payMode: 'percent', payValue: 0 },
]

// Nigerian Public Holidays - Fixed + some movable for 2024-2027 (fallback if API fails)
/* AnimatedAmount — premium count-up for earnings figures (visual only).
   Renders the same formatted value the app already computes; on change,
   counts smoothly to the new value (550ms, ease-out). Reduced motion =
   instant swap. Parent carries .dp-count so ux-motion skips its bump. */
function AnimatedAmount({ value }) {
  const ref = useRef(null)
  const prevRef = useRef(value)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const from = prevRef.current
    const to = value
    prevRef.current = value
    if (from === to) { el.textContent = formatNaira(to); return }
    const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches
    if (reduce) { el.textContent = formatNaira(to); return }
    const DUR = 550
    const t0 = performance.now()
    let raf = 0
    const step = (t) => {
      const p = Math.min(1, (t - t0) / DUR)
      const e = 1 - Math.pow(1 - p, 3)
      el.textContent = formatNaira(Math.round(from + (to - from) * e))
      if (p < 1) raf = requestAnimationFrame(step)
    }
    raf = requestAnimationFrame(step)
    return () => cancelAnimationFrame(raf)
  }, [value])
  return <span className="dp-amount" ref={ref}>{formatNaira(value)}</span>
}

function getNigerianHolidaysFallback(year) {
  const fixed = [
    { month: 0, day: 1, name: "New Year's Day" },
    { month: 4, day: 1, name: "Workers' Day" },
    { month: 5, day: 12, name: "Democracy Day" },
    { month: 9, day: 1, name: "Independence Day" },
    { month: 11, day: 25, name: "Christmas Day" },
    { month: 11, day: 26, name: "Boxing Day" },
  ]
  const movable = {
    2024: [
      { month: 2, day: 29, name: "Good Friday" },
      { month: 3, day: 1, name: "Easter Monday" },
      { month: 3, day: 10, name: "Eid al-Fitr" },
      { month: 5, day: 16, name: "Eid al-Adha" },
    ],
    2025: [
      { month: 3, day: 18, name: "Good Friday" },
      { month: 3, day: 21, name: "Easter Monday" },
      { month: 2, day: 30, name: "Eid al-Fitr" },
      { month: 5, day: 6, name: "Eid al-Adha" },
    ],
    2026: [
      { month: 3, day: 3, name: "Good Friday" },
      { month: 3, day: 6, name: "Easter Monday" },
      { month: 2, day: 20, name: "Eid al-Fitr" },
      { month: 4, day: 27, name: "Eid al-Adha" },
    ],
    2027: [
      { month: 2, day: 26, name: "Good Friday" },
      { month: 2, day: 29, name: "Easter Monday" },
      { month: 2, day: 9, name: "Eid al-Fitr" },
      { month: 4, day: 16, name: "Eid al-Adha" },
    ]
  }
  return [...fixed, ...(movable[year] || [])]
}

function isHolidayDayFallback(dateObj) {
  if (!dateObj) return null
  const holidays = getNigerianHolidaysFallback(dateObj.getFullYear())
  const found = holidays.find(h => h.month === dateObj.getMonth() && h.day === dateObj.getDate())
  return found || null
}

export default function App() {
  const [currentDate, setCurrentDate] = useState(() => new Date())
  const [view, setView] = useState('month')
  const [attendance, setAttendance] = useState({})
  const [settings, setSettings] = useState({ dailyRate: 16000, weekendMultiplier: 2, holidayMultiplier: 2, salaryGoal: 500000, paydayDay: 0, ratePeriods: [] })
  const [startMonthKey, setStartMonthKey] = useState(null)
  const [showSettings, setShowSettings] = useState(false)
  const [showFutureDays, setShowFutureDays] = useState(false)
  const [goalInput, setGoalInput] = useState('500000')
  const [paydayInput, setPaydayInput] = useState('0')
  const [rateDraft, setRateDraft] = useState(null) // draft rate periods while Settings is open (applied on Save)
  const [rateForm, setRateForm] = useState(null)   // { from, rate } — the "Add rate change" inline form
  const [spFold, setSpFold] = useState({ pay: false, track: false }) // v18 settings tidy: collapsed sections
  const [sumFold, setSumFold] = useState(false) // v18 month page: details collapsed by default
  const [ltDraft, setLtDraft] = useState(null)
  const [loaded, setLoaded] = useState(false)

  // Nigerian holidays from Nager.Date API (free, no key)
  const [holidaysMap, setHolidaysMap] = useState({}) // key: YYYY-MM-DD -> {name, date, localName}
  const [holidaysLoading, setHolidaysLoading] = useState(false)

  // Cloud / Auth
  const [user, setUser] = useState(null)
  const [authLoading, setAuthLoading] = useState(true)
  const [showAuth, setShowAuth] = useState(false)
  const [authMode, setAuthMode] = useState('signin')
  const [authForm, setAuthForm] = useState({ email: '', password: '', name: '' })
  const [authError, setAuthError] = useState('')
  const [authBusy, setAuthBusy] = useState(false)
  const [syncStatus, setSyncStatus] = useState('idle')
  const [cloudError, setCloudError] = useState('')
  const syncTimeoutRef = useRef(null)
  const hasPushedInitialLocalRef = useRef(false)

  const [profileName, setProfileName] = useState('')
  const [profileSaving, setProfileSaving] = useState(false)

  const [theme, setTheme] = useState(() => {
    try {
      const v = localStorage.getItem('work_tracker_theme')
      return ['light', 'dark', 'glass-light', 'glass-dark'].includes(v) ? v : 'light'
    } catch { return 'light' }
  })
  // v18 glass appearance: Glass is a third mode with a light/dark flavor.
  // Standard light/dark keep their exact look; glass only adds data-glass="on".
  const isDarkAppearance = theme === 'dark' || theme === 'glass-dark'

  const [showForgot, setShowForgot] = useState(false)
  const [forgotEmail, setForgotEmail] = useState('')
  const [forgotSent, setForgotSent] = useState(false)
  const [forgotBusy, setForgotBusy] = useState(false)
  const [showRecovery, setShowRecovery] = useState(false)
  const [newPassword, setNewPassword] = useState('')
  const [recoveryBusy, setRecoveryBusy] = useState(false)
  const [recoveryError, setRecoveryError] = useState('')

  const [editingKey, setEditingKey] = useState(null)
  const [editingDate, setEditingDate] = useState(null)

  const [showHamburgerMenu, setShowHamburgerMenu] = useState(false)
  const [showThemeMenu, setShowThemeMenu] = useState(false) // v18: "Choose theme" inline picker in the hamburger menu
  const hamburgerMenuRef = useRef(null)

  const [showShareMenu, setShowShareMenu] = useState(false)
  const shareMenuRef = useRef(null)

  const [showYearShareMenu, setShowYearShareMenu] = useState(false)
  const yearShareMenuRef = useRef(null)

  const [showSplash, setShowSplash] = useState(true)
  const splashStartRef = useRef(Date.now())

  useEffect(() => {
    const glass = theme.startsWith('glass')
    document.documentElement.setAttribute('data-theme', glass ? theme.slice(6) : theme)
    document.documentElement.setAttribute('data-glass', glass ? 'on' : 'off')
    try { localStorage.setItem('work_tracker_theme', theme) } catch {}
  }, [theme])

  useEffect(() => {
    if (!loaded) return
    if (authLoading && isSupabaseConfigured) return
    const elapsed = Date.now() - splashStartRef.current
    const minDuration = 3000
    const remaining = Math.max(0, minDuration - elapsed)
    const t = setTimeout(() => setShowSplash(false), remaining)
    return () => clearTimeout(t)
  }, [loaded, authLoading])

  const [realCurrentDate, setRealCurrentDate] = useState(() => new Date())
  useEffect(() => {
    const updateReal = () => setRealCurrentDate(new Date())
    const onVis = () => { if (document.visibilityState === 'visible') updateReal() }
    document.addEventListener('visibilitychange', onVis)
    const iv = setInterval(updateReal, 60*1000)
    return () => { document.removeEventListener('visibilitychange', onVis); clearInterval(iv) }
  }, [])

  const year = currentDate.getFullYear()
  const month = currentDate.getMonth()
  const realYear = realCurrentDate.getFullYear()
  const realMonth = realCurrentDate.getMonth()

  // Fetch Nigerian public holidays from Nager.Date API (free, no key, exact dates)
  useEffect(() => {
    const yearsToFetch = new Set([year, realYear])
    // Also fetch next year if viewing Dec and real is Dec? For future months
    yearsToFetch.add(realYear + 1)
    yearsToFetch.add(year + 1)
    yearsToFetch.add(year - 1)

    const fetchHolidays = async () => {
      setHolidaysLoading(true)
      try {
        for (const y of yearsToFetch) {
          if (y < 2020 || y > 2030) continue
          // Skip if we already have holidays for this year
          const hasYear = Object.keys(holidaysMap).some(k => k.startsWith(`${y}-`))
          if (hasYear) continue
          try {
            const res = await fetch(`https://date.nager.at/api/v3/PublicHolidays/${y}/NG`)
            if (!res.ok) throw new Error('Failed')
            const data = await res.json()
            // data is array of {date: "2026-01-01", localName, name, ...}
            setHolidaysMap(prev => {
              const next = { ...prev }
              data.forEach(h => {
                next[h.date] = { name: h.name, localName: h.localName, date: h.date }
              })
              return next
            })
          } catch (e) {
            // Fallback to hardcoded if API fails
            const fallback = getNigerianHolidaysFallback(y)
            setHolidaysMap(prev => {
              const next = { ...prev }
              fallback.forEach(h => {
                const mm = String(h.month+1).padStart(2,'0')
                const dd = String(h.day).padStart(2,'0')
                const key = `${y}-${mm}-${dd}`
                if (!next[key]) next[key] = { name: h.name, localName: h.name, date: key }
              })
              return next
            })
          }
        }
      } finally {
        setHolidaysLoading(false)
      }
    }
    fetchHolidays()
  }, [year, realYear])

  // Helper to check if a date is holiday (API first, then fallback)
  function isHolidayDay(dateObj) {
    if (!dateObj) return null
    const key = formatDateKey(dateObj)
    if (holidaysMap[key]) return holidaysMap[key]
    return isHolidayDayFallback(dateObj)
  }

  useEffect(() => {
    if (!showHamburgerMenu) { setShowThemeMenu(false); return }
    const handleClickOutside = (e) => {
      if (hamburgerMenuRef.current && !hamburgerMenuRef.current.contains(e.target)) setShowHamburgerMenu(false)
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [showHamburgerMenu])

  useEffect(() => {
    const handleClickOutside = (e) => {
      if (shareMenuRef.current && !shareMenuRef.current.contains(e.target)) setShowShareMenu(false)
    }
    if (showShareMenu) {
      document.addEventListener('mousedown', handleClickOutside)
      return () => document.removeEventListener('mousedown', handleClickOutside)
    }
  }, [showShareMenu])

  useEffect(() => {
    const handleClickOutside = (e) => {
      if (yearShareMenuRef.current && !yearShareMenuRef.current.contains(e.target)) setShowYearShareMenu(false)
    }
    if (showYearShareMenu) {
      document.addEventListener('mousedown', handleClickOutside)
      return () => document.removeEventListener('mousedown', handleClickOutside)
    }
  }, [showYearShareMenu])

  // Draft copy of leave types while the Settings modal is open (applied on Save)
  useEffect(() => {
    if (showSettings) setLtDraft(leaveTypes.map(t => ({ ...t })))
  }, [showSettings]) // eslint-disable-line react-hooks/exhaustive-deps

  // Draft copy of rate periods while Settings is open — migrated on first open
  // (legacy single-rate settings become one period anchored on the earliest log)
  useEffect(() => {
    if (showSettings) {
      const s = { dailyRate: settings.dailyRate, weekendMultiplier: settings.weekendMultiplier, holidayMultiplier: settings.holidayMultiplier }
      const earliest = Object.keys(attendance).sort()[0]
      const now = new Date()
      const monthStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`
      setRateDraft(migratePeriods(settings.ratePeriods, s, earliest, monthStart))
      setRateForm(null)
      setSpFold({ pay: false, track: false })
    }
  }, [showSettings]) // eslint-disable-line react-hooks/exhaustive-deps

  // Collapse the "Log a future day" chips when navigating months
  useEffect(() => { setShowFutureDays(false) }, [year, month])

  // Load local
  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY)
      let loadedAttendance = {}
      if (raw) {
        const parsed = JSON.parse(raw)
        if (parsed.attendance) { loadedAttendance = parsed.attendance; setAttendance(parsed.attendance) }
        if (parsed.settings) {
          const ls = {
            dailyRate: parsed.settings.dailyRate ?? 16000,
            weekendMultiplier: parsed.settings.weekendMultiplier ?? 2,
            holidayMultiplier: parsed.settings.holidayMultiplier ?? 2,
            salaryGoal: parsed.settings.salaryGoal ?? 500000,
            paydayDay: parsed.settings.paydayDay ?? 0,
            startMonthKey: parsed.settings.startMonthKey
          }
          const earliest = Object.keys(parsed.attendance || {}).sort()[0]
          const now = new Date()
          ls.ratePeriods = migratePeriods(parsed.settings.ratePeriods, ls, earliest, `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`)
          const rt = rateForPeriod(ls.ratePeriods, formatDateKey(now), ls)
          ls.dailyRate = rt.dailyRate; ls.weekendMultiplier = rt.weekendMultiplier; ls.holidayMultiplier = rt.holidayMultiplier
          setSettings(ls)
          setGoalInput(String(parsed.settings.salaryGoal ?? 500000))
          setPaydayInput(String(parsed.settings.paydayDay ?? 0))
          if (parsed.settings.startMonthKey) {
            setStartMonthKey(parsed.settings.startMonthKey)
            localStorage.setItem(START_KEY, parsed.settings.startMonthKey)
          }
        }
      }
      const startRaw = localStorage.getItem(START_KEY)
      if (startRaw) setStartMonthKey(startRaw)
      else {
        let startKey
        const keys = Object.keys(loadedAttendance)
        if (keys.length > 0) {
          const monthKeys = keys.map(k => k.slice(0,7)).sort()
          startKey = monthKeys[0]
        } else {
          const now = new Date()
          startKey = monthKey(now.getFullYear(), now.getMonth())
        }
        localStorage.setItem(START_KEY, startKey)
        setStartMonthKey(startKey)
      }
    } catch {}
    setLoaded(true)
  }, [])

  useEffect(() => {
    if (!loaded) return
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ attendance, settings }))
      if (startMonthKey) localStorage.setItem(START_KEY, startMonthKey)
    } catch {}
  }, [attendance, settings, startMonthKey, loaded])

  // Auth init
  useEffect(() => {
    if (!isSupabaseConfigured || !supabase) { setAuthLoading(false); return }
    supabase.auth.getSession().then(({ data }) => {
      const u = data.session?.user ?? null
      setUser(u)
      if (u) setProfileName(u.user_metadata?.full_name || '')
      setAuthLoading(false)
    })
    const { data: listener } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === 'PASSWORD_RECOVERY') { setShowRecovery(true); setShowAuth(false) }
      const u = session?.user ?? null
      setUser(u)
      if (u) setProfileName(u.user_metadata?.full_name || '')
    })
    return () => listener.subscription.unsubscribe()
  }, [])

  // Fetch cloud
  useEffect(() => {
    if (!isSupabaseConfigured || !supabase) return
    if (!user) { setSyncStatus('idle'); return }
    const fetchCloud = async () => {
      setSyncStatus('syncing'); setCloudError('')
      try {
        const { data, error } = await supabase.from('user_data').select('attendance, settings').eq('user_id', user.id).single()
        if (error && error.code !== 'PGRST116') throw error
        if (data) {
          const cloudAttendance = data.attendance || {}
          const cloudSettings = data.settings || { dailyRate: 16000, weekendMultiplier: 2, holidayMultiplier: 2, salaryGoal: 500000, paydayDay: 0 }
          if (cloudSettings.startMonthKey && !startMonthKey) setStartMonthKey(cloudSettings.startMonthKey)
          const mergedAttendance = { ...cloudAttendance }
          let hasOfflineNew = false
          for (const k in attendance) { if (!mergedAttendance[k]) { mergedAttendance[k] = attendance[k]; hasOfflineNew = true } }
          setAttendance(mergedAttendance)
          const mergedSettings = { ...cloudSettings }
          if (startMonthKey && !mergedSettings.startMonthKey) mergedSettings.startMonthKey = startMonthKey
          if (mergedSettings.startMonthKey) setStartMonthKey(mergedSettings.startMonthKey)
          const cs = {
            dailyRate: mergedSettings.dailyRate ?? 16000,
            weekendMultiplier: mergedSettings.weekendMultiplier ?? 2,
            holidayMultiplier: mergedSettings.holidayMultiplier ?? 2,
            salaryGoal: mergedSettings.salaryGoal ?? 500000,
            paydayDay: mergedSettings.paydayDay ?? 0
          }
          const earliestCloud = Object.keys(mergedAttendance || {}).sort()[0]
          const nowCloud = new Date()
          cs.ratePeriods = migratePeriods(mergedSettings.ratePeriods, cs, earliestCloud, `${nowCloud.getFullYear()}-${String(nowCloud.getMonth() + 1).padStart(2, '0')}-01`)
          const rtc = rateForPeriod(cs.ratePeriods, formatDateKey(nowCloud), cs)
          cs.dailyRate = rtc.dailyRate; cs.weekendMultiplier = rtc.weekendMultiplier; cs.holidayMultiplier = rtc.holidayMultiplier
          setSettings(cs)
          setGoalInput(String(mergedSettings.salaryGoal ?? 500000))
          setPaydayInput(String(mergedSettings.paydayDay ?? 0))
          if (hasOfflineNew) {
            await supabase.from('user_data').upsert({
              user_id: user.id,
              attendance: mergedAttendance,
              settings: { ...mergedSettings, startMonthKey: mergedSettings.startMonthKey || startMonthKey },
              updated_at: new Date().toISOString(),
            })
          }
        } else {
          const settingsToSave = { ...settings, startMonthKey: startMonthKey || monthKey(new Date().getFullYear(), new Date().getMonth()) }
          await supabase.from('user_data').upsert({ user_id: user.id, attendance, settings: settingsToSave, updated_at: new Date().toISOString() })
          if (!startMonthKey) setStartMonthKey(settingsToSave.startMonthKey)
        }
        setSyncStatus('synced'); setTimeout(()=>setSyncStatus('idle'),2000)
      } catch (e) { setCloudError(e.message || 'Failed to load cloud data'); setSyncStatus('error') }
    }
    fetchCloud()
  }, [user])

  useEffect(() => {
    if (!loaded) return
    if (!isSupabaseConfigured || !supabase) return
    if (!user) return
    if (!hasPushedInitialLocalRef.current) { hasPushedInitialLocalRef.current = true; return }
    if (syncTimeoutRef.current) clearTimeout(syncTimeoutRef.current)
    setSyncStatus('syncing')
    syncTimeoutRef.current = setTimeout(async () => {
      try {
        const settingsToSave = { ...settings, startMonthKey }
        const { error } = await supabase.from('user_data').upsert({ user_id: user.id, attendance, settings: settingsToSave, updated_at: new Date().toISOString() })
        if (error) throw error
        setSyncStatus('synced'); setTimeout(()=>setSyncStatus('idle'),2000)
      } catch (e) { setCloudError(e.message || 'Sync failed'); setSyncStatus('error') }
    }, 800)
    return () => { if (syncTimeoutRef.current) clearTimeout(syncTimeoutRef.current) }
  }, [attendance, settings, startMonthKey, user, loaded])

  function getMonthStatus(y, m) {
    if (!startMonthKey) return 'active'
    const { year: sY, month: sM } = parseMonthKey(startMonthKey)
    const startTotal = sY*12 + sM
    const viewTotal = y*12 + m
    const realTotal = realYear*12 + realMonth
    if (viewTotal < startTotal) return 'before_start'
    if (viewTotal < realTotal) return 'locked'
    if (viewTotal === realTotal) return 'active'
    return 'future'
  }

  const monthStatus = getMonthStatus(year, month)
  const isEditable = monthStatus === 'active'

  const calendarData = useMemo(() => {
    const firstDay = new Date(year, month, 1)
    const lastDay = new Date(year, month + 1, 0)
    const daysInMonth = lastDay.getDate()
    const mondayOffset = (firstDay.getDay() + 6) % 7
    return { mondayOffset, daysInMonth }
  }, [year, month])

  // Month-so-far grid (v9): the active month shows only the 1st → today,
  // plus any days already logged ahead. Locked months stay complete.
  // Future / before-start months show no grid at all.
  const gridPrefix = `${year}-${String(month + 1).padStart(2, '0')}-`
  let maxLoggedDay = 0
  for (const k in attendance) if (k.startsWith(gridPrefix)) { const d = parseInt(k.slice(8), 10); if (d > maxLoggedDay) maxLoggedDay = d }
  const gridEndDay = monthStatus === 'active'
    ? Math.max(realCurrentDate.getDate(), maxLoggedDay)
    : calendarData.daysInMonth
  const calendarCells = useMemo(() => {
    const cells = []
    for (let i = 0; i < calendarData.mondayOffset; i++) cells.push(null)
    for (let d = 1; d <= gridEndDay; d++) cells.push(new Date(year, month, d))
    if (monthStatus !== 'active') {
      const remaining = cells.length % 7 === 0 ? 0 : 7 - (cells.length % 7)
      for (let i = 0; i < remaining; i++) cells.push(null)
    }
    return cells
  }, [calendarData, gridEndDay, monthStatus, year, month])
  const futureDays = monthStatus === 'active'
    ? Array.from({ length: Math.max(0, calendarData.daysInMonth - gridEndDay) }, (_, i) => gridEndDay + 1 + i)
    : []

  // ---- Leave types & absence (user-managed) ----
  const leaveTypes = Array.isArray(settings.leaveTypes) ? settings.leaveTypes : DEFAULT_LEAVE_TYPES
  const ltById = (id) => leaveTypes.find(t => t.id === id)
  const leavePayFor = (lt, rate) => !lt ? 0 : (lt.payMode === 'flat'
    ? Math.max(0, Number(lt.payValue) || 0)
    : Math.round((rate * Math.max(0, Number(lt.payValue) || 0)) / 100))
  const leaveLabel = (id) => ltById(id)?.name || 'Leave'

  const monthlyStats = useMemo(() => {
    const prefix = `${year}-${String(month + 1).padStart(2, '0')}-`
    let total = 0, days = 0, weekendDays = 0, regularDays = 0, overtimeDays = 0, holidayDays = 0, leaveDays = 0, leavePay = 0
    // v18: per-type stored-amount sums (records keep the amounts they were
    // logged with — never recomputed from current settings) + extra-over-base
    let regularPay = 0, weekendPay = 0, otPay = 0, holidayPay = 0
    let weekendExtra = 0, otExtra = 0, holidayExtra = 0
    const rAmt = new Set(), wAmt = new Set(), oAmt = new Set(), hAmt = new Set()
    const rates = new Set()
    for (const key in attendance) {
      if (key.startsWith(prefix)) {
        const rec = attendance[key]
        total += rec.amount
        if (rec.isLeave) { leaveDays += 1; leavePay += rec.amount }
        else {
          days += 1
          rates.add(rec.rate)
          if (rec.isWeekend) { weekendDays += 1; weekendPay += rec.amount; weekendExtra += rec.amount - (rec.rate || 0); wAmt.add(rec.amount) }
          else if (rec.isOvertime) { overtimeDays += 1; otPay += rec.amount; otExtra += rec.amount - (rec.rate || 0); oAmt.add(rec.amount) }
          else if (rec.isHoliday) { holidayDays += 1; holidayPay += rec.amount; holidayExtra += rec.amount - (rec.rate || 0); hAmt.add(rec.amount) }
          else { regularDays += 1; regularPay += rec.amount; rAmt.add(rec.amount) }
        }
      }
    }
    const one = s => (s.size === 1 ? [...s][0] : null)
    return { total, days, weekendDays, regularDays, overtimeDays, holidayDays, leaveDays, leavePay,
      regularPay, weekendPay, otPay, holidayPay, weekendExtra, otExtra, holidayExtra,
      regularAmt: one(rAmt), weekendAmt: one(wAmt), otAmt: one(oAmt), holidayAmt: one(hAmt), monthRate: one(rates) }
  }, [attendance, year, month])

  const yearlyStats = useMemo(() => {
    const prefix = `${year}-`
    let total = 0, days = 0, weekendDays = 0, overtimeDays = 0, holidayDays = 0, regularDays = 0, leaveDays = 0, leavePay = 0
    let regularPay = 0, weekendPay = 0, otPay = 0, holidayPay = 0
    const rAmt = new Set(), wAmt = new Set(), oAmt = new Set(), hAmt = new Set(), rates = new Set()
    const monthly = Array.from({ length: 12 }, (_, m) => ({ month: m, total: 0, days: 0, status: getMonthStatus(year, m) }))
    for (const key in attendance) {
      if (key.startsWith(prefix)) {
        const rec = attendance[key]
        const m = parseInt(key.slice(5, 7), 10) - 1
        if (m >=0 && m <12) { monthly[m].total += rec.amount; if (!rec.isLeave) monthly[m].days += 1 }
        total += rec.amount
        if (rec.isLeave) { leaveDays += 1; leavePay += rec.amount }
        else {
          days += 1
          rates.add(rec.rate)
          if (rec.isWeekend) { weekendDays += 1; weekendPay += rec.amount; wAmt.add(rec.amount) }
          else if (rec.isOvertime) { overtimeDays += 1; otPay += rec.amount; oAmt.add(rec.amount) }
          else if (rec.isHoliday) { holidayDays += 1; holidayPay += rec.amount; hAmt.add(rec.amount) }
          else { regularDays += 1; regularPay += rec.amount; rAmt.add(rec.amount) }
        }
      }
    }
    const one = s => (s.size === 1 ? [...s][0] : null)
    return { total, days, weekendDays, overtimeDays, holidayDays, regularDays, leaveDays, leavePay, monthly,
      regularPay, weekendPay, otPay, holidayPay,
      regularAmt: one(rAmt), weekendAmt: one(wAmt), otAmt: one(oAmt), holidayAmt: one(hAmt), yearRate: one(rates) }
  }, [attendance, year, realYear, realMonth, startMonthKey])

  const todayKey = formatDateKey(new Date())

  // v18 rate periods — the rate in force on a given day (falls back to
  // current settings while periods are not yet migrated/loaded)
  const rateForDate = (dateKey) => rateForPeriod(settings.ratePeriods, dateKey, settings)

  // Keep the "current" settings fields in sync with the period in force today
  // (a future-dated period becomes current the day it starts)
  useEffect(() => {
    if (!settings.ratePeriods || !settings.ratePeriods.length) return
    const r = rateForPeriod(settings.ratePeriods, todayKey, settings)
    if (r.dailyRate !== settings.dailyRate || r.weekendMultiplier !== settings.weekendMultiplier || r.holidayMultiplier !== settings.holidayMultiplier) {
      setSettings(s => ({ ...s, dailyRate: r.dailyRate, weekendMultiplier: r.weekendMultiplier, holidayMultiplier: r.holidayMultiplier }))
    }
  }, [settings.ratePeriods, todayKey]) // eslint-disable-line react-hooks/exhaustive-deps

  /* ============================================================
     DayPay motion layer — success feedback (VISUAL ONLY).
     Toasts and cell reactions fire exclusively from the confirmed
     save paths (the setAttendance commits in handleCellClick /
     handleOvertimeAction / chip logging). Never on raw clicks,
     never on load, never on failure. All amounts come from the
     app's existing calculations — nothing is hardcoded.
     ============================================================ */
  const [dpToast, setDpToast] = useState(null)
  const dpToastTimer = useRef(null)
  const [dpJust, setDpJust] = useState(null)
  const dpJustTimer = useRef(null)
  const [dpQuietSay, setDpQuietSay] = useState(null) // v19-A: SR-only announcement for quiet saves

  function dpShowToast(toast) {
    if (dpToastTimer.current) clearTimeout(dpToastTimer.current)
    setDpToast({ ...toast, id: Date.now() })
    dpToastTimer.current = setTimeout(() => setDpToast(null), toast.variant === 'month' ? 4000 : toast.variant === 'weekend' ? 3000 : 2600)
  }

  function dpCelebrateSave(key, kind, amount) {
    if (dpJustTimer.current) clearTimeout(dpJustTimer.current)
    setDpJust({ key, kind })
    dpJustTimer.current = setTimeout(() => setDpJust(null), 1700)
    if (kind === 'weekend') dpShowToast({ variant: 'weekend', title: 'Weekend OT!', sub: `${formatNaira(amount)} added` })
    else if (kind === 'ot') dpShowToast({ variant: 'ot', title: 'OT recorded', sub: `${formatNaira(amount)} added` })
    else if (kind === 'holiday') dpShowToast({ variant: 'holiday', title: 'Holiday OT', sub: `${formatNaira(amount)} added` })
    // v19-A quiet workdays: plain work and leave saves pop the cell only — no card.
    // Screen-reader parity: a visually-hidden live region still says what happened.
    else setDpQuietSay({ id: Date.now(), text: kind === 'leave' ? 'Leave recorded' : 'Work recorded' })
  }

  /* Month / year completion — recognizes an EXISTING event only:
     the most recent month (and year) that completed since the last
     visit. Pure read of attendance; locking logic untouched. One-time
     via localStorage flags; waits for cloud sync to settle so it never
     celebrates on unconfirmed data; fires only shortly after open. */
  const dpSyncSettled = useRef(false)
  useEffect(() => { if (syncStatus === 'synced' || syncStatus === 'error') dpSyncSettled.current = true }, [syncStatus])
  const dpMilestoneWindow = useRef(0)
  useEffect(() => {
    if (!loaded || showSplash || authLoading) return
    if (isSupabaseConfigured && user && !dpSyncSettled.current) return
    if (!dpMilestoneWindow.current) dpMilestoneWindow.current = Date.now()
    if (Date.now() - dpMilestoneWindow.current > 8000) return
    try {
      const now = realCurrentDate
      const prevYear = now.getFullYear() - 1
      if (String(prevYear) !== localStorage.getItem('dp_motion_year')) {
        const yTotal = Object.keys(attendance).filter(k => k.startsWith(prevYear + '-')).reduce((s, k) => s + attendance[k].amount, 0)
        localStorage.setItem('dp_motion_year', String(prevYear))
        if (yTotal > 0) {
          dpShowToast({ variant: 'year', title: `${prevYear} Complete`, sub: `${formatNaira(yTotal)} earned` })
          return
        }
      }
      const pm = new Date(now.getFullYear(), now.getMonth() - 1, 1)
      const mk = `${pm.getFullYear()}-${String(pm.getMonth() + 1).padStart(2, '0')}`
      if (mk !== localStorage.getItem('dp_motion_month')) {
        const recs = Object.entries(attendance).filter(([k]) => k.startsWith(mk + '-')).map(([, r]) => r)
        const mTotal = recs.reduce((s, r) => s + (r.amount || 0), 0)
        localStorage.setItem('dp_motion_month', mk)
        if (mTotal > 0) {
          // v19-B: first-of-month recap — the finished month, said in full
          const otDays = recs.filter(r => r.isOvertime).length
          const leaveDays = recs.filter(r => r.isLeave).length
          const segs = [`${recs.length} day${recs.length !== 1 ? 's' : ''}`]
          if (otDays > 0) segs.push(`${otDays} OT`)
          if (leaveDays > 0) segs.push(`${leaveDays} on leave`)
          dpShowToast({ variant: 'month', title: `${getMonthName(now.getMonth())} begins`, sub: `${getMonthName(pm.getMonth())}: ${formatNaira(mTotal)} · ${segs.join(' · ')}` })
        }
      }
    } catch {}
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded, showSplash, authLoading, syncStatus, attendance])

  /* v19-C: backup nudge — one quiet banner when real data lives only on this
     device. Never when signed in / synced; never nags (once, ever); waits its
     turn behind the recap card. Fix is smart: sign in when sync is configured,
     one-tap JSON export when it isn't. */
  const [dpBackupNudge, setDpBackupNudge] = useState(false)
  const dpBackupShownRef = useRef(false)
  useEffect(() => {
    if (dpBackupShownRef.current) return
    if (!loaded || showSplash || authLoading) return
    if (dpToast) return // one voice at a time — the recap card goes first
    if (isSupabaseConfigured && user) return // signed in = backed up
    if (isSupabaseConfigured && syncStatus === 'syncing') return // sync may satisfy it
    try { if (localStorage.getItem('dp_backup_nudge') === 'done') return } catch {}
    if (Object.keys(attendance).length < 7) return // not real data at risk yet
    const t = setTimeout(() => {
      dpBackupShownRef.current = true
      try { localStorage.setItem('dp_backup_nudge', 'done') } catch {}
      setDpBackupNudge(true)
    }, 1200)
    return () => clearTimeout(t)
  }, [loaded, showSplash, authLoading, dpToast, user, syncStatus, attendance, isSupabaseConfigured]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!dpBackupNudge) return
    if ((isSupabaseConfigured && user) || showSettings || showAuth) { setDpBackupNudge(false); return }
    const t = setTimeout(() => setDpBackupNudge(false), 5500)
    return () => clearTimeout(t)
  }, [dpBackupNudge, user, showSettings, showAuth, isSupabaseConfigured]) // eslint-disable-line react-hooks/exhaustive-deps

  function handleCellClick(dateObj) {
    if (!dateObj) return
    if (!isEditable) return
    const key = formatDateKey(dateObj)
    const record = attendance[key]
    const isWeekend = isWeekendDay(dateObj)
    const holiday = isHolidayDay(dateObj)

    if (isWeekend) {
      const r = rateForDate(key)
      const wasRecorded = !!attendance[key]
      const wkndAmount = r.dailyRate * r.weekendMultiplier
      setAttendance(prev => {
        const next = { ...prev }
        if (next[key]) delete next[key]
        else {
          const amount = r.dailyRate * r.weekendMultiplier
          next[key] = { date: key, amount, isWeekend: true, isOvertime: false, isHoliday: false, rate: r.dailyRate, multiplier: r.weekendMultiplier }
        }
        return next
      })
      // committed (local-first save) → celebrate the confirmed weekend OT
      if (!wasRecorded) dpCelebrateSave(key, 'weekend', wkndAmount)
    } else if (holiday) {
      // Holiday - toggle with holiday rate
      const r = rateForDate(key)
      const wasHolRecorded = !!attendance[key]
      const holAmount = r.dailyRate * r.holidayMultiplier
      setAttendance(prev => {
        const next = { ...prev }
        if (next[key]) delete next[key]
        else {
          const amount = r.dailyRate * r.holidayMultiplier
          next[key] = { date: key, amount, isWeekend: false, isOvertime: false, isHoliday: true, holidayName: holiday.name, rate: r.dailyRate, multiplier: r.holidayMultiplier }
        }
        return next
      })
      if (!wasHolRecorded) dpCelebrateSave(key, 'holiday', holAmount)
    } else {
      if (!record) {
        const r = rateForDate(key)
        setAttendance(prev => ({
          ...prev,
          [key]: { date: key, amount: r.dailyRate, isWeekend: false, isOvertime: false, isHoliday: false, rate: r.dailyRate, multiplier: 1 }
        }))
        dpCelebrateSave(key, 'work', r.dailyRate)
      } else {
        setEditingKey(key)
        setEditingDate(dateObj)
      }
    }
  }

  function handleEditButtonClick(e, dateObj) {
    e.stopPropagation()
    if (!isEditable) return
    const key = formatDateKey(dateObj)
    setEditingKey(key)
    setEditingDate(dateObj)
  }

  function handleOvertimeAction(action) {
    if (!editingKey) return
    const key = editingKey
    if (action === 'remove') {
      setAttendance(prev => { const next = { ...prev }; delete next[key]; return next })
    } else if (action === 'regular') {
      const r = rateForDate(key)
      setAttendance(prev => {
        const rec = prev[key]
        if (!rec) return prev
        return { ...prev, [key]: { ...rec, isOvertime: false, isWeekend: false, isHoliday: false, isLeave: false, leaveType: undefined, amount: r.dailyRate, multiplier: 1, holidayName: undefined } }
      })
    } else if (action === 'overtime') {
      const r = rateForDate(key)
      const oldRec = attendance[key]
      setAttendance(prev => {
        const rec = prev[key]
        if (!rec) return prev
        const mult = r.weekendMultiplier
        return { ...prev, [key]: { ...rec, isOvertime: true, isWeekend: false, isHoliday: false, isLeave: false, leaveType: undefined, amount: r.dailyRate * mult, multiplier: mult, holidayName: undefined } }
      })
      // committed → enhanced confirmation with the actual increase
      if (oldRec && !oldRec.isOvertime) {
        const otDelta = r.dailyRate * r.weekendMultiplier - oldRec.amount
        if (otDelta > 0) dpCelebrateSave(key, 'ot', otDelta)
      }
    } else if (action === 'holiday') {
      const r = rateForDate(key)
      const oldHol = attendance[key]
      setAttendance(prev => {
        const rec = prev[key]
        if (!rec) return prev
        const mult = r.holidayMultiplier
        return { ...prev, [key]: { ...rec, isHoliday: true, isWeekend: false, isOvertime: false, isLeave: false, leaveType: undefined, amount: r.dailyRate * mult, multiplier: mult } }
      })
      if (oldHol && !oldHol.isHoliday) {
        const holDelta = r.dailyRate * r.holidayMultiplier - oldHol.amount
        if (holDelta > 0) dpCelebrateSave(key, 'holiday', holDelta)
      }
    } else if (action.startsWith('leave-')) {
      const r = rateForDate(key)
      const leaveType = action.slice(6)
      const lt = ltById(leaveType)
      const lvAmount = leavePayFor(lt, r.dailyRate)
      setAttendance(prev => {
        const rec = prev[key]
        if (!rec) return prev
        const amount = leavePayFor(lt, r.dailyRate)
        return { ...prev, [key]: { ...rec, isOvertime: false, isWeekend: false, isHoliday: false, holidayName: undefined, isLeave: true, leaveType, amount, multiplier: r.dailyRate > 0 ? Math.round((amount / r.dailyRate) * 100) / 100 : 0 } }
      })
      // v19-A: leave saves get the same quiet cell pop as plain workdays
      dpCelebrateSave(key, 'leave', lvAmount)
    }
    setEditingKey(null)
    setEditingDate(null)
  }

  function handleExportJson() {
    triggerDownload(`DayPay-backup-${fileDateStamp()}.json`, buildDayPayBackup(attendance, settings, leaveTypes), 'application/json')
  }
  function handleExportCsv() {
    triggerDownload(`DayPay-earnings-${fileDateStamp()}.csv`, buildDayPayCsv(attendance), 'text/csv')
  }

  function goPrevMonth(){
    const newDate = new Date(year, month-1,1)
    if (startMonthKey && newDate.getFullYear()*12 + newDate.getMonth() < parseMonthKey(startMonthKey).year*12 + parseMonthKey(startMonthKey).month) return
    setCurrentDate(newDate)
  }
  function goNextMonth(){ setCurrentDate(new Date(year, month+1,1)) }
  function goPrevYear(){
    const newYear = year - 1
    if (startMonthKey && newYear < parseMonthKey(startMonthKey).year) return
    setCurrentDate(new Date(newYear, month,1))
  }
  function goNextYear(){ setCurrentDate(new Date(year+1, month,1)) }
  function openMonth(mIdx){
    if (startMonthKey) {
      const { year: sY, month: sM } = parseMonthKey(startMonthKey)
      if (year === sY && mIdx < sM) return
      if (year < sY) return
    }
    setCurrentDate(new Date(year, mIdx,1)); setView('month')
  }
  function goToCurrentMonth(){ setCurrentDate(new Date(realYear, realMonth, 1)); setView('month') }

  function updateLtDraft(i, patch) { setLtDraft(d => (d || []).map((t, idx) => idx === i ? { ...t, ...patch } : t)) }
  function removeLtDraft(i) { setLtDraft(d => (d || []).filter((_, idx) => idx !== i)) }
  function addLtDraft() { setLtDraft(d => [...(d || []), { id: `lt_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, name: '', payMode: 'percent', payValue: 100 }]) }

  // v18 rate-history draft actions (apply on Save, like leave types)
  function rateFormValid(){
    if (!rateForm) return false
    const num = parseInt(rateForm.rate.replace(/[^0-9]/g,''), 10)
    if (!num || num <= 0) return false
    if (!/^\d{4}-\d{2}-\d{2}$/.test(rateForm.from)) return false
    const first = (rateDraft || [])[0]
    if (first && rateForm.from <= first.from) return false
    return true
  }
  function applyRateForm(){
    if (!rateFormValid()) return
    const from = rateForm.from
    const num = parseInt(rateForm.rate.replace(/[^0-9]/g,''), 10)
    setRateDraft(prev => {
      const base = (prev || []).filter(p => p.from !== from)
      const prevP = base.length ? base[base.length - 1]
        : { weekendMultiplier: settings.weekendMultiplier, holidayMultiplier: settings.holidayMultiplier }
      return sortPeriods([...base, { from, dailyRate: num, weekendMultiplier: prevP.weekendMultiplier ?? 2, holidayMultiplier: prevP.holidayMultiplier ?? 2 }])
    })
    setRateForm(null)
  }
  function removeRateDraft(i){
    setRateDraft(prev => (prev || []).filter((_, idx) => idx !== i))
  }

  function handleSaveRate(){
    const goalCleaned = goalInput.replace(/[^0-9]/g,'')
    const goalNum = parseInt(goalCleaned,10) || 0
    const paydayCleaned = paydayInput.replace(/[^0-9]/g,'')
    let paydayNum = parseInt(paydayCleaned,10)
    if (isNaN(paydayNum)) paydayNum = 0
    paydayNum = Math.max(0, Math.min(31, paydayNum))
    const cleanedTypes = (ltDraft || [])
      .map(t => ({ id: t.id, name: (t.name || '').trim().slice(0, 40), payMode: t.payMode === 'flat' ? 'flat' : 'percent', payValue: Math.max(0, Number(t.payValue) || 0) }))
      .filter(t => t.name)
    const periods = (rateDraft && rateDraft.length) ? rateDraft : settings.ratePeriods
    const rNow = rateForPeriod(periods, todayKey, settings)
    setSettings(s=>({...s, ratePeriods: periods, dailyRate: rNow.dailyRate, weekendMultiplier: rNow.weekendMultiplier, holidayMultiplier: rNow.holidayMultiplier, salaryGoal: goalNum, paydayDay: paydayNum, ...(ltDraft ? { leaveTypes: cleanedTypes } : {})}))
    setRateForm(null)
    setGoalInput(String(goalNum))
    setPaydayInput(String(paydayNum))
    setShowSettings(false)
  }

  async function handleSaveProfileName(){
    if (!supabase || !user) return
    if (!profileName.trim()) return
    setProfileSaving(true)
    try {
      const { data, error } = await supabase.auth.updateUser({ data: { full_name: profileName.trim() } })
      if (error) throw error
      if (data.user) setUser(data.user)
    } catch (e) { setCloudError(e.message) } finally { setProfileSaving(false) }
  }

  async function handleAuthSubmit(e){
    e.preventDefault()
    if(!supabase) return
    setAuthBusy(true); setAuthError('')
    try{
      if(authMode==='signup'){
        const { data, error } = await supabase.auth.signUp({
          email: authForm.email, password: authForm.password,
          options: { data: { full_name: authForm.name.trim() || authForm.email.split('@')[0] } }
        })
        if(error) throw error
        if(data.user) {
          setUser(data.user)
          setProfileName(data.user.user_metadata?.full_name || authForm.name)
          setShowAuth(false)
          setAuthForm({email:'',password:'', name:''})
          if (!startMonthKey) setStartMonthKey(monthKey(new Date().getFullYear(), new Date().getMonth()))
        }
      } else {
        const { data, error } = await supabase.auth.signInWithPassword({ email: authForm.email, password: authForm.password })
        if(error) throw error
        setUser(data.user)
        setProfileName(data.user.user_metadata?.full_name || '')
        setShowAuth(false)
        setAuthForm({email:'',password:'', name:''})
      }
    } catch(err){ setAuthError(err.message || 'Authentication failed') } finally{ setAuthBusy(false) }
  }

  async function handleLogout(){
    if(!supabase) return
    await supabase.auth.signOut()
    setUser(null)
    setSyncStatus('idle')
    hasPushedInitialLocalRef.current = false
  }

  async function handleForgotPassword(e){
    e.preventDefault()
    if(!supabase) return
    setForgotBusy(true); setAuthError('')
    try{
      const { error } = await supabase.auth.resetPasswordForEmail(forgotEmail, { redirectTo: window.location.origin })
      if(error) throw error
      setForgotSent(true)
    } catch(err){ setAuthError(err.message || 'Failed to send reset email') } finally{ setForgotBusy(false) }
  }

  async function handleRecoverySubmit(e){
    e.preventDefault()
    if(!supabase) return
    setRecoveryBusy(true); setRecoveryError('')
    try{
      const { error } = await supabase.auth.updateUser({ password: newPassword })
      if(error) throw error
      setShowRecovery(false); setNewPassword('')
    } catch(err){ setRecoveryError(err.message || 'Failed to update password') } finally{ setRecoveryBusy(false) }
  }

  function payslipFilename() {
    return `DayPay_Payslip_${getMonthName(month)}_${year}_${displayName || 'Employee'}.pdf`
  }

  function generatePayslipDoc() {
    const doc = new jsPDF()
    const pageW = doc.internal.pageSize.getWidth()
    
    // DayPay branding
    doc.setFillColor(11,27,50) // Navy #0B1B32
    doc.rect(0,0,pageW,28,'F')
    doc.setFont('helvetica','bold')
    doc.setFontSize(18)
    doc.setTextColor(255,255,255)
    // Brand mark: refined stacked squares
    doc.setFillColor(22,163,74)
    doc.roundedRect(18, 10.5, 16, 16, 4, 4, 'F')
    doc.setFillColor(255,255,255)
    doc.roundedRect(14, 6.5, 16, 16, 4, 4, 'F')
    doc.text('DayPay', 37, 18)
    doc.setFontSize(10)
    doc.setTextColor(21,128,61) // Green
    doc.text('Know what your work is worth.', 62, 18)
    doc.setFontSize(9)
    doc.setTextColor(255,255,255)
    doc.text(`${getMonthName(month)} ${year} Payslip`, pageW-14, 18, { align: 'right' })

    // Employee info
    doc.setTextColor(11,27,50)
    doc.setFontSize(14)
    doc.setFont('helvetica','bold')
    doc.text(displayName || 'Employee', 14, 40)
    doc.setFontSize(10)
    doc.setFont('helvetica','normal')
    doc.setTextColor(100,100,100)
    doc.text(user?.email || 'Local user', 14, 46)
    doc.text(`Daily Rate: ${monthlyStats.days > 0 ? (monthlyStats.monthRate != null ? formatNaira(monthlyStats.monthRate) : 'mixed (rate history)') : formatNaira(rateForDate(`${year}-${String(month + 1).padStart(2, '0')}-01`).dailyRate)} | Weekend/OT/Holiday: ${rateForDate(`${year}-${String(month + 1).padStart(2, '0')}-01`).weekendMultiplier}×`, 14, 52)
    doc.text(`Period: ${getMonthName(month)} ${year} | Status: ${monthStatus.toUpperCase()} ${monthStatus==='locked' ? '(FINAL)' : '(IN PROGRESS)'}`, 14, 58)

    // Summary
    doc.setFont('helvetica','bold')
    doc.setTextColor(11,27,50)
    doc.setFontSize(12)
    doc.text('Salary Summary', 14, 70)
    doc.setFontSize(22)
    doc.setTextColor(21,128,61)
    doc.text(formatNaira(monthlyStats.total), 14, 80)
    doc.setFontSize(10)
    doc.setTextColor(100,100,100)
    doc.setFont('helvetica','normal')
    doc.text(`${monthlyStats.days} days worked · ${monthlyStats.regularDays} regular · ${monthlyStats.weekendDays} weekend · ${monthlyStats.overtimeDays} OT · ${monthlyStats.holidayDays} holiday · ${monthlyStats.leaveDays} leave`, 14, 86)

    // Breakdown
    let y = 96
    doc.setFont('helvetica','bold')
    doc.setTextColor(11,27,50)
    doc.setFontSize(11)
    doc.text('Breakdown', 14, y)
    y+=6
    doc.setFont('helvetica','normal')
    doc.setFontSize(10)
    const pdfRow = (label, n, pay, amt) => [label, `${n} days`, (amt && n > 0 && n * amt === pay) ? `${n} × ${formatNaira(amt)}` : (n > 0 ? 'mixed rates' : '—'), formatNaira(pay)]
    const rows = [
      pdfRow('Regular', monthlyStats.regularDays, monthlyStats.regularPay, monthlyStats.regularAmt),
      pdfRow('Weekend 2×', monthlyStats.weekendDays, monthlyStats.weekendPay, monthlyStats.weekendAmt),
      pdfRow('Overtime OT 2×', monthlyStats.overtimeDays, monthlyStats.otPay, monthlyStats.otAmt),
      pdfRow('Holiday 2×', monthlyStats.holidayDays, monthlyStats.holidayPay, monthlyStats.holidayAmt),
      ['Leave', `${monthlyStats.leaveDays} days`, 'per your leave settings', formatNaira(monthlyStats.leavePay)],
    ]
    rows.forEach(r => {
      doc.text(r[0], 14, y)
      doc.text(r[1], 50, y)
      doc.text(r[2], 80, y)
      doc.text(r[3], 150, y)
      y+=6
    })
    y+=4
    doc.setFont('helvetica','bold')
    doc.text(`Final Salary for ${getMonthName(month)} ${year}: ${formatNaira(monthlyStats.total)}`, 14, y)
    y+=10

    // Attendance list
    doc.setFontSize(11)
    doc.text('Attendance Details', 14, y)
    y+=6
    doc.setFontSize(9)
    doc.setFont('helvetica','normal')
    doc.setTextColor(80,80,80)
    // Table header
    doc.text('Date', 14, y)
    doc.text('Day', 35, y)
    doc.text('Type', 65, y)
    doc.text('Rate', 95, y)
    doc.text('Amount', 130, y)
    y+=4
    doc.setDrawColor(200,200,200)
    doc.line(14, y, pageW-14, y)
    y+=6

    const prefix = `${year}-${String(month + 1).padStart(2, '0')}-`
    const entries = Object.keys(attendance).filter(k=>k.startsWith(prefix)).sort().map(k=>attendance[k])
    entries.forEach(rec => {
      if (y > 280) { doc.addPage(); y = 20 }
      const d = new Date(rec.date)
      const dayName = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][d.getDay()]
      const type = rec.isLeave ? leaveLabel(rec.leaveType) : rec.isWeekend ? 'Weekend 2×' : rec.isOvertime ? 'Overtime OT' : rec.isHoliday ? `Holiday ${rec.holidayName ? `(${rec.holidayName})` : ''}` : 'Regular'
      doc.text(rec.date, 14, y)
      doc.text(dayName, 35, y)
      doc.text(type, 65, y)
      doc.text(formatNaira(rec.rate), 95, y)
      doc.setTextColor(21,128,61)
      doc.setFont('helvetica','bold')
      doc.text(formatNaira(rec.amount), 130, y)
      doc.setFont('helvetica','normal')
      doc.setTextColor(80,80,80)
      y+=6
    })

    // Footer
    doc.setFontSize(8)
    doc.setTextColor(150,150,150)
    doc.text(`DayPay — Know what your work is worth. Generated ${new Date().toLocaleString()} · ${displayName || 'Employee'} · ${startMonthKey ? `Started ${startMonthKey}` : ''}`, 14, 290)
    doc.text(`© 2026 Akaninyene. All rights reserved.`, 14, 294)

    return doc
  }

  function exportPayslip() {
    const doc = generatePayslipDoc()
    doc.save(payslipFilename())
  }

  function buildPayslipText() {
    const lines = [
      `📊 DayPay Payslip — ${getMonthName(month)} ${year}`,
      ``,
      `Total: ${formatNaira(monthlyStats.total)}`,
      `${monthlyStats.days} days worked · ${monthlyStats.regularDays} regular · ${monthlyStats.weekendDays} weekend · ${monthlyStats.overtimeDays} OT · ${monthlyStats.holidayDays} holiday · ${monthlyStats.leaveDays} leave`,
    ]
    if (monthlyStats.regularDays > 0) lines.push(`Regular: ${rateLine(monthlyStats.regularDays, monthlyStats.regularPay, monthlyStats.regularAmt)}`)
    if (monthlyStats.weekendDays > 0) lines.push(`Weekend 2×: ${rateLine(monthlyStats.weekendDays, monthlyStats.weekendPay, monthlyStats.weekendAmt)}`)
    if (monthlyStats.overtimeDays > 0) lines.push(`Overtime: ${rateLine(monthlyStats.overtimeDays, monthlyStats.otPay, monthlyStats.otAmt)}`)
    if (monthlyStats.holidayDays > 0) lines.push(`Holiday 2×: ${rateLine(monthlyStats.holidayDays, monthlyStats.holidayPay, monthlyStats.holidayAmt)}`)
    if (monthlyStats.leaveDays > 0) lines.push(`Leave: ${monthlyStats.leaveDays} day${monthlyStats.leaveDays > 1 ? 's' : ''} · ${formatNaira(monthlyStats.leavePay)}`)
    lines.push(``, `— DayPay · Know what your work is worth.`)
    return lines.join('\n')
  }

  async function shareToWhatsApp() {
    setShowShareMenu(false)
    // Best path: share the actual PDF file via the native share sheet (user picks WhatsApp).
    // Must stay in the same user-gesture task — jsPDF generation is synchronous, so it is.
    try {
      const doc = generatePayslipDoc()
      const file = new File([doc.output('blob')], payslipFilename(), { type: 'application/pdf' })
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share({
          files: [file],
          text: `DayPay Payslip — ${getMonthName(month)} ${year}: ${formatNaira(monthlyStats.total)} · ${monthlyStats.days} days worked`,
          title: 'DayPay Payslip',
        })
        return
      }
    } catch (err) {
      if (err && err.name === 'AbortError') return // user closed the share sheet — not an error
      // any other failure → fall through to the text fallback
    }
    // Fallback: WhatsApp text summary via wa.me — works on any phone/browser, no file support needed
    window.open(`https://wa.me/?text=${encodeURIComponent(buildPayslipText())}`, '_blank', 'noopener')
  }

  function yearlySummaryFilename() {
    return `DayPay_Yearly_Summary_${year}_${displayName || 'Employee'}.pdf`
  }

  function getYearMonthsForShare() {
    // Same month list the yearly card shows (respects the tracking start month)
    if (!startMonthKey) return yearlyStats.monthly
    const { year: sY, month: sM } = parseMonthKey(startMonthKey)
    if (year < sY) return []
    if (year === sY) return yearlyStats.monthly.filter(m => m.month >= sM)
    return yearlyStats.monthly
  }

  function generateYearlyDoc() {
    const doc = new jsPDF()
    const pageW = doc.internal.pageSize.getWidth()

    // DayPay branding
    doc.setFillColor(11,27,50) // Navy #0B1B32
    doc.rect(0,0,pageW,28,'F')
    doc.setFont('helvetica','bold')
    doc.setFontSize(18)
    doc.setTextColor(255,255,255)
    // Brand mark: refined stacked squares
    doc.setFillColor(22,163,74)
    doc.roundedRect(18, 10.5, 16, 16, 4, 4, 'F')
    doc.setFillColor(255,255,255)
    doc.roundedRect(14, 6.5, 16, 16, 4, 4, 'F')
    doc.text('DayPay', 37, 18)
    doc.setFontSize(10)
    doc.setTextColor(21,128,61) // Green
    doc.text('Know what your work is worth.', 62, 18)
    doc.setFontSize(9)
    doc.setTextColor(255,255,255)
    doc.text(`Yearly Summary ${year}`, pageW-14, 18, { align: 'right' })

    // Employee info
    doc.setTextColor(11,27,50)
    doc.setFontSize(14)
    doc.setFont('helvetica','bold')
    doc.text(displayName || 'Employee', 14, 40)
    doc.setFontSize(10)
    doc.setFont('helvetica','normal')
    doc.setTextColor(100,100,100)
    doc.text(user?.email || 'Local user', 14, 46)
    doc.text(`Daily Rate: ${yearlyStats.days > 0 ? (yearlyStats.yearRate != null ? formatNaira(yearlyStats.yearRate) : 'mixed (rate history)') : formatNaira(rateForDate(`${year}-01-01`).dailyRate)} | Weekend/OT: ${rateForDate(`${year}-01-01`).weekendMultiplier}× | Holiday: ${rateForDate(`${year}-01-01`).holidayMultiplier}×`, 14, 52)
    const yearStatus = year === realYear ? 'IN PROGRESS' : 'FINAL'
    doc.text(`Period: January – December ${year} | Status: ${yearStatus}`, 14, 58)

    // Summary
    doc.setFont('helvetica','bold')
    doc.setTextColor(11,27,50)
    doc.setFontSize(12)
    doc.text('Yearly Summary', 14, 70)
    doc.setFontSize(22)
    doc.setTextColor(21,128,61)
    doc.text(formatNaira(yearlyStats.total), 14, 80)
    doc.setFontSize(10)
    doc.setTextColor(100,100,100)
    doc.setFont('helvetica','normal')
    doc.text(`${yearlyStats.days} days worked · ${yearlyStats.regularDays} regular · ${yearlyStats.weekendDays} weekend · ${yearlyStats.overtimeDays} OT · ${yearlyStats.holidayDays} holiday · ${yearlyStats.leaveDays} leave`, 14, 86)

    // Breakdown
    let y = 96
    doc.setFont('helvetica','bold')
    doc.setTextColor(11,27,50)
    doc.setFontSize(11)
    doc.text('Breakdown', 14, y)
    y += 6
    doc.setFont('helvetica','normal')
    doc.setFontSize(10)
    const ypdfRow = (label, n, pay, amt) => [label, `${n} days`, (amt && n > 0 && n * amt === pay) ? `${n} × ${formatNaira(amt)}` : (n > 0 ? 'mixed rates' : '—'), formatNaira(pay)]
    const yrows = [
      ypdfRow('Regular', yearlyStats.regularDays, yearlyStats.regularPay, yearlyStats.regularAmt),
      ypdfRow('Weekend 2×', yearlyStats.weekendDays, yearlyStats.weekendPay, yearlyStats.weekendAmt),
      ypdfRow('Overtime OT 2×', yearlyStats.overtimeDays, yearlyStats.otPay, yearlyStats.otAmt),
      ypdfRow('Holiday 2×', yearlyStats.holidayDays, yearlyStats.holidayPay, yearlyStats.holidayAmt),
      ['Leave', `${yearlyStats.leaveDays} days`, 'per your leave settings', formatNaira(yearlyStats.leavePay)],
    ]
    yrows.forEach(r => {
      doc.text(r[0], 14, y)
      doc.text(r[1], 50, y)
      doc.text(r[2], 80, y)
      doc.text(r[3], 150, y)
      y += 6
    })
    y += 4
    doc.setFont('helvetica','bold')
    doc.text(`Total for ${year}: ${formatNaira(yearlyStats.total)}`, 14, y)
    if (settings.salaryGoal > 0) {
      y += 6
      doc.setFont('helvetica','normal')
      doc.setTextColor(100,100,100)
      doc.text(`Yearly goal: ${formatNaira(settings.salaryGoal * 12)} · ${goalProgressYear}% reached`, 14, y)
    }
    y += 12

    // Monthly breakdown
    doc.setFont('helvetica','bold')
    doc.setTextColor(11,27,50)
    doc.setFontSize(11)
    doc.text(`Monthly Breakdown — ${year}`, 14, y)
    y += 6
    doc.setFont('helvetica','normal')
    doc.setFontSize(9)
    doc.setTextColor(80,80,80)
    doc.text('Month', 14, y)
    doc.text('Days', 80, y)
    doc.text('Amount', 130, y)
    y += 4
    doc.setDrawColor(200,200,200)
    doc.line(14, y, pageW-14, y)
    y += 6
    const months = getYearMonthsForShare().filter(m => m.days > 0 || m.total > 0)
    const best = months.reduce((a, m) => (m.total > (a ? a.total : -1) ? m : a), null)
    months.forEach(m => {
      const isBest = best && m.month === best.month && m.total > 0 && months.length > 1
      doc.text(getMonthName(m.month), 14, y)
      doc.text(`${m.days}d`, 80, y)
      if (isBest) { doc.setFont('helvetica','bold'); doc.setTextColor(21,128,61) }
      doc.text(m.total > 0 ? formatNaira(m.total) : '₦0', 130, y)
      if (isBest) { doc.setFont('helvetica','normal'); doc.setTextColor(80,80,80) }
      y += 6
    })
    y += 2
    doc.setFont('helvetica','bold')
    doc.setTextColor(11,27,50)
    doc.text(`Total ${year}`, 14, y)
    doc.setTextColor(21,128,61)
    doc.text(formatNaira(yearlyStats.total), 130, y)

    // Footer
    doc.setFontSize(8)
    doc.setTextColor(150,150,150)
    doc.text(`DayPay — Know what your work is worth. Generated ${new Date().toLocaleString()} · ${displayName || 'Employee'} · ${startMonthKey ? `Started ${startMonthKey}` : ''}`, 14, 290)
    doc.text(`© 2026 Akaninyene. All rights reserved.`, 14, 294)

    return doc
  }

  function exportYearlySummary() {
    const doc = generateYearlyDoc()
    doc.save(yearlySummaryFilename())
  }

  function buildYearlyText() {
    const months = getYearMonthsForShare().filter(m => m.days > 0 || m.total > 0)
    const best = months.reduce((a, m) => (m.total > (a ? a.total : -1) ? m : a), null)
    const lines = [
      `📊 DayPay Yearly Summary — ${year}`,
      ``,
      `Total: ${formatNaira(yearlyStats.total)}`,
      `${yearlyStats.days} days worked · ${yearlyStats.regularDays} regular · ${yearlyStats.weekendDays} weekend · ${yearlyStats.overtimeDays} OT · ${yearlyStats.holidayDays} holiday · ${yearlyStats.leaveDays} leave`,
    ]
    if (best && best.total > 0) lines.push(`Best month: ${getMonthName(best.month)} · ${formatNaira(best.total)}`)
    if (settings.salaryGoal > 0) lines.push(`Yearly goal: ${formatNaira(settings.salaryGoal * 12)} · ${goalProgressYear}% reached`)
    lines.push(``, `— DayPay · Know what your work is worth.`)
    return lines.join('\n')
  }

  async function shareYearlyToWhatsApp() {
    setShowYearShareMenu(false)
    // Best path: share the actual yearly PDF via the native share sheet (user picks WhatsApp).
    try {
      const doc = generateYearlyDoc()
      const file = new File([doc.output('blob')], yearlySummaryFilename(), { type: 'application/pdf' })
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share({
          files: [file],
          text: `DayPay Yearly Summary — ${year}: ${formatNaira(yearlyStats.total)} · ${yearlyStats.days} days worked`,
          title: 'DayPay Yearly Summary',
        })
        return
      }
    } catch (err) {
      if (err && err.name === 'AbortError') return // user closed the share sheet — not an error
    }
    // Fallback: WhatsApp text summary via wa.me
    window.open(`https://wa.me/?text=${encodeURIComponent(buildYearlyText())}`, '_blank', 'noopener')
  }

  const displayName = user?.user_metadata?.full_name || profileName || user?.email?.split('@')[0] || ''

  const statusConfig = {
    active: { label: 'Active', desc: 'Editable', icon: <svg width="12" height="12" viewBox="0 0 24 24" fill="var(--daypay-green)"><circle cx="12" cy="12" r="8"/></svg>, color: '#16A34A' },
    locked: { label: 'Locked', desc: 'Read only — Final', icon: <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>, color: '#a1a1aa' },
    future: { label: 'Upcoming', desc: 'Not yet active', icon: <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>, color: '#94a3b8' },
    before_start: { label: 'Before start', desc: 'Tracking started later', icon: <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="5" y1="12" x2="19" y2="12"/></svg>, color: '#cbd5e1' },
  }

  const editingRecord = editingKey ? attendance[editingKey] : null
  // The rate in force on the day being edited — matches what its buttons will pay
  const editingRate = editingRecord ? rateForDate(editingRecord.date) : null

  // v18 settings strip: the last locked month's stored total (frozen truth)
  const prevMonthTotal = useMemo(() => {
    const pm = new Date(realYear, realMonth - 1, 1)
    const prefix = `${pm.getFullYear()}-${String(pm.getMonth() + 1).padStart(2, '0')}-`
    let t = 0
    for (const k in attendance) if (k.startsWith(prefix)) t += attendance[k].amount
    return t
  }, [attendance, realYear, realMonth])

  // Salary goal progress
  const goalProgress = settings.salaryGoal > 0 ? Math.min(100, Math.round((monthlyStats.total / settings.salaryGoal) * 100)) : 0
  const goalProgressYear = settings.salaryGoal > 0 ? Math.min(100, Math.round((yearlyStats.total / (settings.salaryGoal * 12)) * 100)) : 0
  const otExtra = monthlyStats.otExtra
  const weekendExtra = monthlyStats.weekendExtra
  const holidayExtra = monthlyStats.holidayExtra
  const totalExtra = otExtra + weekendExtra + holidayExtra

  // Payday countdown + month-end projection (active month only).
  // Projection assumes all remaining Mon–Fri (excl. public holidays and
  // already-logged days) are worked — each at the rate in force on that day.
  const paydayInfo = useMemo(() => {
    const dim = new Date(year, month + 1, 0).getDate()
    const pDay = settings.paydayDay > 0 ? Math.min(settings.paydayDay, dim) : dim
    const paydayDate = new Date(year, month, pDay)
    const todayMid = new Date(realCurrentDate.getFullYear(), realCurrentDate.getMonth(), realCurrentDate.getDate())
    const viewStart = new Date(year, month, 1)
    const from = todayMid > viewStart ? todayMid : viewStart
    const end = new Date(year, month, dim)
    let remainingWeekdays = 0, projectedRemaining = 0, nextRate = null, ratesMixed = false
    for (let d = new Date(from); d <= end; d.setDate(d.getDate() + 1)) {
      const dow = d.getDay()
      if (dow === 0 || dow === 6) continue
      if (isHolidayDay(d)) continue
      const dk = formatDateKey(d)
      if (attendance[dk]) continue
      remainingWeekdays += 1
      const dayRate = rateForPeriod(settings.ratePeriods, dk, settings).dailyRate
      projectedRemaining += dayRate
      if (nextRate == null) nextRate = dayRate
      else if (dayRate !== nextRate) ratesMixed = true
    }
    const daysToPayday = Math.round((paydayDate - todayMid) / 86400000)
    const projectedTotal = monthlyStats.total + projectedRemaining
    return { paydayDay: pDay, paydayDate, daysToPayday, remainingWeekdays, projectedTotal, nextRate, ratesMixed }
  }, [year, month, realCurrentDate, settings.paydayDay, settings.ratePeriods, settings.dailyRate, monthlyStats.total, attendance, holidaysMap])

  return (
    <div className="app-root">
      <style>{`@import url('https://fonts.googleapis.com/css2?family=Manrope:wght@400;500;700;800&family=Geist+Mono:wght@400;500;600&display=swap');`}</style>

      {/* DayPay motion layer — success toast (visual only, confirmed saves only) */}
      {dpToast && (
        <div className={`dp-toast dp-toast-${dpToast.variant}`} role="status" aria-live="polite" key={dpToast.id} title="Tap to dismiss" onClick={() => { if (dpToastTimer.current) clearTimeout(dpToastTimer.current); setDpToast(null) }}>
          {(dpToast.variant === 'weekend' || dpToast.variant === 'month') ? (
            <span className="dp-toast-slips" aria-hidden="true" />
          ) : (
            <span className="dp-toast-slip" aria-hidden="true" />
          )}
          <span className="dp-toast-text">
            <strong>{dpToast.title}</strong>
            {dpToast.sub && <em>{dpToast.sub}</em>}
          </span>
          {dpToast.variant === 'weekend' && (
            <span className="dp-toast-sparks" aria-hidden="true"><i /><i /><i /></span>
          )}
        </div>
      )}

      {/* v19-A: quiet saves — visually-hidden confirmation for screen readers */}
      {dpQuietSay && (
        <div className="sr-only" role="status" aria-live="polite" key={dpQuietSay.id}>{dpQuietSay.text}</div>
      )}

      {/* v19-C: backup nudge — one quiet banner when data lives only on this device */}
      {dpBackupNudge && (
        <div className="dp-backup-nudge" role="status" onClick={()=>setDpBackupNudge(false)}>
          <span className="dp-nudge-dot" aria-hidden="true" />
          <p className="dp-nudge-text">
            <b>Your {Object.keys(attendance).length} logged day{Object.keys(attendance).length!==1?'s':''} live only on this phone.</b>{' '}
            {isSupabaseConfigured ? 'Sign in to back them up.' : 'Back them up as a file you own.'}
          </p>
          <button type="button" className="dp-nudge-btn" onClick={e=>{e.stopPropagation(); setDpBackupNudge(false); if (isSupabaseConfigured) { setShowAuth(true); setAuthMode('signin') } else handleExportJson()}}>Back up now</button>
        </div>
      )}

      {showSplash && (
        <div className="daypay-splash">
          <div className="splash-content">
            <div className="splash-scene" aria-hidden="true">
              <svg className="splash-cal" viewBox="0 0 170 172" width="168" height="170">
                <rect className="sc-ring" x="62" y="6" width="10" height="20" rx="5"/>
                <rect className="sc-ring" x="98" y="6" width="10" height="20" rx="5"/>
                <rect className="sc-body" x="15" y="18" width="140" height="140" rx="18"/>
                <rect className="sc-head" x="15" y="18" width="140" height="34" rx="18"/>
                <rect className="sc-head2" x="15" y="38" width="140" height="14"/>
                <circle className="sc-dot" cx="85" cy="35" r="4.5"/>
                {(() => {
                  // month-so-far story: days stamp in one by one, a few stay upcoming
                  const types = ['ok','ok','ok','ok','wk','ok','ok','ot','ok','wk','ok','ok','p','p','p']
                  let stamp = -1
                  return types.map((type, i) => {
                    const x = 27 + (i % 5) * 26
                    const y = 68 + Math.floor(i / 5) * 26
                    if (type === 'p') return <rect key={i} className="sc-pend" x={x} y={y} width="20" height="20" rx="6"/>
                    stamp += 1
                    const cls = type === 'wk' ? ' sc-wknd' : type === 'ot' ? ' sc-ot' : ''
                    return (
                      <g key={i} className={`sc-cell${cls}`} style={{ animationDelay: `${(0.5 + stamp * 0.085).toFixed(3)}s`, transformOrigin: `${x + 10}px ${y + 11}px` }}>
                        <rect x={x} y={y} width="20" height="20" rx="6"/>
                        <text x={x + 10} y={y + 11}>₦</text>
                      </g>
                    )
                  })
                })()}
              </svg>
            </div>
            <div className="splash-tagline">Know what your work is worth.</div>
            <div className="splash-loader">
              <div className="loader-dot"></div>
              <div className="loader-dot"></div>
              <div className="loader-dot"></div>
            </div>
            <div className="splash-footer">
              <span className="splash-navy">Day</span><span className="splash-green">Pay</span>
              <span className="splash-dot">·</span>
              <span className="splash-year">{realCurrentDate.getFullYear()}</span>
            </div>
          </div>
        </div>
      )}

      {!showSettings && (
      <div className="phone-frame">
        <header className="header">
          <div className="header-left">
            <span className="hdr-lockup" title="DayPay - Know what your work is worth.">
              <svg className="hdr-mark" viewBox="0 0 48 48" width="27" height="27" role="img" aria-label="DayPay logo">
                <rect x="15" y="16" width="26" height="26" rx="7" fill="var(--daypay-green)"/>
                <rect x="7" y="8" width="26" height="26" rx="7" fill={isDarkAppearance ? '#0D1424' : '#FFFFFF'} stroke={isDarkAppearance ? '#2A3550' : '#0B1B32'} strokeWidth="4"/>
              </svg>
              <span className="wordmark"><span className="wm-day">Day</span><span className="wm-pay">Pay</span></span>
            </span>
            {isSupabaseConfigured && syncStatus!=='idle' && (
              <span className={`sync-badge ${syncStatus}`}>{syncStatus==='syncing'?'syncing…':syncStatus==='synced'?'synced ✓':'error'}</span>
            )}
          </div>
          <div className="header-right" style={{display:'flex', gap:8, alignItems:'center'}} ref={hamburgerMenuRef}>
            <button className="icon-btn hamburger-btn" onClick={()=>setShowHamburgerMenu(!showHamburgerMenu)} aria-label="Menu" title="Menu">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg>
            </button>
            {showHamburgerMenu && (
              <div className="hamburger-dropdown">
                {user && displayName && (
                  <div className="hamburger-user">
                    <div className="welcome-avatar" style={{width:32, height:32, fontSize:13}}>{displayName.charAt(0).toUpperCase()}</div>
                    <div>
                      <div style={{fontWeight:700, fontSize:13}}>{displayName}</div>
                      <div style={{fontSize:10, color:'var(--text-3)', fontFamily:'Geist Mono, monospace'}}>{user.email}</div>
                    </div>
                  </div>
                )}
                <button className="hamburger-item" onClick={()=>setShowThemeMenu(v=>!v)} aria-expanded={showThemeMenu}>
                  <span className="hamburger-icon">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9L12 3Z"/><path d="M19 15l.7 1.8 1.8.7-1.8.7L19 19.7l-.7-1.8-1.8-.7 1.8-.7L19 15Z"/></svg>
                  </span>
                  <span>Choose theme</span>
                  <span className={`hamburger-chev${showThemeMenu ? ' open' : ''}`} aria-hidden="true">▸</span>
                </button>
                {showThemeMenu && (
                  <div className="theme-picker">
                    {THEME_OPTIONS.map(opt => (
                      <button type="button" key={opt.id} data-opt={opt.id} className={`theme-opt${theme===opt.id ? ' on' : ''}`} onClick={()=>setTheme(opt.id)} aria-pressed={theme===opt.id}>
                        <span className={`theme-sw ${opt.sw}`} aria-hidden="true" />
                        <span>{opt.label}</span>
                        {theme===opt.id && <span className="theme-check" aria-hidden="true">✓</span>}
                      </button>
                    ))}
                  </div>
                )}
                {isSupabaseConfigured && (
                  user ? (
                    <button className="hamburger-item" onClick={()=>{handleLogout(); setShowHamburgerMenu(false)}}>
                      <span className="hamburger-icon"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg></span>
                      <span>Sign out</span>
                    </button>
                  ) : (
                    <button className="hamburger-item" onClick={()=>{setShowAuth(true); setAuthMode('signin'); setShowHamburgerMenu(false)}}>
                      <span className="hamburger-icon"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"><path d="M15 3h4a5 5 0 0 1 5 5v8a5 5 0 0 1-5 5h-4"/><polyline points="10 17 15 12 10 7"/><line x1="15" y1="12" x2="3" y2="12"/></svg></span>
                      <span>Sign in to DayPay</span>
                    </button>
                  )
                )}
                <button className="hamburger-item" onClick={()=>{setShowSettings(true); setShowHamburgerMenu(false)}}>
                  <span className="hamburger-icon"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><path d="M4 6h2.8M11.2 6H20"/><circle cx="9" cy="6" r="2.1"/><path d="M4 12h8.6M17 12h3"/><circle cx="14.8" cy="12" r="2.1"/><path d="M4 18h3.8M12.2 18H20"/><circle cx="10" cy="18" r="2.1"/></svg></span>
                  <span>Settings</span>
                </button>
                {isSupabaseConfigured && syncStatus!=='idle' && (
                  <div className="hamburger-sync">
                    <span className={`sync-badge ${syncStatus}`} style={{marginLeft:0}}>{syncStatus==='syncing'?'syncing…':syncStatus==='synced'?'synced ✓':'error'}</span>
                  </div>
                )}
              </div>
            )}
          </div>
        </header>

        {!isSupabaseConfigured && (
          <div className="config-banner">
            <span>Cloud sync not configured.</span>
            <a href="#" onClick={(e)=>{e.preventDefault(); setShowSettings(true)}}>Setup →</a>
          </div>
        )}

        {cloudError && (
          <div className="error-banner">
            <span>{cloudError}</span>
            <button onClick={()=>setCloudError('')}>×</button>
          </div>
        )}

        {user && displayName && (
          <div className="welcome-banner">
            <div className="welcome-avatar">{displayName.charAt(0).toUpperCase()}</div>
            <div className="welcome-text">
              <span className="welcome-name">Hi, {displayName}</span>
              <span className="welcome-sub">{user.email} · {startMonthKey ? `Started ${startMonthKey}` : ''}</span>
            </div>
          </div>
        )}

        <div className="seg-wrap">
          <div className="segmented">
            <button className={view==='month'?'active':''} onClick={()=>setView('month')}>Month</button>
            <button className={view==='year'?'active':''} onClick={()=>setView('year')}>Year</button>
          </div>
        </div>

        {view==='month' ? (
          <>
            <div className="month-nav">
              <button className="nav-btn" onClick={goPrevMonth} disabled={(() => {
                if (!startMonthKey) return false
                const { year: sY, month: sM } = parseMonthKey(startMonthKey)
                return (year*12 + month) -1 < sY*12 + sM
              })()} style={{opacity: (() => {
                if (!startMonthKey) return 1
                const { year: sY, month: sM } = parseMonthKey(startMonthKey)
                return (year*12 + month) -1 < sY*12 + sM ? 0.3 : 1
              })()}}><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="m15 18-6-6 6-6"/></svg></button>
              <div className="month-title">
                <span className="month-name">{getMonthName(month)}</span>
                <span className="year-name" style={{display:'flex', gap:6, alignItems:'center'}}>
                  {year}
                  <span className={`status-dot ${monthStatus}`} title={statusConfig[monthStatus]?.label} />
                  {startMonthKey && monthKey(year, month)===startMonthKey && <span style={{fontSize:'9px', background:'var(--daypay-navy)', border:'1px solid var(--daypay-navy)', padding:'1px 5px', borderRadius:4, marginLeft:4, color:'#ffffff'}}>START</span>}
                </span>
              </div>
              <button className="nav-btn" onClick={goNextMonth}><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="m9 18 6-6-6-6"/></svg></button>
            </div>

            <div className={`month-status-banner ${monthStatus}`}>
              <div className="msb-left">
                <span className="msb-icon">{statusConfig[monthStatus]?.icon}</span>
                <span className="msb-label">{statusConfig[monthStatus]?.label}</span>
                <span className="msb-desc">· {statusConfig[monthStatus]?.desc}</span>
              </div>
              {monthStatus!=='active' && (
                <button className="msb-action" onClick={goToCurrentMonth}>Go to current</button>
              )}
            </div>

            {monthStatus==='locked' && monthlyStats.days>0 && (
              <div className="final-salary-banner">
                <div className="fsb-label">Final salary for {getMonthName(month)} {year}</div>
                <div className="fsb-amount">{formatNaira(monthlyStats.total)}</div>
                <div className="fsb-details">{monthlyStats.days} days · {monthlyStats.regularDays} regular · {monthlyStats.weekendDays} weekend · {monthlyStats.overtimeDays} OT · {monthlyStats.holidayDays} holiday · {monthlyStats.leaveDays} leave · Locked</div>
              </div>
            )}

            {monthStatus==='future' && (
              <div className="info-banner">This month hasn't started yet. Opens on {getMonthName(month)} {year}. You can view it but not edit.</div>
            )}

            {monthStatus==='before_start' && (
              <div className="info-banner">Tracking started in {startMonthKey ? (()=>{const {year, month}=parseMonthKey(startMonthKey); return `${getMonthName(month)} ${year}`})() : 'current month'}. No records before that.</div>
            )}

            {isEditable || monthStatus==='locked' ? (
            <>
            <div className="weekdays">
              {['Mon','Tue','Wed','Thu','Fri','Sat','Sun'].map((w,idx)=><div key={w} className={idx>=5?'weekend-label':''}>{w}</div>)}
            </div>

            <div className={`calendar-grid ${!isEditable ? 'locked-grid' : ''}`}>
              {calendarCells.map((dateObj,i)=>{
                if(!dateObj) return <div key={'empty-'+i} className="cell empty" />
                const key=formatDateKey(dateObj)
                const record=attendance[key]
                const isToday=key===todayKey
                const isWeekend=isWeekendDay(dateObj)
                const holiday = isHolidayDay(dateObj)
                const worked=!!record
                const isOvertime = record?.isOvertime
                const isHol = record?.isHoliday || holiday
                return (
                  <button key={key} className={`cell ${worked?'worked':''} ${isWeekend?'is-weekend':''} ${isToday?'is-today':''} ${!isEditable?'locked-cell':''} ${isOvertime?'is-overtime':''} ${isHol?'is-holiday':''} ${record?.isLeave?'is-leave':''} ${record?.isLeave && record.amount===0?'is-leave-unpaid':''} ${dpJust && dpJust.key===key ? 'dp-just' : ''}`} onClick={()=>handleCellClick(dateObj)} disabled={!isEditable && !worked} title={record?.isLeave ? `${leaveLabel(record.leaveType)} — ${record.amount>0 ? 'Paid leave' : 'Unpaid leave'}` : holiday ? `${holiday.name} — ${isWeekend ? 'Weekend' : 'Holiday'} 2×` : isWeekend ? 'Weekend 2×' : 'Weekday'}>
                    <span className="date-num">{dateObj.getDate()}</span>
                    {holiday && !worked && <span className="holiday-dot" title={holiday.name}></span>}
                    {worked && (
                      <span className={`stamp ${record.isLeave ? `stamp-leave${record.amount===0?' unpaid':''}` : record.isWeekend ? 'stamp-2x' : record.isOvertime ? 'stamp-ot' : record.isHoliday ? 'stamp-hol' : 'stamp-ok'}`}>
                        {record.isLeave ? leaveLabel(record.leaveType) : record.isWeekend ? '2×' : record.isOvertime ? 'OT' : record.isHoliday ? 'HOL' : 'OK'}
                      </span>
                    )}
                    {isToday && !worked && <span className="today-dot" />}
                    {!isEditable && worked && <span className="locked-overlay"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg></span>}
                    {worked && !isWeekend && !record.isHoliday && isEditable && (
                      <span className="edit-corner" onClick={(e)=>handleEditButtonClick(e, dateObj)} title="Edit to overtime">
                        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
                      </span>
                    )}
                  </button>
                )
              })}
            </div>

            {isEditable && futureDays.length > 0 && (
              !showFutureDays ? (
                <button className="future-log-btn" onClick={()=>setShowFutureDays(true)}>
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><rect x="3" y="4" width="18" height="17" rx="2.5"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/><path d="M12 14v4M10 16h4"/></svg>
                  Log a future day
                  <span className="future-log-count">{futureDays.length} left this month</span>
                </button>
              ) : (
                <div className="future-chips-block">
                  <div className="future-chips-label">Tap a day to log it ahead</div>
                  <div className="future-chips">
                    {futureDays.map(d => {
                      const dt = new Date(year, month, d)
                      const wd = ['S','M','T','W','T','F','S'][dt.getDay()]
                      const wknd = isWeekendDay(dt)
                      return (
                        <button key={d} className={`future-chip ${wknd?'weekend':''}`} onClick={()=>handleCellClick(dt)} title={wknd ? 'Weekend 2×' : 'Weekday'}>
                          <span className="fc-wd">{wd}</span>
                          <span className="fc-num">{d}</span>
                        </button>
                      )
                    })}
                  </div>
                </div>
              )
            )}
            </>
            ) : (
              <div className="upcoming-note">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"><rect x="3" y="4" width="18" height="17" rx="2.5"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
                <span>{monthStatus==='future' ? 'Calendar opens when the month starts.' : 'No records this month.'}</span>
              </div>
            )}

            <div className="summary-card">
              <div className="summary-top">
                <div className="summary-amount dp-count">
                  <AnimatedAmount value={monthlyStats.total} />
                  {monthStatus==='locked' && <span className="final-badge">FINAL</span>}
                  {monthStatus==='active' && <span className="active-badge">IN PROGRESS</span>}
                </div>
                <div className="summary-sub">
                  {displayName ? `${displayName} · ` : ''}{monthlyStats.days} day{monthlyStats.days!==1?'s':''} worked{monthlyStats.leaveDays>0 ? `, ${monthlyStats.leaveDays} on leave` : ''} {monthStatus==='locked' ? '· Locked' : monthStatus==='active' ? '· Editable' : ''} {isSupabaseConfigured && user && <span className="cloud-hint">· cloud synced</span>}
                </div>

                {/* v18: read-only details collapsed by default — calendar closer to the top */}
                <button type="button" className="dp-fold" onClick={()=>setSumFold(v=>!v)} aria-expanded={sumFold}>
                  <span className="dp-fold-main">
                    <span className="dp-fold-title">Details</span>
                    <span className="dp-fold-sum">
                      {monthStatus==='active'
                        ? `Projected ${formatNaira(paydayInfo.projectedTotal)} · ${paydayInfo.daysToPayday > 0 ? `${paydayInfo.daysToPayday}d to payday` : paydayInfo.daysToPayday === 0 ? 'payday today 🎉' : 'payday passed'}`
                        : `${monthlyStats.days} day${monthlyStats.days!==1?'s':''} worked`}
                      {settings.salaryGoal > 0 ? ` · ${goalProgress}% of goal` : ''}
                    </span>
                  </span>
                  <span className={`dp-fold-chev${sumFold ? ' open' : ''}`} aria-hidden="true">▸</span>
                </button>

                {sumFold && (<>
                {/* Payday countdown + projection (active month only) */}
                {monthStatus==='active' && (
                  <div className="payday-panel">
                    <div className="payday-top">
                      <div className="payday-block">
                        <span className="payday-num mono payday-projected">{formatNaira(paydayInfo.projectedTotal)}</span>
                        <span className="payday-cap">Projected month-end</span>
                      </div>
                      <div className="payday-block payday-count">
                        <span className="payday-num mono">{paydayInfo.daysToPayday > 0 ? paydayInfo.daysToPayday : paydayInfo.daysToPayday === 0 ? 'Today' : '\u2013'}</span>
                        <span className="payday-cap">{paydayInfo.daysToPayday > 1 ? 'days to payday' : paydayInfo.daysToPayday === 1 ? 'day to payday' : paydayInfo.daysToPayday === 0 ? 'is payday \uD83C\uDF89' : 'payday passed'}</span>
                      </div>
                    </div>
                    <div className="payday-hint">
                      Payday {getMonthName(month, true)} {paydayInfo.paydayDay} · {paydayInfo.remainingWeekdays} weekday{paydayInfo.remainingWeekdays!==1?'s':''} left · at {paydayInfo.ratesMixed ? 'mixed rates' : `${formatNaira(paydayInfo.nextRate ?? settings.dailyRate)}/day`}
                    </div>
                  </div>
                )}

                {/* Salary Goal Progress */}
                {settings.salaryGoal > 0 && (
                  <div className="goal-progress">
                    <div className="goal-header">
                      <span>Monthly Goal: {formatNaira(settings.salaryGoal)}</span>
                      <span className="mono" style={{fontWeight:700, color: goalProgress>=100 ? 'var(--daypay-green)' : 'var(--daypay-navy)'}}>{goalProgress}%</span>
                    </div>
                    <div className="progress-bar">
                      <div className="progress-fill" style={{width: `${Math.min(100, goalProgress)}%`, background: goalProgress>=100 ? 'var(--daypay-green)' : 'var(--daypay-navy)'}}></div>
                    </div>
                    <div className="goal-hint">
                      {monthlyStats.total >= settings.salaryGoal ? `🎉 Goal reached! +${formatNaira(monthlyStats.total - settings.salaryGoal)} over` : `Need ${formatNaira(settings.salaryGoal - monthlyStats.total)} more to reach goal`}
                    </div>
                  </div>
                )}

                {/* OT Insights */}
                {totalExtra > 0 && (
                  <div className="ot-insights">
                    <div className="ot-insight-title"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{marginRight:6}}><path d="M9 21h6"/><path d="M12 17a5 5 0 0 0 5-5c0-2-1-3-2-4l-1-1h-4l-1 1c-1 1-2 2-2 4a5 5 0 0 0 5 5z"/><path d="M12 7V5"/></svg> Extra Value — Peeking Slip</div>
                    <div className="ot-insight-text">
                      {monthlyStats.overtimeDays>0 && <span>{monthlyStats.overtimeDays} OT days = {formatNaira(otExtra)} extra · </span>}
                      {monthlyStats.weekendDays>0 && <span>{monthlyStats.weekendDays} weekend days = {formatNaira(weekendExtra)} extra · </span>}
                      {monthlyStats.holidayDays>0 && <span>{monthlyStats.holidayDays} holidays = {formatNaira(holidayExtra)} extra</span>}
                      <br />
                      <strong>Total extra from 2×: {formatNaira(totalExtra)}</strong> — that's the green slip peeking!
                    </div>
                  </div>
                )}
                </>)}
              </div>
              {sumFold && (<>
              <div className="summary-divider" />
              <div className="summary-rows">
                <div className="summary-row"><span>Regular <span className="mini-stamp ok">OK</span></span><span className="mono">{monthlyStats.regularAmt ? `${monthlyStats.regularDays} × ${formatNaira(monthlyStats.regularAmt)}` : `${monthlyStats.regularDays}d · mixed`}</span></div>
                <div className="summary-row"><span>Weekend <span className="mini-stamp x2">2×</span></span><span className="mono">{monthlyStats.weekendAmt ? `${monthlyStats.weekendDays} × ${formatNaira(monthlyStats.weekendAmt)}` : `${monthlyStats.weekendDays}d · mixed`}</span></div>
                <div className="summary-row"><span>Overtime <span className="mini-stamp ot">OT 2×</span></span><span className="mono">{monthlyStats.otAmt ? `${monthlyStats.overtimeDays} × ${formatNaira(monthlyStats.otAmt)}` : `${monthlyStats.overtimeDays}d · mixed`}</span></div>
                <div className="summary-row"><span>Holiday <span className="mini-stamp hol">HOL 2×</span></span><span className="mono">{monthlyStats.holidayAmt ? `${monthlyStats.holidayDays} × ${formatNaira(monthlyStats.holidayAmt)}` : `${monthlyStats.holidayDays}d · mixed`}</span></div>
                <div className="summary-row"><span>Leave <span className="mini-stamp lv">LV</span></span><span className="mono">{monthlyStats.leaveDays}d · {formatNaira(monthlyStats.leavePay)}</span></div>
                <div className="summary-row" style={{marginTop:4, paddingTop:10, borderTop:'1px dashed var(--border)'}}><span><strong>Monthly {monthStatus==='locked'?'Final Salary':'Total'}</strong></span><span className="mono" style={{fontWeight:800, color:'var(--daypay-green)', fontSize:'14px'}}>{formatNaira(monthlyStats.total)}</span></div>
              </div>
              </>)}

              <div style={{position:'relative', marginTop:14}} ref={shareMenuRef}>
                <button className="btn-secondary" style={{width:'100%', height:40, display:'flex', alignItems:'center', justifyContent:'center', gap:8}} onClick={()=>{ setShowYearShareMenu(false); setShowShareMenu(v=>!v) }} disabled={(monthlyStats.days + monthlyStats.leaveDays)===0}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/><polyline points="16 6 12 2 8 6"/><line x1="12" y1="2" x2="12" y2="15"/></svg>
                  Share Payslip
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" style={{marginLeft:2, opacity:.6}}><polyline points="6 9 12 15 18 9"/></svg>
                </button>
                {showShareMenu && (
                  <div className="share-dropdown">
                    <button className="share-option" onClick={shareToWhatsApp}>
                      <span className="share-option-icon wa">
                        <svg width="17" height="17" viewBox="0 0 24 24" fill="currentColor"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.297-.347.446-.52.149-.174.198-.298.297-.497.1-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 0 1-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 0 1-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 0 1 2.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0 0 12.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 0 0 5.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 0 0-3.48-8.413z"/></svg>
                      </span>
                      <span className="share-option-text">
                        <strong>Share to WhatsApp</strong>
                        <em>PDF via share sheet · text summary fallback</em>
                      </span>
                    </button>
                    <button className="share-option" onClick={()=>{ setShowShareMenu(false); exportPayslip() }}>
                      <span className="share-option-icon pdf">
                        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>
                      </span>
                      <span className="share-option-text">
                        <strong>Export as PDF</strong>
                        <em>Download the payslip file</em>
                      </span>
                    </button>
                  </div>
                )}
              </div>

              {isEditable && (
                <div className="empty-hint">
                  Tap weekday to log OK, edit icon to OT. Weekends auto 2×. Holidays auto HOL 2×. Current month editable.
                </div>
              )}
              {!isEditable && <div className="empty-hint locked-hint" style={{display:'flex', alignItems:'center', justifyContent:'center', gap:6}}>
                {monthStatus==='locked' ? (
                  <><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg> Locked read-only. Final salary includes OT + holidays.</>
                ) : monthStatus==='future' ? (
                  <><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg> Future — not yet active.</>
                ) : 'Before start.'}
              </div>}
            </div>
          </>
        ) : (
          <>
            <div className="month-nav">
              <button className="nav-btn" onClick={goPrevYear} disabled={(() => {
                if (!startMonthKey) return false
                return (year - 1) < parseMonthKey(startMonthKey).year
              })()} style={{opacity: (() => {
                if (!startMonthKey) return 1
                return (year - 1) < parseMonthKey(startMonthKey).year ? 0.3 : 1
              })()}}><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="m15 18-6-6 6-6"/></svg></button>
              <div className="month-title"><span className="month-name">{year}</span><span className="year-name">Year view · {year===realYear ? 'Current year' : year < realYear ? 'Historical' : 'Future'} {startMonthKey && year===parseMonthKey(startMonthKey).year ? `· Started ${getMonthName(parseMonthKey(startMonthKey).month)}` : ''}</span></div>
              <button className="nav-btn" onClick={goNextYear}><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="m9 18 6-6-6-6"/></svg></button>
            </div>

            <div className="year-totals">
              <div className="yt-main">
                <div className="yt-amount dp-count"><AnimatedAmount value={yearlyStats.total} /></div>
                <div className="yt-label">
                  {year===realYear ? `Total earned this year` : year < realYear ? `Total earned in ${year} — Final` : `Future year`}
                  {displayName ? ` · ${displayName}` : ''} · {yearlyStats.days} days{yearlyStats.leaveDays>0 ? ` · ${yearlyStats.leaveDays} on leave` : ''} · Goal {formatNaira(settings.salaryGoal)} · {goalProgressYear}% of yearly goal
                </div>
                {year===realYear && (
                  <div className="yt-sub">
                    {yearlyStats.monthly.filter(m=>m.status==='locked').length} locked · {yearlyStats.monthly.filter(m=>m.status==='active').length} active · {yearlyStats.monthly.filter(m=>m.status==='future').length} upcoming · {yearlyStats.overtimeDays} OT · {yearlyStats.holidayDays} holidays{yearlyStats.leaveDays>0 ? ` · ${yearlyStats.leaveDays} leave` : ''}
                  </div>
                )}
              </div>
              <div className="yt-grid">
                <div className="yt-item"><div className="yt-num mono">{yearlyStats.days}</div><div className="yt-cap">Days worked</div></div>
                <div className="yt-item"><div className="yt-num mono">{yearlyStats.overtimeDays}</div><div className="yt-cap">OT days</div></div>
                <div className="yt-item"><div className="yt-num mono">{yearlyStats.weekendDays + yearlyStats.holidayDays}</div><div className="yt-cap">Weekend+Hol</div></div>
              </div>

              <div className="annual-breakdown">
                <div className="ab-title">Monthly breakdown — {year} {year===realYear ? `· Yearly Goal Progress: ${goalProgressYear}%` : ''}</div>
                {(() => {
                  if (!startMonthKey) return yearlyStats.monthly
                  const { year: sY, month: sM } = parseMonthKey(startMonthKey)
                  if (year < sY) return []
                  if (year === sY) return yearlyStats.monthly.filter(m=>m.month >= sM)
                  return yearlyStats.monthly
                })().map(m=>{
                  return (
                    <div key={m.month} className={`ab-row ${m.status}`}>
                      <span className="ab-month">{getMonthName(m.month, true)}</span>
                      <span className={`ab-status ${m.status}`} style={{display:'flex', alignItems:'center', gap:4}}>
                        {m.status==='locked' ? <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg> : m.status==='active' ? <svg width="10" height="10" viewBox="0 0 24 24" fill="var(--daypay-green)"><circle cx="12" cy="12" r="8"/></svg> : m.status==='future' ? <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg> : <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="5" y1="12" x2="19" y2="12"/></svg>}
                        <span>{m.status==='locked'?'Locked':m.status==='active'?'Active':m.status==='future'?'Upcoming':'Before start'}</span>
                      </span>
                      <span className="ab-days mono">{m.days>0?`${m.days}d`:'—'}</span>
                      <span className="ab-amount mono">{m.total>0?formatNaira(m.total):'₦0'}</span>
                    </div>
                  )
                })}
                {(() => {
                  if (!startMonthKey) return true
                  return year >= parseMonthKey(startMonthKey).year
                })() && (
                  <div className="ab-total">
                    <span>Total {year} {startMonthKey && year===parseMonthKey(startMonthKey).year ? `(from ${getMonthName(parseMonthKey(startMonthKey).month)})` : ''}</span>
                    <span className="mono" style={{color:'var(--daypay-green)'}}>{formatNaira(yearlyStats.total)}</span>
                  </div>
                )}
              </div>

              <div style={{position:'relative', marginTop:14}} ref={yearShareMenuRef}>
                <button className="btn-secondary" style={{width:'100%', height:40, display:'flex', alignItems:'center', justifyContent:'center', gap:8}} onClick={()=>{ setShowShareMenu(false); setShowYearShareMenu(v=>!v) }} disabled={(yearlyStats.days + yearlyStats.leaveDays)===0}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/><polyline points="16 6 12 2 8 6"/><line x1="12" y1="2" x2="12" y2="15"/></svg>
                  Share Yearly Summary
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" style={{marginLeft:2, opacity:.6}}><polyline points="6 9 12 15 18 9"/></svg>
                </button>
                {showYearShareMenu && (
                  <div className="share-dropdown">
                    <button className="share-option" onClick={shareYearlyToWhatsApp}>
                      <span className="share-option-icon wa">
                        <svg width="17" height="17" viewBox="0 0 24 24" fill="currentColor"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.297-.347.446-.52.149-.174.198-.298.297-.497.1-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 0 1-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 0 1-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 0 1 2.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0 0 12.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 0 0 5.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 0 0-3.48-8.413z"/></svg>
                      </span>
                      <span className="share-option-text">
                        <strong>Share to WhatsApp</strong>
                        <em>PDF via share sheet · text summary fallback</em>
                      </span>
                    </button>
                    <button className="share-option" onClick={()=>{ setShowYearShareMenu(false); exportYearlySummary() }}>
                      <span className="share-option-icon pdf">
                        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>
                      </span>
                      <span className="share-option-text">
                        <strong>Export as PDF</strong>
                        <em>Download the yearly summary</em>
                      </span>
                    </button>
                  </div>
                )}
              </div>
            </div>

            <div className="months-list">
              {(() => {
                if (!startMonthKey) return null
                const { year: sY, month: sM } = parseMonthKey(startMonthKey)
                if (year < sY) return <div className="info-banner">Tracking started in {getMonthName(sM)} {sY}. No records before that.</div>
                return null
              })()}
              <div className="ml-header">Tap month to view — locked read-only, weekdays editable via edit icon for OT</div>
              {yearlyStats.monthly
                .filter(m => {
                  if (!startMonthKey) return true
                  const { year: sY, month: sM } = parseMonthKey(startMonthKey)
                  if (year < sY) return false
                  if (year === sY && m.month < sM) return false
                  return true
                })
                .map(m=>(
                <button key={m.month} className={`month-row ${m.status}`} onClick={()=>openMonth(m.month)}>
                  <div className="mr-left">
                    <span className="mr-name">{getMonthName(m.month,true)}</span>
                    <span className={`mr-status ${m.status}`} style={{display:'grid', placeItems:'center'}}>
                      {m.status==='locked' ? <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg> : m.status==='active' ? <svg width="10" height="10" viewBox="0 0 24 24" fill="var(--daypay-green)"><circle cx="12" cy="12" r="8"/></svg> : m.status==='future' ? <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg> : <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="5" y1="12" x2="19" y2="12"/></svg>}
                    </span>
                    <span className="mr-days mono">{m.days>0?`${m.days}d`:'—'}</span>
                  </div>
                  <div className="mr-right">
                    <span className="mr-amount mono">{m.total>0?formatNaira(m.total):'₦0'}</span>
                    {m.status==='locked' && <span className="mr-final">FINAL</span>}
                    {m.status==='active' && <span className="mr-active">ACTIVE</span>}
                    <span className="mr-arrow"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="m9 18 6-6-6-6"/></svg></span>
                  </div>
                </button>
              ))}
            </div>
          </>
        )}

        <div className="footer">
          <span className="footer-dot" /> {displayName ? `${displayName} · ` : ''}{settings.dailyRate.toLocaleString('en-NG')} / day · {settings.weekendMultiplier}× OT/Hol/Weekend {monthStatus==='locked' ? '· locked' : monthStatus==='active' ? '· active' : ''} {isSupabaseConfigured && user ? '· synced' : '· local'} · PWA ready · © 2026 Akaninyene
        </div>
      </div>
      )}

      {editingKey && (
        <div className="modal-overlay" onClick={()=>{setEditingKey(null); setEditingDate(null)}}>
          <div className="modal" onClick={e=>e.stopPropagation()} style={{maxWidth:360}}>
            <div className="modal-header">
              <span>Edit {editingDate ? `${getMonthName(editingDate.getMonth())} ${editingDate.getDate()}, ${editingDate.getFullYear()}` : editingKey}</span>
              <button className="icon-btn small" onClick={()=>{setEditingKey(null); setEditingDate(null)}}><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M18 6 6 18M6 6l12 12"/></svg></button>
            </div>
            <div className="modal-body">
              {editingRecord && (
                <>
                  <div className="info-box" style={{marginTop:0}}>
                    <div className="info-row"><span>Current</span><span className="mono" style={{fontWeight:700}}>{editingRecord.isLeave ? leaveLabel(editingRecord.leaveType) : editingRecord.isOvertime ? 'OT 2×' : editingRecord.isWeekend ? 'Weekend 2×' : editingRecord.isHoliday ? 'Holiday 2×' : 'Regular OK'} · {formatNaira(editingRecord.amount)}</span></div>
                    <div className="info-row sub"><span>Date</span><span className="mono">{editingRecord.date}</span></div>
                  </div>
                  <div style={{marginTop:16, display:'flex', flexDirection:'column', gap:10}}>
                    <button className={`ot-option ${!editingRecord.isWeekend && !editingRecord.isOvertime && !editingRecord.isHoliday && !editingRecord.isLeave ? 'selected' : ''}`} onClick={()=>handleOvertimeAction('regular')}>
                      <span className="ot-opt-left"><span className="mini-stamp ok">OK</span> Regular</span>
                      <span className="mono">{formatNaira(editingRate.dailyRate)}</span>
                    </button>
                    <button className={`ot-option ${editingRecord.isOvertime ? 'selected' : ''}`} onClick={()=>handleOvertimeAction('overtime')}>
                      <span className="ot-opt-left"><span className="mini-stamp ot">OT</span> Overtime 2×</span>
                      <span className="mono">{formatNaira(editingRate.dailyRate * editingRate.weekendMultiplier)}</span>
                    </button>
                    <button className={`ot-option ${editingRecord.isHoliday ? 'selected' : ''}`} onClick={()=>handleOvertimeAction('holiday')}>
                      <span className="ot-opt-left"><span className="mini-stamp hol">HOL</span> Holiday 2×</span>
                      <span className="mono">{formatNaira(editingRate.dailyRate * editingRate.holidayMultiplier)}</span>
                    </button>
                    {leaveTypes.length > 0 && <div className="leave-divider">Mark as leave</div>}
                    {leaveTypes.map(t => {
                      const pay = leavePayFor(t, editingRate.dailyRate)
                      const initials = (t.name || 'LV').replace(/[^A-Za-z]/g, '').slice(0, 3).toUpperCase() || 'LV'
                      return (
                        <button key={t.id} className={`ot-option ${editingRecord.isLeave && editingRecord.leaveType===t.id ? 'selected' : ''}`} onClick={()=>handleOvertimeAction(`leave-${t.id}`)}>
                          <span className="ot-opt-left"><span className={`mini-stamp ${pay>0 ? 'lv' : 'lv-u'}`}>{initials}</span> {t.name}</span>
                          <span className="mono">{pay > 0 ? `${formatNaira(pay)}${t.payMode!=='flat' ? ` · ${t.payValue}%` : ''}` : formatNaira(0)}</span>
                        </button>
                      )
                    })}
                    <button className="ot-option danger" onClick={()=>handleOvertimeAction('remove')}>
                      <span className="ot-opt-left"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg> Remove</span>
                      <span className="mono">Delete</span>
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {showSettings && (
        <div className="phone-frame sp-page">
          <header className="sp-header">
            <button className="sp-back" onClick={()=>setShowSettings(false)} aria-label="Back" title="Back to app">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="m15 18-6-6 6-6"/></svg>
            </button>
            <div className="sp-title">
              <span className="sp-title-main">Settings</span>
              <span className="sp-title-sub">DayPay · Preferences</span>
            </div>
            {isSupabaseConfigured && syncStatus!=='idle' && (
              <span className={`sync-badge ${syncStatus}`}>{syncStatus==='syncing'?'syncing…':syncStatus==='synced'?'synced ✓':'error'}</span>
            )}
          </header>

          <div className="sp-scroll">
            <div className="sp-card sp-profile">
              {user ? (
                <>
                  <div className="welcome-avatar sp-avatar">{(displayName || user.email).charAt(0).toUpperCase()}</div>
                  <div className="sp-profile-main">
                    <input className="sp-name-input" value={profileName} onChange={e=>setProfileName(e.target.value)} placeholder="Your display name" maxLength={40} />
                    <span className="sp-email">{user.email}</span>
                  </div>
                  <button className="sp-save-name" onClick={handleSaveProfileName} disabled={profileSaving || !profileName.trim()}>{profileSaving ? 'Saving…' : 'Save'}</button>
                </>
              ) : isSupabaseConfigured ? (
                <>
                  <div className="sp-avatar sp-avatar-ghost">
                    <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
                  </div>
                  <div className="sp-profile-main">
                    <span className="sp-profile-name">Not signed in</span>
                    <span className="sp-email">Sign in to sync your records across devices</span>
                  </div>
                  <button className="btn-primary sp-signin" onClick={()=>{setAuthMode('signin'); setShowAuth(true)}}>Sign in</button>
                </>
              ) : (
                <>
                  <div className="sp-avatar sp-avatar-ghost">
                    <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"><path d="m2 2 20 20"/><path d="M5.8 5.8A7 7 0 0 0 15.6 17.8"/><path d="M8.6 8.6a4.5 4.5 0 0 0 6.1 6.1"/><path d="M17.5 17.9A4.5 4.5 0 0 0 16.9 9h-1.8"/></svg>
                  </div>
                  <div className="sp-profile-main">
                    <span className="sp-profile-name">Local only</span>
                    <span className="sp-email">Cloud sync not configured — data stays on this device</span>
                  </div>
                </>
              )}
            </div>

            <div className="sp-section-label">Appearance</div>
            <div className="sp-card">
              <div className="app-tiles">
                <button type="button" className={`app-tile${theme==='light' ? ' on' : ''}`} onClick={()=>setTheme('light')} aria-pressed={theme==='light'}>
                  <span className="app-sw sw-light" aria-hidden="true" />
                  Light
                </button>
                <button type="button" className={`app-tile${theme==='dark' ? ' on' : ''}`} onClick={()=>setTheme('dark')} aria-pressed={theme==='dark'}>
                  <span className="app-sw sw-dark" aria-hidden="true" />
                  Dark
                </button>
                <button type="button" className={`app-tile${theme.startsWith('glass') ? ' on' : ''}`} onClick={()=>setTheme(isDarkAppearance ? 'glass-dark' : 'glass-light')} aria-pressed={theme.startsWith('glass')}>
                  <span className="app-sw sw-glass" aria-hidden="true" />
                  Glass
                </button>
              </div>
              {theme.startsWith('glass') && (
                <div className="app-flavor">
                  <span className="app-flavor-lbl">Glass in</span>
                  <button type="button" className={`app-flavor-btn${theme==='glass-light' ? ' on' : ''}`} onClick={()=>setTheme('glass-light')}>Light</button>
                  <button type="button" className={`app-flavor-btn${theme==='glass-dark' ? ' on' : ''}`} onClick={()=>setTheme('glass-dark')}>Dark</button>
                  <span className="app-flavor-note">Frosted surfaces · standard modes stay untouched</span>
                </div>
              )}
            </div>

            <div className="sp-section-label">Earnings</div>
            <div className="sp-card">
              <div className="sp-rh">
                <div className="sp-rh-head">
                  <span className="sp-row-title">Daily rate</span>
                  <span className="sp-row-sub">A new rate applies to days logged from its start date — locked months never change</span>
                </div>
                {(rateDraft || []).map((p, i) => (
                  <div className={`sp-rh-row${p.from > todayKey ? ' future' : ''}`} key={p.from}>
                    <div className="sp-rh-main">
                      <span className="sp-rh-rate">{formatNaira(p.dailyRate)}<em> / day</em></span>
                      <span className="sp-rh-sub">weekend ×{p.weekendMultiplier} · holiday ×{p.holidayMultiplier} · {i === 0 ? 'since' : 'from'} {shortDate(p.from)}</span>
                    </div>
                    {i === (rateDraft || []).length - 1 && p.from <= todayKey && <span className="sp-rh-pill">current</span>}
                    {p.from > todayKey && <span className="sp-rh-pill soon">starts {shortDate(p.from)}</span>}
                    {i > 0 && (
                      <button type="button" className="sp-rh-del" onClick={()=>removeRateDraft(i)} title="Remove this rate change" aria-label="Remove this rate change">
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"><path d="M18 6 6 18M6 6l12 12"/></svg>
                      </button>
                    )}
                  </div>
                ))}
                {rateForm ? (
                  <div className="sp-rh-form">
                    <div className="sp-rh-frow">
                      <span className="sp-rh-flabel">From</span>
                      <input type="date" className="sp-rh-fdate" value={rateForm.from} onChange={e=>setRateForm(f => (f ? { ...f, from: e.target.value } : f))} aria-label="Rate change starts on" />
                    </div>
                    <div className="sp-rh-frow">
                      <span className="sp-rh-flabel">New daily rate</span>
                      <span className="sp-input-wrap sp-rh-frate"><span className="sp-input-prefix">₦</span><input className="sp-input" value={rateForm.rate} onChange={e=>setRateForm(f => (f ? { ...f, rate: e.target.value.replace(/[^0-9,]/g, '') } : f))} inputMode="numeric" placeholder="18000" aria-label="New daily rate" /></span>
                    </div>
                    <div className="sp-rh-factions">
                      <button type="button" className="sp-rh-cancel" onClick={()=>setRateForm(null)}>Cancel</button>
                      <button type="button" className="btn-primary sp-rh-apply" onClick={applyRateForm} disabled={!rateFormValid()}>Add rate change</button>
                    </div>
                  </div>
                ) : (
                  <button type="button" className="sp-rh-add" onClick={()=>setRateForm({ from: todayKey, rate: '' })}>+ Add rate change</button>
                )}
                <div className="sp-rh-truth">
                  {prevMonthTotal > 0 && <span className="sp-rh-chip">🔒 {getMonthName(realMonth === 0 ? 11 : realMonth - 1, true)} · {formatNaira(prevMonthTotal)} · frozen</span>}
                  <span className="sp-rh-chip">Now · {formatNaira(rateForPeriod(rateDraft || [], todayKey, settings).dailyRate)}/day</span>
                  {(rateDraft || []).filter(p => p.from > todayKey).slice(0, 1).map(p => (
                    <span className="sp-rh-chip hi" key={p.from}>{shortDate(p.from)} → {formatNaira(p.dailyRate)}</span>
                  ))}
                </div>
              </div>
              <div className="sp-row">
                <span className="sp-icon"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.2" fill="currentColor"/></svg></span>
                <span className="sp-row-main">
                  <span className="sp-row-title">Monthly goal</span>
                  <span className="sp-row-sub">Drives the progress ring in your summary</span>
                </span>
                <span className="sp-input-wrap"><span className="sp-input-prefix">₦</span><input className="sp-input" value={goalInput} onChange={e=>setGoalInput(e.target.value.replace(/[^0-9,]/g,''))} inputMode="numeric" placeholder="500000" /></span>
              </div>
              <div className="sp-row">
                <span className="sp-icon"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"><rect x="3" y="4" width="18" height="17" rx="2.5"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg></span>
                <span className="sp-row-main">
                  <span className="sp-row-title">Payday</span>
                  <span className="sp-row-sub">Day of month you get paid · 0 = last day</span>
                </span>
                <span className="sp-input-wrap sp-input-day"><input className="sp-input" value={paydayInput} onChange={e=>setPaydayInput(e.target.value.replace(/[^0-9]/g,''))} inputMode="numeric" placeholder="0" /></span>
              </div>
            </div>

            <div className="sp-section-label">Your data</div>
            <div className="sp-card sp-export">
              <div className="sp-export-head">
                <span className="sp-export-title">Export my data</span>
                <span className="sp-export-sub">Every day, rate and setting — as a file you own.</span>
              </div>
              <div className="sp-export-row">
                <button type="button" className="sp-export-btn primary" onClick={handleExportJson}>⬇ JSON · everything</button>
                <button type="button" className="sp-export-btn ghost" onClick={handleExportCsv}>⬇ CSV · one row per day</button>
              </div>
              <p className="sp-hint">One row per worked day — rate is that day's own rate, amount is what it actually paid, even after rate changes. JSON carries every record and setting for a full restore.</p>
            </div>

            <div className="sp-section-label">Leave types</div>
            <div className="sp-card sp-lt-card">
              <div className="lt-list">
                {(ltDraft || []).map((t, i) => (
                  <div className="lt-row" key={t.id}>
                    <input className="lt-name" value={t.name} onChange={e=>updateLtDraft(i, {name: e.target.value})} placeholder="Leave name" maxLength={40} />
                    <div className="lt-pay">
                      <button type="button" className={`lt-mode ${t.payMode!=='flat'?'on':''}`} onClick={()=>updateLtDraft(i, {payMode: t.payMode==='flat'?'percent':'flat'})} title="Toggle: % of daily rate / flat ₦ per day">{t.payMode==='flat' ? '₦' : '%'}</button>
                      <input className="lt-value" inputMode="decimal" value={t.payValue} onChange={e=>updateLtDraft(i, {payValue: e.target.value.replace(/[^0-9.]/g,'')})} title={t.payMode==='flat' ? 'Flat ₦ per leave day' : '% of your daily rate'} />
                    </div>
                    <button type="button" className="lt-del" onClick={()=>removeLtDraft(i)} title="Delete this leave type">
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6 6 18M6 6l12 12"/></svg>
                    </button>
                  </div>
                ))}
                <button type="button" className="lt-add" onClick={addLtDraft}>+ Add leave type</button>
              </div>
            </div>
            <p className="sp-hint"><strong>%</strong> of daily rate (50 = half pay) · <strong>₦</strong> flat per day · logged days keep their amounts.</p>

            <button type="button" className="dp-fold" onClick={()=>setSpFold(f=>({...f, pay:!f.pay}))} aria-expanded={spFold.pay}>
              <span className="dp-fold-main">
                <span className="dp-fold-title">Your pay rates</span>
                <span className="dp-fold-sum">Regular {formatNaira(settings.dailyRate)} · 2× {formatNaira(settings.dailyRate*settings.weekendMultiplier)}</span>
              </span>
              <span className={`dp-fold-chev${spFold.pay ? ' open' : ''}`} aria-hidden="true">▸</span>
            </button>
            {spFold.pay && (
              <div className="sp-card dp-fold-body">
                <div className="sp-kv"><span>Regular (OK)</span><span className="sp-kv-val">{formatNaira(settings.dailyRate)}</span></div>
                <div className="sp-kv"><span>Weekend (2×)</span><span className="sp-kv-val">{formatNaira(settings.dailyRate*settings.weekendMultiplier)}</span></div>
                <div className="sp-kv"><span>Overtime (OT 2×)</span><span className="sp-kv-val">{formatNaira(settings.dailyRate*settings.weekendMultiplier)}</span></div>
                <div className="sp-kv"><span>Holiday (HOL 2×)</span><span className="sp-kv-val">{formatNaira(settings.dailyRate*settings.holidayMultiplier)}</span></div>
                {leaveTypes.map(t => (
                  <div className="sp-kv" key={`ib-${t.id}`}><span>{t.name}</span><span className="sp-kv-val">{t.payMode!=='flat' ? `${t.payValue}% · ` : ''}{formatNaira(leavePayFor(t, settings.dailyRate))}</span></div>
                ))}
                <p className="sp-hint">Weekdays: OK → edit to OT · Weekends auto 2× · Holidays auto HOL 2× (Nigeria).</p>
              </div>
            )}

            <button type="button" className="dp-fold" onClick={()=>setSpFold(f=>({...f, track:!f.track}))} aria-expanded={spFold.track}>
              <span className="dp-fold-main">
                <span className="dp-fold-title">Tracking</span>
                <span className="dp-fold-sum">{getMonthName(realMonth, true)} {realYear} · {isSupabaseConfigured ? (user ? 'Synced' : 'Sync ready — sign in') : 'Local only'}</span>
              </span>
              <span className={`dp-fold-chev${spFold.track ? ' open' : ''}`} aria-hidden="true">▸</span>
            </button>
            {spFold.track && (
              <div className="sp-card dp-fold-body">
                <div className="sp-kv"><span>Current month</span><span className="sp-kv-val">{getMonthName(realMonth)} {realYear} · Active</span></div>
                <div className="sp-kv"><span>Tracking started</span><span className="sp-kv-val">{startMonthKey || 'Not set'}</span></div>
                <div className="sp-kv"><span>Cloud sync</span><span className="sp-kv-val" style={{color: isSupabaseConfigured ? 'var(--green-ink)' : 'var(--danger)'}}>{isSupabaseConfigured ? (user ? 'Connected' : 'Ready — sign in') : 'Not configured'}</span></div>
                <div className="sp-notes">
                  <span>• Only the current month is editable</span>
                  <span>• Previous months lock with final salary preserved</span>
                  <span>• Holidays auto-detected (Nigeria) with HOL stamp</span>
                  <span>• PWA: installable, offline-ready</span>
                </div>
              </div>
            )}

            <div className="sp-storage">DayPay — Know what your work is worth. {isSupabaseConfigured && user ? `Synced for ${displayName || user.email}.` : 'Local.'} PWA ready. © 2026 Akaninyene — All rights reserved.</div>
          </div>

          <div className="sp-savebar">
            <span className="sp-savebar-note">Changes apply on save</span>
            <button className="btn-primary sp-save-btn" onClick={handleSaveRate}>Save changes</button>
          </div>
        </div>
      )}

      {showAuth && (
        <div className="modal-overlay" onClick={()=>{setShowAuth(false); setShowForgot(false); setForgotSent(false)}}>
          <div className="modal" onClick={e=>e.stopPropagation()}>
            <div className="modal-header">
              <div style={{display:'flex', alignItems:'center', gap:10}}>
                <svg className="hdr-mark" viewBox="0 0 48 48" width="21" height="21" role="img" aria-label="DayPay logo">
                  <rect x="15" y="16" width="26" height="26" rx="7" fill="var(--daypay-green)"/>
                  <rect x="7" y="8" width="26" height="26" rx="7" fill={isDarkAppearance ? '#0D1424' : '#FFFFFF'} stroke={isDarkAppearance ? '#2A3550' : '#0B1B32'} strokeWidth="4"/>
                </svg>
                <span>{showForgot ? 'Reset password' : authMode==='signin' ? 'Sign in to DayPay' : 'Create DayPay account'}</span>
              </div>
              <button className="icon-btn small" onClick={()=>{setShowAuth(false); setShowForgot(false); setForgotSent(false)}}><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M18 6 6 18M6 6l12 12"/></svg></button>
            </div>
            <div className="modal-body">
              <div style={{textAlign:'center', marginBottom:18}}>
                <span className="hdr-lockup" style={{justifyContent:'center', marginBottom:8}} title="DayPay - Know what your work is worth.">
                  <svg className="hdr-mark" viewBox="0 0 48 48" width="30" height="30" role="img" aria-label="DayPay logo">
                    <rect x="15" y="16" width="26" height="26" rx="7" fill="var(--daypay-green)"/>
                    <rect x="7" y="8" width="26" height="26" rx="7" fill={isDarkAppearance ? '#0D1424' : '#FFFFFF'} stroke={isDarkAppearance ? '#2A3550' : '#0B1B32'} strokeWidth="4"/>
                  </svg>
                  <span className="wordmark" style={{fontSize:'21px'}}><span className="wm-day">Day</span><span className="wm-pay">Pay</span></span>
                </span>
                <div className="daypay-tagline">Know what your work is worth.</div>
              </div>
              {!showForgot ? (
                <form onSubmit={handleAuthSubmit}>
                  {authMode==='signup' && (
                    <>
                      <label className="field-label">Full name</label>
                      <div className="field-wrap" style={{marginBottom:12}}>
                        <input className="field-input" type="text" required value={authForm.name} onChange={e=>setAuthForm({...authForm, name:e.target.value})} placeholder="e.g. John Doe" />
                      </div>
                    </>
                  )}
                  <label className="field-label">Email</label>
                  <div className="field-wrap" style={{marginBottom:12}}>
                    <input className="field-input" type="email" required value={authForm.email} onChange={e=>setAuthForm({...authForm, email:e.target.value})} placeholder="you@example.com" />
                  </div>
                  <label className="field-label">Password</label>
                  <div className="field-wrap">
                    <input className="field-input" type="password" required minLength={6} value={authForm.password} onChange={e=>setAuthForm({...authForm, password:e.target.value})} placeholder="••••••••" />
                  </div>
                  {authMode==='signin' && (
                    <button type="button" className="link-btn" onClick={()=>{setShowForgot(true); setForgotEmail(authForm.email); setForgotSent(false); setAuthError('')}}>Forgot password?</button>
                  )}
                  {authError && <div className="auth-error">{authError}</div>}
                  <div className="modal-actions" style={{marginTop:18}}>
                    <button type="button" className="btn-secondary" onClick={()=>setAuthMode(authMode==='signin'?'signup':'signin')}>{authMode==='signin' ? 'Need account? Sign up' : 'Have account? Sign in'}</button>
                    <button type="submit" className="btn-primary" disabled={authBusy}>{authBusy ? 'Please wait…' : authMode==='signin' ? 'Sign in' : 'Sign up'}</button>
                  </div>
                </form>
              ) : (
                <form onSubmit={handleForgotPassword}>
                  <label className="field-label">Reset password</label>
                  <p className="field-hint" style={{marginBottom:12}}>Enter email for reset link.</p>
                  <div className="field-wrap" style={{marginBottom:12}}>
                    <input className="field-input" type="email" required value={forgotEmail} onChange={e=>setForgotEmail(e.target.value)} placeholder="you@example.com" />
                  </div>
                  {forgotSent ? <div className="success-banner">✅ Reset link sent! Check email.</div> : authError && <div className="auth-error">{authError}</div>}
                  <div className="modal-actions" style={{marginTop:18}}>
                    <button type="button" className="btn-secondary" onClick={()=>setShowForgot(false)}>Back</button>
                    <button type="submit" className="btn-primary" disabled={forgotBusy || forgotSent}>{forgotBusy ? 'Sending…' : forgotSent ? 'Sent ✓' : 'Send link'}</button>
                  </div>
                </form>
              )}
            </div>
          </div>
        </div>
      )}

      {showRecovery && (
        <div className="modal-overlay" onClick={()=>setShowRecovery(false)}>
          <div className="modal" onClick={e=>e.stopPropagation()}>
            <div className="modal-header"><span>Set new password</span><button className="icon-btn small" onClick={()=>setShowRecovery(false)}><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M18 6 6 18M6 6l12 12"/></svg></button></div>
            <div className="modal-body">
              <form onSubmit={handleRecoverySubmit}>
                <label className="field-label">New password</label>
                <div className="field-wrap" style={{marginBottom:12}}>
                  <input className="field-input" type="password" required minLength={6} value={newPassword} onChange={e=>setNewPassword(e.target.value)} placeholder="••••••••" />
                </div>
                {recoveryError && <div className="auth-error">{recoveryError}</div>}
                <div className="modal-actions" style={{marginTop:18}}>
                  <button type="button" className="btn-secondary" onClick={()=>setShowRecovery(false)}>Cancel</button>
                  <button type="submit" className="btn-primary" disabled={recoveryBusy}>{recoveryBusy ? 'Saving…' : 'Save'}</button>
                </div>
              </form>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
