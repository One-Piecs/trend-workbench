import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { createLongbridgeHubStream } from './longbridge-hub-stream.mjs';

function makeMockHarness(caps) {
  const sockets = [];
  let wsAttempt = 0;

  class FakeWebSocket {
    constructor(url) {
      this.url = url;
      this.sent = [];
      this.closed = false;
      this.listeners = new Map();
      wsAttempt++;
      sockets.push(this);
      queueMicrotask(() => {
        if (!this.closed) {
          this.emit('open', {});
          this.emit('message', { data: JSON.stringify({ type: 'welcome', version: 1 }) });
        }
      });
    }
    addEventListener(type, fn) {
      const list = this.listeners.get(type) ?? [];
      list.push(fn);
      this.listeners.set(type, list);
    }
    emit(type, payload) {
      for (const fn of this.listeners.get(type) ?? []) fn(payload);
    }
    send(raw) {
      const msg = JSON.parse(raw);
      this.sent.push(msg);
      if (msg.action === 'subscribe') {
        queueMicrotask(() => this.emit('message', { data: JSON.stringify({ type: 'ack', action: 'subscribe', symbols: msg.symbols, channels: msg.channels }) }));
      } else if (msg.action === 'subscribe_candlesticks') {
        queueMicrotask(() => this.emit('message', { data: JSON.stringify({ type: 'ack', action: 'subscribe_candlesticks', symbol: msg.symbol, period: msg.period }) }));
      }
    }
    close() {
      this.closed = true;
    }
    drop() {
      this.closed = true;
      this.emit('close', {});
    }
  }

  const stream = createLongbridgeHubStream({
    getConfig: () => ({ baseUrl: 'http://127.0.0.1:44130', token: 'hub-secret-token' }),
    getCapabilities: async () => caps,
    createWebSocket: url => new FakeWebSocket(url),
    keepaliveMs: 60_000,
    idleDisconnectMs: 0,
  });

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    if (url.pathname === '/api/live-stream') {
      await stream.handleRequest(req, res, url, {
        parseMarket: v => {
          if (['crypto', 'us', 'hk', 'cn', 'commodity'].includes(v)) return v;
          throw new Error('invalid market');
        },
        parseInterval: v => v,
        normalizeSymbol: (_m, s) => s.trim().toUpperCase(),
        toLongbridgeTicker: (m, s) => (m === 'hk' ? `${s.replace(/\.HK$/, '').replace(/^0+/, '')}.HK` : m === 'us' ? `${s.replace(/-/g, '.')}.US` : s.endsWith('.BJ') ? null : s),
      });
      return;
    }
    res.writeHead(404).end();
  });

  return { server, stream, sockets, getAttemptCount: () => wsAttempt };
}

function openSse(port, path) {
  return new Promise((resolve, reject) => {
    const events = [];
    let buffer = '';
    const req = http.get({ host: '127.0.0.1', port, path }, res => {
      res.setEncoding('utf8');
      if (res.statusCode !== 200) {
        let body = '';
        res.on('data', c => { body += c; });
        res.on('end', () => resolve({ status: res.statusCode, body, events, close: () => {} }));
        return;
      }
      res.on('data', chunk => {
        buffer += chunk;
        let idx;
        while ((idx = buffer.indexOf('\n\n')) !== -1) {
          const frame = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          const evLine = frame.split('\n').find(l => l.startsWith('event: '));
          const dataLine = frame.split('\n').find(l => l.startsWith('data: '));
          if (evLine && dataLine) {
            events.push({ event: evLine.slice(7), data: JSON.parse(dataLine.slice(6)) });
          }
        }
      });
      resolve({
        status: 200,
        events,
        close: () => { res.destroy(); req.destroy(); },
      });
    });
    req.on('error', reject);
  });
}

async function waitFor(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise(r => setTimeout(r, 10));
  }
  throw new Error('Timed out waiting for condition');
}

