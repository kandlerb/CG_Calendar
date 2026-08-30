import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  addMonths,
  formatTime,
  formatTimeRange,
  isoDate,
  monthGrid,
  normalizeTime,
  parseISODate,
  startOfMonth,
} from '../public/lib/dates.js';

describe('dates', () => {
  it('formats and parses a local calendar day without shifting it', () => {
    const d = parseISODate('2026-09-02');
    assert.equal(d.getFullYear(), 2026);
    assert.equal(d.getMonth(), 8);
    assert.equal(d.getDate(), 2);
    assert.equal(isoDate(d), '2026-09-02');
  });

  it('pads single-digit months and days', () => {
    assert.equal(isoDate(new Date(2026, 0, 5)), '2026-01-05');
  });

  it('normalizes the time shapes Postgres and forms produce', () => {
    assert.equal(normalizeTime('18:30:00'), '18:30');
    assert.equal(normalizeTime('18:30'), '18:30');
    assert.equal(normalizeTime('9:05'), '09:05');
    assert.equal(normalizeTime(null), '');
    assert.equal(normalizeTime(''), '');
  });

  it('formats times around noon and midnight', () => {
    assert.equal(formatTime('00:00'), '12 AM');
    assert.equal(formatTime('12:00'), '12 PM');
    assert.equal(formatTime('12:05'), '12:05 PM');
    assert.equal(formatTime('18:30:00'), '6:30 PM');
    assert.equal(formatTime(''), '');
  });

  it('describes a time range', () => {
    assert.equal(formatTimeRange({ startTime: '18:30', endTime: '20:30' }), '6:30 PM – 8:30 PM');
    assert.equal(formatTimeRange({ startTime: '18:30', endTime: '' }), '6:30 PM');
    assert.equal(formatTimeRange({ startTime: '', endTime: '' }), 'Time TBD');
  });

  it('steps months without landing on the 31st of a short month', () => {
    assert.equal(isoDate(addMonths(new Date(2026, 0, 31), 1)), '2026-02-01');
    assert.equal(isoDate(addMonths(new Date(2026, 0, 1), -1)), '2025-12-01');
  });

  it('builds a grid of whole weeks covering exactly the month', () => {
    for (const [year, month, expectedWeeks] of [
      [2026, 1, 4], // February 2026 starts on a Sunday and has 28 days
      [2026, 7, 6], // August 2026 starts on a Saturday
      [2026, 8, 5],
    ]) {
      const grid = monthGrid(new Date(year, month, 1));
      assert.equal(grid.length, expectedWeeks, `${year}-${month + 1} week count`);
      for (const week of grid) assert.equal(week.length, 7);

      assert.equal(grid[0][0].date.getDay(), 0, 'weeks start on Sunday');
      const inMonth = grid.flat().filter((cell) => !cell.outside);
      const daysInMonth = new Date(year, month + 1, 0).getDate();
      assert.equal(inMonth.length, daysInMonth, 'every day of the month appears once');
      assert.equal(inMonth[0].dayOfMonth, 1);
      assert.equal(inMonth.at(-1).dayOfMonth, daysInMonth);
    }
  });

  it('marks today only once', () => {
    const grid = monthGrid(startOfMonth(new Date()));
    const todayKey = isoDate(new Date());
    assert.equal(grid.flat().filter((cell) => cell.key === todayKey).length, 1);
  });
});
