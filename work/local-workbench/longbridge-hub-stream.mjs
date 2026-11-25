const SESSION_MAP = {
  Intraday: 'regular',
  Pre: 'pre',
  Post: 'post',
  Overnight: 'overnight',
};

const CURRENCY_MAP = {
  us: 'USD',
  hk: 'HKD',
  cn: 'CNY',
};

function writeSse(res, event, data) {
  if (res.writableEnded || res.destroyed) return false;
  try {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    return true;
  } catch {
    return false;
  }
}

function writeJson(res, status, value) {
  if (res.writableEnded || res.destroyed) return;
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(value));
}

function mapQuoteSnapshot(client, data, nowMs) {
  if (!data || typeof data !== 'object') return null;
  const nowSec = Math.floor(nowMs / 1000);
  if (client.market === 'us') {
    const candidates = [
      { session: 'overnight', sub: data.overnightQuote },
      { session: 'post', sub: data.postMarketQuote },
      { session: 'pre', sub: data.preMarketQuote },
    ]
      .filter(x => x.sub && Number.isFinite(Number(x.sub.lastDone)) && Number(x.sub.lastDone) > 0 && Number.isSafeInteger(x.sub.time))
      .sort((a, b) => Number(b.sub.time) - Number(a.sub.time));
    const latestExt = candidates[0];
    if (latestExt && (!Number.isSafeInteger(data.time) || Number(latestExt.sub.time) >= Number(data.time))) {
      return {
        market: 'us',
        symbol: client.symbol,
        currency: 'USD',
        time: Number(latestExt.sub.time),
        observedAt: nowSec,
        price: Number(latestExt.sub.lastDone),
        venue: 'Longbridge OpenAPI',
        provider: 'longbridge',
        quality: 'realtime',
        session: latestExt.session,
      };
    }
  }
  const price = Number(data.lastDone);
  if (!Number.isFinite(price) || price <= 0) return null;
  const quoteTime = Number.isSafeInteger(data.time) && data.time > 0 ? data.time : nowSec;
  return {
    market: client.market,
    symbol: client.symbol,
    currency: CURRENCY_MAP[client.market],
    time: quoteTime,
    observedAt: nowSec,
    price,
    venue: 'Longbridge OpenAPI',
    provider: 'longbridge',
    quality: 'realtime',
    session: 'regular',
  };
}

function mapPushQuote(client, data, nowMs) {
  if (!data || typeof data !== 'object') return null;
  const price = Number(data.lastDone);
  if (!Number.isFinite(price) || price <= 0) return null;
  const nowSec = Math.floor(nowMs / 1000);
  const quoteTime = Number.isSafeInteger(data.time) && data.time > 0 ? data.time : nowSec;
  const session = SESSION_MAP[data.tradeSession] ?? 'regular';
  return {
    market: client.market,
    symbol: client.symbol,
    currency: CURRENCY_MAP[client.market],
    time: quoteTime,
    observedAt: nowSec,
    price,
    venue: 'Longbridge OpenAPI',
    provider: 'longbridge',
    quality: 'realtime',
    session,
  };
}

function mapCandlestick(client, cs, isConfirmed) {
  if (!cs || typeof cs !== 'object') return null;
  const time = Number(cs.time);
  const open = Number(cs.open);
  const high = Number(cs.high);
  const low = Number(cs.low);
  const close = Number(cs.close);
  const volume = Number(cs.volume);
  if (!Number.isSafeInteger(time) || time <= 0 || ![open, high, low, close, volume].every(Number.isFinite) || low <= 0 || volume < 0) {
    return null;
  }
  return {
    time,
    open,
    high,
    low,
    close,
    volume,
    closed: Boolean(isConfirmed),
    ...(client.market === 'us' ? { session: SESSION_MAP[cs.session] ?? 'regular' } : {}),
  };
}

