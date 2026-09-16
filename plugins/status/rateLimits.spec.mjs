import { describe, expect, it } from 'vitest';
import { headroomLabel, limitRow, paceVerdict, resetClock } from './rateLimits.mjs';

process.env.TZ = 'UTC';
/** A Saturday noon: far enough from midnight that clocks stay on one day. */
const NOW = Date.UTC(2026, 8, 5, 12, 0, 0);
const WINDOW = 300;
const resetIn = (minutes) => (NOW + minutes * 60_000) / 1000;

describe('paceVerdict boundaries', () => {
  it('calls burning only at a projected overshoot, not at a high percent', () => {
    // Half the window gone, half of it burned: linear pace exhausts exactly at reset.
    expect(paceVerdict({ used: 50, windowMinutes: WINDOW, resetEpochSec: resetIn(150), nowMs: NOW }))
      .toEqual({ verdict: 'burning', tone: 'danger' });
    // Same burn one point slower survives the window: amber, never red.
    expect(paceVerdict({ used: 49, windowMinutes: WINDOW, resetEpochSec: resetIn(150), nowMs: NOW }))
      .toEqual({ verdict: 'on pace', tone: 'warning' });
  });

  it('splits ahead from on pace at seventy percent of projected window', () => {
    expect(paceVerdict({ used: 35, windowMinutes: WINDOW, resetEpochSec: resetIn(150), nowMs: NOW }).verdict).toBe('on pace');
    expect(paceVerdict({ used: 34, windowMinutes: WINDOW, resetEpochSec: resetIn(150), nowMs: NOW }))
      .toEqual({ verdict: 'ahead', tone: 'positive' });
  });

  it('refuses to project a just-opened window', () => {
    // Ten elapsed minutes at 50% burned would project 15x over: noise, not pace.
    expect(paceVerdict({ used: 50, windowMinutes: WINDOW, resetEpochSec: resetIn(290), nowMs: NOW }).verdict)
      .not.toBe('burning');
  });

  it('marks exhausted and provider-limited windows danger', () => {
    expect(paceVerdict({ used: 100, windowMinutes: WINDOW, resetEpochSec: resetIn(150), nowMs: NOW }))
      .toEqual({ verdict: 'exhausted', tone: 'danger' });
    expect(paceVerdict({ used: 20, windowMinutes: WINDOW, resetEpochSec: resetIn(150), nowMs: NOW, limited: true }))
      .toEqual({ verdict: 'limited', tone: 'danger' });
  });

  it('caps tone at amber when no projection is possible', () => {
    const unknown = { used: 95, windowMinutes: undefined, resetEpochSec: resetIn(150), nowMs: NOW };
    expect(paceVerdict(unknown)).toEqual({ verdict: 'on pace', tone: 'warning' });
    const past = { used: 95, windowMinutes: WINDOW, resetEpochSec: resetIn(-30), nowMs: NOW };
    expect(paceVerdict(past).tone).toBe('warning');
  });
});

describe('resetClock', () => {
  it('reads as a clock, with a weekday past today', () => {
    expect(resetClock(resetIn(210), NOW)).toBe('3:30 PM');
    expect(resetClock(resetIn(3 * 24 * 60 + 210), NOW)).toBe('Tue 3:30 PM');
    expect(resetClock(Number.NaN, NOW)).toBe('');
  });
});

describe('limitRow', () => {
  it('leads with headroom and fits the chart detail slot', () => {
    const row = limitRow({ label: 'Rolling', used: 40, windowMinutes: WINDOW, resetEpochSec: resetIn(150), nowMs: NOW });
    expect(row.valueLabel).toBe('60% left');
    expect(row.detail).toBe('2:30 PM · on pace');
    expect(Buffer.byteLength(row.detail, 'utf8')).toBeLessThanOrEqual(24);
    expect(headroomLabel({ used: 40, windowMinutes: WINDOW, resetEpochSec: resetIn(150), nowMs: NOW }))
      .toBe('60% left · on pace · 2:30 PM');
  });
});