test('longbridge-hub-stream bridges WS quotes and candles into SSE, shares subscriptions, reconnects, and gates CN realtime', async () => {
  const caps = {
    configured: true,
    ready: true,
    status: 'connected',
    usRealtime: true,
    hkRealtime: true,
    cnRealtime: false,
    packages: [],
  };
  const h = makeMockHarness(caps);
  h.server.listen(0, '127.0.0.1');
  await once(h.server, 'listening');
  const port = h.server.address().port;

  try {
    // 1. Rejects CN when cnRealtime === false without opening upstream WS
    const cnRejected = await openSse(port, '/api/live-stream?market=cn&symbol=600519.SH&interval=1m&source=' + encodeURIComponent('Longbridge OpenAPI A股实时行情 · open.longbridge.com'));
    assert.equal(cnRejected.status, 503);
    assert.equal(h.sockets.length, 0);

    // 2. Opens WS once for 2 SSE clients watching the same HK topic
    const ssePath = '/api/live-stream?market=hk&symbol=00700.HK&interval=1m&source=' + encodeURIComponent('Longbridge OpenAPI 港股行情 · open.longbridge.com');
    const c1 = await openSse(port, ssePath);
    const c2 = await openSse(port, ssePath);
    assert.equal(c1.status, 200);
    assert.equal(c2.status, 200);

    await waitFor(() => h.sockets.length === 1 && h.sockets[0].sent.length >= 2);
    const ws = h.sockets[0];
    assert.match(ws.url, /^ws:\/\/127\.0\.0\.1:44130\/v1\/stream\?token=hub-secret-token$/);
    assert.deepEqual(ws.sent[0], { action: 'subscribe', symbols: ['700.HK'], channels: ['quote'] });
    assert.deepEqual(ws.sent[1], { action: 'subscribe_candlesticks', symbol: '700.HK', period: '1m', session: 'intraday' });

    // Broadcast candlestick & quote to both SSE clients
    const t = Date.parse('2026-11-25T02:05:00Z') / 1000;
    ws.emit('message', {
      data: JSON.stringify({
        type: 'candlestick',
        symbol: '700.HK',
        period: '1m',
        isConfirmed: false,
        candlestick: { time: t, timestamp: '2026-11-25T02:05:00Z', open: 410, high: 412, low: 409.5, close: 411.8, volume: 1200, turnover: 493000, session: 'Intraday' },
      }),
    });
    ws.emit('message', {
      data: JSON.stringify({
        type: 'quote',
        symbol: '700.HK',
        data: { symbol: '700.HK', market: 'HK', lastDone: 412.1, open: 410, high: 412.1, low: 409.5, timestamp: '2026-11-25T02:05:05Z', time: t + 5, volume: 1250, turnover: 515000, tradeStatus: 'Normal', tradeSession: 'Intraday', currentVolume: 50, currentTurnover: 20600 },
      }),
    });

    await waitFor(() => c1.events.some(e => e.event === 'quote') && c2.events.some(e => e.event === 'quote'));
    assert.equal(c1.events.find(e => e.event === 'candle')?.data.candle.close, 411.8);
    assert.equal(c2.events.find(e => e.event === 'quote')?.data.quote.price, 412.1);

    // 3. Reconnects and resubscribes on upstream drop
    ws.drop();
    await waitFor(() => c1.events.some(e => e.event === 'status' && e.data.status === 'fallback'));
    await waitFor(() => h.sockets.length === 2 && h.sockets[1].sent.length >= 2, 3000);
    assert.deepEqual(h.sockets[1].sent[0], { action: 'subscribe', symbols: ['700.HK'], channels: ['quote'] });

    // Closing 1 client keeps upstream alive; closing last client disconnects cleanly
    c1.close();
    await new Promise(r => setTimeout(r, 30));
    assert.equal(h.sockets[1].closed, false);
    c2.close();
    await waitFor(() => h.sockets[1].closed === true);

    // 4. Enabling cnRealtime allows CN stream
    caps.cnRealtime = true;
    const cnOk = await openSse(port, '/api/live-stream?market=cn&symbol=600519.SH&interval=1m&source=' + encodeURIComponent('Longbridge OpenAPI A股实时行情 · open.longbridge.com'));
    assert.equal(cnOk.status, 200);
    await waitFor(() => h.sockets.length === 3 && h.sockets[2].sent.some(m => m.symbol === '600519.SH'));
    cnOk.close();
  } finally {
    h.stream.close();
    h.server.close();
    h.server.closeAllConnections?.();
  }
});