export function createLongbridgeHubStream({
  getConfig,
  getCapabilities,
  createWebSocket = url => new WebSocket(url),
  now = () => Date.now(),
  keepaliveMs = 15_000,
  idleDisconnectMs = 10_000,
} = {}) {
  let ws = null;
  let wsOpen = false;
  let closed = false;
  let reconnectAttempts = 0;
  let reconnectTimer = null;
  let idleTimer = null;
  let pingTimer = null;

  /** @type {Set<object>} */
  const clients = new Set();
  /** @type {Map<string, Set<object>>} */
  const quoteSubs = new Map();
  /** @type {Map<string, { ticker: string; period: string; session: string; clients: Set<object> }>} */
  const candleSubs = new Map();

  function clearTimers() {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
    clearTimeout(idleTimer);
    idleTimer = null;
    clearInterval(pingTimer);
    pingTimer = null;
  }

  function sendWs(payload) {
    if (!ws || !wsOpen) return false;
    try {
      ws.send(JSON.stringify(payload));
      return true;
    } catch {
      return false;
    }
  }

  function disconnectWs() {
    clearInterval(pingTimer);
    pingTimer = null;
    wsOpen = false;
    const current = ws;
    ws = null;
    if (!current) return;
    try {
      current.onopen = current.onmessage = current.onclose = current.onerror = null;
      current.close();
    } catch {}
  }

  function scheduleIdleDisconnect() {
    clearTimeout(idleTimer);
    if (clients.size > 0 || idleDisconnectMs <= 0) {
      if (clients.size === 0 && idleDisconnectMs <= 0) disconnectWs();
      return;
    }
    idleTimer = setTimeout(() => {
      idleTimer = null;
      if (clients.size === 0) disconnectWs();
    }, idleDisconnectMs);
    idleTimer.unref?.();
  }

  function scheduleReconnect() {
    if (closed || clients.size === 0 || reconnectTimer) return;
    const delay = Math.min(15_000, 1000 * 2 ** Math.min(reconnectAttempts++, 4));
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      ensureConnected();
    }, delay);
    reconnectTimer.unref?.();
  }

  function resubscribeAll() {
    if (quoteSubs.size > 0) {
      sendWs({
        action: 'subscribe',
        symbols: [...quoteSubs.keys()],
        channels: ['quote'],
      });
    }
    for (const entry of candleSubs.values()) {
      sendWs({
        action: 'subscribe_candlesticks',
        symbol: entry.ticker,
        period: entry.period,
        session: entry.session,
      });
    }
  }

  function handleWsMessage(raw) {
    let msg;
    try { msg = JSON.parse(typeof raw === 'string' ? raw : String(raw)); } catch { return; }
    if (!msg || typeof msg !== 'object') return;
    const eventTimeMs = now();

    if (msg.type === 'welcome' || msg.type === 'pong') return;

    if (msg.type === 'ack') {
      if (msg.action === 'subscribe' && Array.isArray(msg.symbols)) {
        for (const ticker of msg.symbols) {
          const set = quoteSubs.get(ticker);
          if (!set) continue;
          for (const client of set) writeSse(client.res, 'status', { status: 'live', time: eventTimeMs });
        }
      } else if (msg.action === 'subscribe_candlesticks' && typeof msg.symbol === 'string' && typeof msg.period === 'string') {
        const entry = candleSubs.get(`${msg.symbol}:${msg.period}`);
        if (entry) {
          for (const client of entry.clients) writeSse(client.res, 'status', { status: 'live', time: eventTimeMs });
        }
      }
      return;
    }

    if (msg.type === 'candlestick' && typeof msg.symbol === 'string' && typeof msg.period === 'string') {
      const entry = candleSubs.get(`${msg.symbol}:${msg.period}`);
      if (!entry) return;
      for (const client of entry.clients) {
        const candle = mapCandlestick(client, msg.candlestick, msg.isConfirmed);
        if (candle) {
          writeSse(client.res, 'candle', { candle, eventTimeMs });
        }
      }
      return;
    }

    if (msg.type === 'candlesticks_snapshot' && typeof msg.symbol === 'string' && typeof msg.period === 'string' && Array.isArray(msg.candlesticks)) {
      const last = msg.candlesticks.at(-1);
      if (!last) return;
      const entry = candleSubs.get(`${msg.symbol}:${msg.period}`);
      if (!entry) return;
      for (const client of entry.clients) {
        const candle = mapCandlestick(client, last, false);
        if (candle) {
          writeSse(client.res, 'candle', { candle, eventTimeMs });
        }
      }
      return;
    }

    if (msg.type === 'quote' && typeof msg.symbol === 'string') {
      const set = quoteSubs.get(msg.symbol);
      if (!set) return;
      for (const client of set) {
        const quote = mapPushQuote(client, msg.data, eventTimeMs);
        if (quote) writeSse(client.res, 'quote', { quote, eventTimeMs });
      }
      return;
    }

    if (msg.type === 'quote_snapshot' && typeof msg.symbol === 'string') {
      const set = quoteSubs.get(msg.symbol);
      if (!set) return;
      for (const client of set) {
        const quote = mapQuoteSnapshot(client, msg.data, eventTimeMs);
        if (quote) writeSse(client.res, 'quote', { quote, eventTimeMs });
      }
    }
  }

  function ensureConnected() {
    if (closed || ws || clients.size === 0) return;
    clearTimeout(idleTimer);
    idleTimer = null;
    const cfg = getConfig?.();
    if (!cfg?.baseUrl) return;
    const wsBase = cfg.baseUrl.replace(/^http/i, 'ws').replace(/\/+$/, '');
    const url = `${wsBase}/v1/stream${cfg.token ? `?token=${encodeURIComponent(cfg.token)}` : ''}`;
    let socket;
    try {
      socket = createWebSocket(url);
    } catch {
      scheduleReconnect();
      return;
    }
    ws = socket;
    wsOpen = false;

    const onOpen = () => {
      if (ws !== socket || closed) return;
      wsOpen = true;
      reconnectAttempts = 0;
      resubscribeAll();
      clearInterval(pingTimer);
      pingTimer = setInterval(() => {
        sendWs({ action: 'ping' });
      }, 20_000);
      pingTimer.unref?.();
    };
    const onMessage = event => {
      if (ws !== socket || closed) return;
      handleWsMessage(event?.data ?? event);
    };
    const onDrop = () => {
      if (ws !== socket) return;
      disconnectWs();
      const stamp = now();
      for (const client of clients) writeSse(client.res, 'status', { status: 'fallback', time: stamp });
      scheduleReconnect();
    };

    if (typeof socket.addEventListener === 'function') {
      socket.addEventListener('open', onOpen);
      socket.addEventListener('message', onMessage);
      socket.addEventListener('close', onDrop);
      socket.addEventListener('error', onDrop);
    } else {
      socket.onopen = onOpen;
      socket.onmessage = onMessage;
      socket.onclose = onDrop;
      socket.onerror = onDrop;
    }
  }

  function attachClient(client) {
    clients.add(client);
    clearTimeout(idleTimer);
    idleTimer = null;

    let quoteSet = quoteSubs.get(client.ticker);
    const needQuoteSub = !quoteSet;
    if (!quoteSet) {
      quoteSet = new Set();
      quoteSubs.set(client.ticker, quoteSet);
    }
    quoteSet.add(client);

    let needCandleSub = false;
    let candleKey = null;
    if (client.candlePeriod) {
      candleKey = `${client.ticker}:${client.candlePeriod}`;
      let entry = candleSubs.get(candleKey);
      needCandleSub = !entry;
      if (!entry) {
        entry = {
          ticker: client.ticker,
          period: client.candlePeriod,
          session: client.session,
          clients: new Set(),
        };
        candleSubs.set(candleKey, entry);
      }
      entry.clients.add(client);
    }

    ensureConnected();
    if (wsOpen) {
      if (needQuoteSub) {
        sendWs({ action: 'subscribe', symbols: [client.ticker], channels: ['quote'] });
      }
      if (needCandleSub && client.candlePeriod) {
        sendWs({
          action: 'subscribe_candlesticks',
          symbol: client.ticker,
          period: client.candlePeriod,
          session: client.session,
        });
      }
      if (!needQuoteSub && !needCandleSub) {
        writeSse(client.res, 'status', { status: 'live', time: now() });
      }
    }

    return () => {
      clients.delete(client);
      const qSet = quoteSubs.get(client.ticker);
      if (qSet) {
        qSet.delete(client);
        if (qSet.size === 0) {
          quoteSubs.delete(client.ticker);
          if (wsOpen) {
            sendWs({ action: 'unsubscribe', symbols: [client.ticker], channels: ['quote'] });
          }
        }
      }
      if (candleKey) {
        const entry = candleSubs.get(candleKey);
        if (entry) {
          entry.clients.delete(client);
          if (entry.clients.size === 0) {
            candleSubs.delete(candleKey);
            if (wsOpen) {
              sendWs({ action: 'unsubscribe_candlesticks', symbol: entry.ticker, period: entry.period });
            }
          }
        }
      }
      if (clients.size === 0) scheduleIdleDisconnect();
    };
  }

  async function handleRequest(req, res, url, { parseMarket, parseInterval, normalizeSymbol, toLongbridgeTicker }) {
    if (req.method !== 'GET') return writeJson(res, 405, { error: 'GET required' });
    const market = parseMarket(url.searchParams.get('market'));
    if (market !== 'us' && market !== 'hk' && market !== 'cn') {
      return writeJson(res, 400, { error: '该市场暂不支持 Hub 实时推流。' });
    }
    const interval = parseInterval(url.searchParams.get('interval') || '1m', market);
    const rawSymbol = url.searchParams.get('symbol') || '';
    if (!rawSymbol) return writeJson(res, 400, { error: '缺少标的代码。' });
    const symbol = normalizeSymbol(market, rawSymbol);
    const source = url.searchParams.get('source') || '';
    if (!source.startsWith('Longbridge ')) {
      return writeJson(res, 400, { error: '仅支持 Longbridge 行情源开启实时推流。' });
    }

    const caps = await getCapabilities();
    if (!caps?.configured || !caps?.ready) {
      return writeJson(res, 503, { error: 'Longbridge Hub 尚未就绪。' });
    }
    if (market === 'cn' && !caps.cnRealtime) {
      return writeJson(res, 503, { error: 'Longbridge Hub 未开通 A股实时行情，继续使用公开行情源。' });
    }
    if (market === 'hk' && !caps.hkRealtime) {
      return writeJson(res, 503, { error: 'Longbridge Hub 未开通港股实时行情。' });
    }
    if (market === 'us' && !caps.usRealtime) {
      return writeJson(res, 503, { error: 'Longbridge Hub 未开通美股实时行情。' });
    }

    const ticker = toLongbridgeTicker(market, symbol);
    if (!ticker) {
      return writeJson(res, 400, { error: 'Longbridge Hub 不支持该标的实时推流。' });
    }

    const aggregatedFourHour = interval === '4h' && source.includes('聚合4小时');
    const candlePeriod = aggregatedFourHour ? null : interval;
    const session = market === 'us' && !['1d', '1w', '1M'].includes(interval) ? 'all' : 'intraday';

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    const client = {
      res,
      market,
      symbol,
      interval,
      ticker,
      candlePeriod,
      session,
    };

    writeSse(res, 'status', { status: 'connecting', time: now() });
    const detach = attachClient(client);
    const heartbeat = setInterval(() => {
      if (res.writableEnded || res.destroyed) return;
      res.write(': keepalive\n\n');
      if (wsOpen) writeSse(res, 'status', { status: 'live', time: now() });
    }, keepaliveMs);
    heartbeat.unref?.();

    const cleanup = () => {
      clearInterval(heartbeat);
      detach();
    };
    res.on('close', cleanup);
  }

  function close() {
    closed = true;
    clearTimers();
    for (const client of clients) {
      try { client.res.end(); } catch {}
    }
    clients.clear();
    quoteSubs.clear();
    candleSubs.clear();
    disconnectWs();
  }

  return {
    handleRequest,
    close,
    stats: () => ({
      clients: clients.size,
      quoteTopics: quoteSubs.size,
      candleTopics: candleSubs.size,
      wsOpen,
    }),
  };
}
