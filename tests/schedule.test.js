import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    scheduleTick,
    localDateKey,
    msUntilNextOccurrence,
    formatCountdown,
    formatClock12,
    formatDays,
} from '../frontend/src/utils/schedule.js';

// Build a local Date for a fixed clock time on 2026-07-27 (a Monday).
const at = (h, m, s = 0) => new Date(2026, 6, 27, h, m, s, 0);

test('scheduleTick fires within the grace window at the target time', () => {
    const sched = { time: '16:00', mode: 'once', enabled: true, lastFiredDate: null };
    assert.equal(scheduleTick(sched, at(16, 0, 0)).shouldFire, true);
    assert.equal(scheduleTick(sched, at(16, 1, 30)).shouldFire, true); // still inside 120s grace
});

test('scheduleTick does not fire before the target', () => {
    const sched = { time: '16:00', mode: 'once', enabled: true, lastFiredDate: null };
    assert.equal(scheduleTick(sched, at(15, 59, 59)).shouldFire, false);
});

test('scheduleTick does not fire after the grace window (stale cue)', () => {
    const sched = { time: '16:00', mode: 'daily', enabled: true, lastFiredDate: null };
    assert.equal(scheduleTick(sched, at(16, 5, 0)).shouldFire, false);
});

test('scheduleTick respects enabled flag', () => {
    const sched = { time: '16:00', mode: 'daily', enabled: false, lastFiredDate: null };
    assert.equal(scheduleTick(sched, at(16, 0, 0)).shouldFire, false);
});

test('once schedule never re-fires after lastFiredDate set', () => {
    const sched = { time: '16:00', mode: 'once', enabled: true, lastFiredDate: '2026-07-20' };
    assert.equal(scheduleTick(sched, at(16, 0, 0)).shouldFire, false);
});

test('daily schedule de-dupes within the same day but the helper stays eligible other days', () => {
    const firedToday = { time: '16:00', mode: 'daily', enabled: true, lastFiredDate: localDateKey(at(16, 0, 0)) };
    assert.equal(scheduleTick(firedToday, at(16, 0, 30)).shouldFire, false);
    const firedYesterday = { time: '16:00', mode: 'daily', enabled: true, lastFiredDate: '2026-07-26' };
    assert.equal(scheduleTick(firedYesterday, at(16, 0, 0)).shouldFire, true);
});

test('secondsUntil rolls to tomorrow once the time has passed', () => {
    const sched = { time: '16:00', mode: 'daily', enabled: true, lastFiredDate: null };
    // 15 minutes before -> 900s
    assert.equal(scheduleTick(sched, at(15, 45, 0)).secondsUntil, 900);
    // just after target -> next occurrence is ~24h out
    const secs = scheduleTick(sched, at(16, 5, 0)).secondsUntil;
    assert.ok(secs > 23 * 3600 && secs <= 24 * 3600, `expected ~24h, got ${secs}`);
});

test('weekly schedule fires only on selected weekdays', () => {
    const today = at(16, 0).getDay();
    const otherDay = (today + 1) % 7;
    const onToday = { time: '16:00', mode: 'weekly', days: [today], enabled: true, lastFiredDate: null };
    const onOther = { time: '16:00', mode: 'weekly', days: [otherDay], enabled: true, lastFiredDate: null };
    assert.equal(scheduleTick(onToday, at(16, 0, 30)).shouldFire, true);
    assert.equal(scheduleTick(onOther, at(16, 0, 30)).shouldFire, false);
});

test('weekly schedule de-dupes within the day and counts down to the next selected day', () => {
    const today = at(16, 0).getDay();
    const firedToday = { time: '16:00', mode: 'weekly', days: [today], enabled: true, lastFiredDate: localDateKey(at(16, 0)) };
    const tick = scheduleTick(firedToday, at(16, 0, 30));
    assert.equal(tick.shouldFire, false);
    // Only day selected is today -> next occurrence is 7 days out.
    assert.ok(tick.secondsUntil > 6 * 86400, `expected ~7d, got ${tick.secondsUntil}`);
});

test('weekly with empty days never fires', () => {
    const sched = { time: '16:00', mode: 'weekly', days: [], enabled: true, lastFiredDate: null };
    const tick = scheduleTick(sched, at(16, 0, 30));
    assert.equal(tick.shouldFire, false);
    assert.equal(tick.secondsUntil, null);
});

test('formatDays produces friendly labels', () => {
    assert.equal(formatDays([1, 2, 3, 4, 5]), 'Weekdays');
    assert.equal(formatDays([0, 6]), 'Weekends');
    assert.equal(formatDays([0, 1, 2, 3, 4, 5, 6]), 'Every day');
    assert.equal(formatDays([1, 3]), 'Mon, Wed');
    assert.equal(formatDays([]), '');
});

test('invalid time string is inert', () => {
    assert.deepEqual(scheduleTick({ time: '', mode: 'once', enabled: true }, at(16, 0)), { secondsUntil: null, shouldFire: false });
    assert.equal(msUntilNextOccurrence('nope'), null);
});

test('formatCountdown renders coarse labels', () => {
    assert.equal(formatCountdown(0), 'firing…');
    assert.equal(formatCountdown(45), 'in 45s');
    assert.equal(formatCountdown(125), 'in 2m 5s');
    assert.equal(formatCountdown(3720), 'in 1h 2m');
});

test('formatClock12 converts 24h to 12h', () => {
    assert.equal(formatClock12('16:05'), '4:05 PM');
    assert.equal(formatClock12('00:00'), '12:00 AM');
    assert.equal(formatClock12('09:30'), '9:30 AM');
});
