// Pure scheduling helpers for the MediaPanel "Scheduled Plays" feature.
// Kept dependency-free so it can be unit-tested with `node --test`.

// How long after a target time a schedule may still fire. Prevents an app
// opened long after the scheduled moment from firing a stale cue.
export const GRACE_MS = 120 * 1000;

const TIME_RE = /^\d{1,2}:\d{2}$/;

// Local-time 'YYYY-MM-DD' key, used to de-dupe daily fires.
export function localDateKey(date = new Date()) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}

// Milliseconds from `now` until the next occurrence of "HH:MM" (today or,
// if already passed, tomorrow). Returns null for an invalid time string.
export function msUntilNextOccurrence(timeStr, now = new Date()) {
    if (!timeStr || !TIME_RE.test(timeStr)) return null;
    const [h, m] = timeStr.split(':').map(Number);
    const target = new Date(now);
    target.setHours(h, m, 0, 0);
    if (target.getTime() <= now.getTime()) target.setDate(target.getDate() + 1);
    return target.getTime() - now.getTime();
}

// Milliseconds of today's occurrence of "HH:MM" (not rolled forward).
function todayTargetMs(timeStr, now) {
    const [h, m] = timeStr.split(':').map(Number);
    const target = new Date(now);
    target.setHours(h, m, 0, 0);
    return target.getTime();
}

// Milliseconds until the next occurrence of "HH:MM" on one of the selected
// weekdays (`days`: array of 0=Sun..6=Sat). Returns null if none/invalid.
export function msUntilNextWeekly(timeStr, days, now = new Date()) {
    if (!timeStr || !TIME_RE.test(timeStr) || !Array.isArray(days) || days.length === 0) return null;
    const [h, m] = timeStr.split(':').map(Number);
    for (let i = 0; i < 8; i++) {
        const cand = new Date(now);
        cand.setDate(now.getDate() + i);
        cand.setHours(h, m, 0, 0);
        if (days.includes(cand.getDay()) && cand.getTime() > now.getTime()) {
            return cand.getTime() - now.getTime();
        }
    }
    return null;
}

// Evaluate a schedule at time `now`.
// Returns { secondsUntil, shouldFire }:
//  - secondsUntil: seconds until the next occurrence (for countdown display)
//  - shouldFire:   true only within the grace window after today's target,
//                  when enabled and not already fired for this occurrence.
export function scheduleTick(schedule, now = new Date()) {
    const result = { secondsUntil: null, shouldFire: false };
    if (!schedule || !schedule.time || !TIME_RE.test(schedule.time)) return result;

    const weekly = schedule.mode === 'weekly';
    const ms = weekly
        ? msUntilNextWeekly(schedule.time, schedule.days, now)
        : msUntilNextOccurrence(schedule.time, now);
    result.secondsUntil = ms == null ? null : Math.max(0, Math.round(ms / 1000));

    if (!schedule.enabled) return result;
    // A one-time schedule that has already fired never fires again.
    if (schedule.mode === 'once' && schedule.lastFiredDate) return result;
    // A weekly schedule only fires on its selected weekdays.
    if (weekly && (!Array.isArray(schedule.days) || !schedule.days.includes(now.getDay()))) return result;

    const todayKey = localDateKey(now);
    if (schedule.lastFiredDate === todayKey) return result; // already fired today (daily/weekly)

    const delta = now.getTime() - todayTargetMs(schedule.time, now);
    if (delta >= 0 && delta < GRACE_MS) result.shouldFire = true;

    return result;
}

// Human countdown label from secondsUntil.
export function formatCountdown(secondsUntil) {
    if (secondsUntil == null) return '';
    if (secondsUntil <= 0) return 'firing…';
    const h = Math.floor(secondsUntil / 3600);
    const m = Math.floor((secondsUntil % 3600) / 60);
    const s = secondsUntil % 60;
    if (h > 0) return `in ${h}h ${m}m`;
    if (m > 0) return `in ${m}m ${s}s`;
    return `in ${s}s`;
}

const DAY_ABBR = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// Compact label for a set of weekdays (0=Sun..6=Sat), e.g. "Mon, Wed",
// "Weekdays", "Weekends", or "Every day".
export function formatDays(days) {
    if (!Array.isArray(days) || days.length === 0) return '';
    const s = [...new Set(days)].sort((a, b) => a - b);
    if (s.length === 7) return 'Every day';
    if (s.length === 5 && [1, 2, 3, 4, 5].every(d => s.includes(d))) return 'Weekdays';
    if (s.length === 2 && s.includes(0) && s.includes(6)) return 'Weekends';
    return s.map(d => DAY_ABBR[d]).join(', ');
}

// Format "HH:MM" (24h) as a 12h label, e.g. "16:05" -> "4:05 PM".
export function formatClock12(timeStr) {
    if (!timeStr || !TIME_RE.test(timeStr)) return timeStr || '';
    let [h, m] = timeStr.split(':').map(Number);
    const ampm = h >= 12 ? 'PM' : 'AM';
    h = h % 12 || 12;
    return `${h}:${String(m).padStart(2, '0')} ${ampm}`;
}
