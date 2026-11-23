import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chartStamp, exchangeStamp, dualClockMarket } from '../lib/chart-time.ts';

// Force a fixed local zone so the assertions are machine-independent.
process.env.TZ = 'Asia/Shanghai';

test('US charts append the New York clock, including overnight sessions', () => {
  const overnight = Date.parse('2026-11-23T06:00:00Z') / 1000; // 14:00 Beijing = 01:00 New York
  const label = chartStamp(overnight, true, '15m', 'zh-CN', 'us');
  assert.ok(label.includes('14:00'), `local Beijing time expected: ${label}`);
  assert.ok(label.includes('01:00'), `New York time expected: ${label}`);
  assert.match(label, /11\/23/);
  // Overnight candles cross the NY calendar date boundary: 06:00Z Nov 23 is still Nov 22 evening in NY? (01:00 Nov 23)
  assert.ok(label.includes('·'), 'the exchange clock is appended after the local one');
});

test('DST shifts the exchange clock without changing the UTC instant', () => {
  const summer = Date.parse('2026-07-09T20:30:00Z') / 1000; // 04:30 +08 next day = 16:30 EDT
  const summerLabel = exchangeStamp(summer, true, '30m', 'zh-CN');
  const winter = Date.parse('2026-11-09T21:30:00Z') / 1000; // 05:30 +08 next day = 16:30 EST
  const winterLabel = exchangeStamp(winter, true, '30m', 'zh-CN');
  assert.ok(summerLabel.includes('16:30'), `EDT clock expected: ${summerLabel}`);
  assert.ok(winterLabel.includes('16:30'), `EST clock expected: ${winterLabel}`);
});

test('crypto and A-shares keep local-only labels', () => {
  const time = Date.parse('2026-11-23T06:00:00Z') / 1000;
  for (const market of ['crypto', 'cn', undefined] as const) {
    const label = chartStamp(time, true, '1h', 'zh-CN', market);
    assert.ok(!label.includes('·'), `no exchange suffix expected for ${String(market)}: ${label}`);
  }
  assert.equal(dualClockMarket('us'), true);
  assert.equal(dualClockMarket('cn'), false);
  assert.equal(dualClockMarket('crypto'), false);
});

test('calendar bars fall back to date-only exchange labels', () => {
  const day = Date.parse('2026-11-20T14:30:00-05:00') / 1000; // NY Nov 20 session
  const week = Date.parse('2026-11-16T14:30:00-05:00') / 1000;
  const month = Date.parse('2026-10-01T09:30:00-04:00') / 1000;
  assert.ok(exchangeStamp(day, false, '1d', 'zh-CN').includes('11/20'));
  assert.ok(exchangeStamp(week, false, '1w', 'zh-CN').includes('11/16'));
  assert.ok(exchangeStamp(month, false, '1M', 'zh-CN').includes('2026'), `month label expected: ${exchangeStamp(month, false, '1M', 'zh-CN')}`);
  assert.ok(exchangeStamp(month, false, '1M', 'zh-CN').includes('10'), `month label expected: ${exchangeStamp(month, false, '1M', 'zh-CN')}`);
});
