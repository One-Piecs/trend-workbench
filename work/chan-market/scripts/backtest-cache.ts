import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Instrument, Interval, Market, MarketData } from '../lib/market-types';
import { serializeCSV } from '../lib/csv.ts';
import { higherInterval } from '../lib/timeframe-context.ts';
import { parseInterval, parseMarket, normalizeSymbol } from '../lib/market-data.ts';
import { runCachedBacktest, type CacheBacktestResult } from '../lib/cache-backtest.ts';

interface SeriesStatusItem {
  key: string;
  market: Market;
  symbol: string;
  interval: Interval;
  source: string;
  adjustment: string;
  contract?: string;
  pinned: boolean;
  barCount: number;
  firstTime: number | null;
  lastTime: number | null;
  lastSyncAt: number | null;
  lastError: string | null;
  backfillDone: boolean;
  segmentCount: number;
}

interface HistoryCacheReader {
  listSeriesStatus(opts?: { pinnedOnly?: boolean }): SeriesStatusItem[];
  getWatchlist(): { initialized: boolean; items: Instrument[] };
  readSeries(opts: {
    market: string;
    symbol: string;
    interval: string;
    source?: string;
    adjustment?: string;
    contract?: string;
    from?: number;
    to?: number;
    maxBars?: number;
    contiguousOnly?: boolean;
  }): {
    data: MarketData;
    key: string;
    totalBars: number;
    segmentCount: number;
    truncated: boolean;
  } | null;
  readCompatibleHigher(
    primary: MarketData,
    targetInterval: Interval | null,
    opts?: { maxBars?: number },
  ): MarketData | undefined;
  readMinuteWindows(
    primary: MarketData,
    ranges: { start: number; end: number }[],
  ): MarketData | undefined;
  close(): void;
}

const VALID_INTERVALS = new Set<Interval>(['1m', '5m', '15m', '30m', '1h', '4h', '1d', '1w', '1M']);
const DEFAULT_BATCH_INTERVALS: Interval[] = ['5m', '15m', '1h', '1d'];

function parseDateOrEpoch(raw: string | undefined, endOfDay: boolean): number | undefined {
  if (!raw) return undefined;
  if (/^\d+$/.test(raw)) {
    const n = Number(raw);
    return n >= 1e11 ? Math.floor(n / 1000) : n;
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    const iso = `${raw}T${endOfDay ? '23:59:59' : '00:00:00'}Z`;
    const ms = Date.parse(iso);
    if (Number.isFinite(ms)) return Math.floor(ms / 1000);
  }
  const ms = Date.parse(raw);
  if (!Number.isFinite(ms)) throw new Error(`Invalid time boundary: ${raw}`);
  return Math.floor(ms / 1000);
}

function parseFlags(args: string[]): Record<string, string | boolean> {
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith('--')) throw new Error(`Unexpected argument: ${arg}`);
    const eq = arg.indexOf('=');
    if (eq >= 0) {
      flags[arg.slice(2, eq)] = arg.slice(eq + 1);
      continue;
    }
    const key = arg.slice(2);
    if (['list', 'watchlist', 'help'].includes(key)) {
      flags[key] = true;
      continue;
    }
    const next = args[i + 1];
    if (next === undefined || next.startsWith('--')) {
      throw new Error(`Missing value for --${key}`);
    }
    flags[key] = next;
    i++;
  }
  return flags;
}

function formatDay(sec: number | null): string {
  return sec ? new Date(sec * 1000).toISOString().slice(0, 16).replace('T', ' ') : '-';
}

function summarizeReport(report: CacheBacktestResult) {
  return {
    market: report.data.market,
    symbol: report.data.symbol,
    interval: report.data.interval,
    source: report.data.source,
    closedBars: report.data.closedBars,
    higherInterval: report.data.higherInterval,
    higherBars: report.data.higherBars,
    minuteResolved: report.baseline.minuteResolved,
    baseline: {
      published: report.baseline.published,
      completed: report.baseline.completed,
      winRate: report.baseline.winRate,
      meanNetR: report.baseline.meanNetR,
      sampleStatus: report.baseline.sampleStatus,
    },
    shadow: {
      completed: report.shadow.completed,
      winRate: report.shadow.winRate,
      meanNetR: report.shadow.meanNetR,
      sampleStatus: report.shadow.sampleStatus,
    },
    durationMs: report.durationMs,
  };
}

export async function runCacheBacktestCli(args: string[]): Promise<unknown> {
  const flags = parseFlags(args);
  if (flags.help) {
    console.log(
      [
        'Usage:',
        '  backtest-cache.ts --list [--db <path>]',
        '  backtest-cache.ts --export <file> --market <m> --symbol <s> --interval <i> [--format json|csv] [--from ...] [--to ...] [--max-bars N]',
        '  backtest-cache.ts --market <m> --symbol <s> --interval <i> [--source ...] [--adjustment ...] [--max-bars 2000] [--folds 3] [--out report.json]',
        '  backtest-cache.ts --watchlist [--intervals 5m,15m,1h,1d] [--max-bars 2000] [--folds 3] [--out summary.json]',
      ].join('\n'),
    );
    return { help: true };
  }

  const historyCacheUrl = new URL('../../local-workbench/history-cache.mjs', import.meta.url).href;
  const mod = (await import(historyCacheUrl)) as {
    createHistoryCache: (opts?: { filename?: string }) => HistoryCacheReader;
  };
  const dbPath = typeof flags.db === 'string' ? resolve(flags.db) : undefined;
  const archive = mod.createHistoryCache(dbPath ? { filename: dbPath } : {});

  try {
    if (flags.list) {
      const series = archive.listSeriesStatus({ pinnedOnly: false });
      const rows = series.map((s) => ({
        market: s.market,
        symbol: s.symbol,
        interval: s.interval,
        pinned: s.pinned,
        bars: s.barCount,
        segments: s.segmentCount,
        backfillDone: s.backfillDone,
        first: formatDay(s.firstTime),
        last: formatDay(s.lastTime),
        source: s.source,
      }));
      if (rows.length) console.table(rows);
      else console.log('No cached series found.');
      return { series: rows };
    }

    const from = parseDateOrEpoch(typeof flags.from === 'string' ? flags.from : undefined, false);
    const to = parseDateOrEpoch(typeof flags.to === 'string' ? flags.to : undefined, true);
    if (from !== undefined && to !== undefined && to < from) {
      throw new Error('--to must not precede --from.');
    }

    if (typeof flags.export === 'string') {
      const market = parseMarket(typeof flags.market === 'string' ? flags.market : null);
      const interval = parseInterval(typeof flags.interval === 'string' ? flags.interval : null, market);
      const symbol = normalizeSymbol(market, typeof flags.symbol === 'string' ? flags.symbol : '');
      const source = typeof flags.source === 'string' ? flags.source : undefined;
      const adjustment = typeof flags.adjustment === 'string' ? flags.adjustment : undefined;
      const contract = typeof flags.contract === 'string' ? flags.contract : '';
      const maxBars = flags['max-bars'] ? Math.max(1, Math.min(200000, Number(flags['max-bars']))) : 5000;
      const format = typeof flags.format === 'string' ? flags.format.toLowerCase() : 'json';
      if (format !== 'json' && format !== 'csv') throw new Error('--format must be json or csv.');

      const read = archive.readSeries({
        market,
        symbol,
        interval,
        source,
        adjustment,
        contract,
        from,
        to,
        maxBars,
        contiguousOnly: true,
      });
      if (!read || !read.data.candles.length) {
        throw new Error(`No cached series found for ${market}:${symbol}:${interval}`);
      }
      const outFile = resolve(flags.export);
      await mkdir(dirname(outFile), { recursive: true });
      if (format === 'csv') {
        await writeFile(outFile, serializeCSV(read.data.candles), 'utf8');
      } else {
        const higher = archive.readCompatibleHigher(read.data, higherInterval(market, interval), { maxBars });
        await writeFile(
          outFile,
          JSON.stringify({ primary: read.data, ...(higher ? { higher } : {}) }, null, 2),
          'utf8',
        );
      }
      const summary = {
        output: outFile,
        format,
        market,
        symbol,
        interval,
        bars: read.data.candles.length,
        source: read.data.source,
      };
      console.log(JSON.stringify(summary));
      return summary;
    }

    const folds = flags.folds ? Number(flags.folds) : 3;
    const warmupFraction = flags.warmup ? Number(flags.warmup) : 0.4;
    const feeBps = flags['fee-bps'] !== undefined ? Number(flags['fee-bps']) : 5;
    const slippageBps = flags['slippage-bps'] !== undefined ? Number(flags['slippage-bps']) : 3;
    const penMode = flags['pen-mode'] === 'old' ? 'old' : 'new';
    const maxBars = flags['max-bars'] ? Math.max(100, Math.min(20000, Number(flags['max-bars']))) : 2000;
    const backtestOpts = {
      folds,
      warmupFraction,
      costs: { feeBps, slippageBps },
      penMode,
    } as const;

    if (flags.watchlist) {
      const rawIntervals =
        typeof flags.intervals === 'string'
          ? flags.intervals
              .split(',')
              .map((s) => s.trim())
              .filter((v): v is Interval => VALID_INTERVALS.has(v as Interval))
          : DEFAULT_BATCH_INTERVALS;
      const intervals = rawIntervals.length ? rawIntervals : DEFAULT_BATCH_INTERVALS;
      const { items } = archive.getWatchlist();
      const seriesStatus = archive.listSeriesStatus({ pinnedOnly: true });
      const targets = items.length
        ? items.flatMap((item) =>
            intervals.map((interval) => ({
              market: item.market,
              symbol: item.symbol,
              interval,
            })),
          )
        : seriesStatus
            .filter((s) => intervals.includes(s.interval))
            .map((s) => ({ market: s.market, symbol: s.symbol, interval: s.interval }));

      const reports: CacheBacktestResult[] = [];
      for (const target of targets) {
        const read = archive.readSeries({
          market: target.market,
          symbol: target.symbol,
          interval: target.interval,
          from,
          to,
          maxBars,
          contiguousOnly: true,
        });
        if (!read || !read.data.candles.length) continue;
        const higher = archive.readCompatibleHigher(
          read.data,
          higherInterval(target.market, target.interval),
          { maxBars: Math.max(maxBars, 2000) },
        );
        const result = await runCachedBacktest({
          primary: read.data,
          higher,
          loadMinutes: (ranges) => archive.readMinuteWindows(read.data, ranges),
          options: backtestOpts,
        });
        reports.push(result);
      }

      const summary = {
        generatedAt: new Date().toISOString(),
        evaluated: reports.length,
        results: reports.map(summarizeReport),
      };
      if (typeof flags.out === 'string') {
        const outFile = resolve(flags.out);
        await mkdir(dirname(outFile), { recursive: true });
        await writeFile(outFile, JSON.stringify({ ...summary, reports }, null, 2), 'utf8');
      }
      if (summary.results.length) {
        console.table(
          summary.results.map((r) => ({
            sample: `${r.market}:${r.symbol}:${r.interval}`,
            bars: r.closedBars,
            baseN: r.baseline.completed,
            baseWin: r.baseline.winRate === null ? '-' : `${(r.baseline.winRate * 100).toFixed(1)}%`,
            baseR: r.baseline.meanNetR === null ? '-' : r.baseline.meanNetR.toFixed(2),
            trendN: r.shadow.completed,
            trendR: r.shadow.meanNetR === null ? '-' : r.shadow.meanNetR.toFixed(2),
            ms: r.durationMs,
          })),
        );
      } else {
        console.log('No cached watchlist series available for the selected intervals.');
      }
      return summary;
    }

    const market = parseMarket(typeof flags.market === 'string' ? flags.market : null);
    const interval = parseInterval(typeof flags.interval === 'string' ? flags.interval : null, market);
    const symbol = normalizeSymbol(market, typeof flags.symbol === 'string' ? flags.symbol : '');
    const source = typeof flags.source === 'string' ? flags.source : undefined;
    const adjustment = typeof flags.adjustment === 'string' ? flags.adjustment : undefined;
    const contract = typeof flags.contract === 'string' ? flags.contract : '';

    const read = archive.readSeries({
      market,
      symbol,
      interval,
      source,
      adjustment,
      contract,
      from,
      to,
      maxBars,
      contiguousOnly: true,
    });
    if (!read || !read.data.candles.length) {
      throw new Error(`No cached series found for ${market}:${symbol}:${interval}`);
    }
    const higher = archive.readCompatibleHigher(read.data, higherInterval(market, interval), {
      maxBars: Math.max(maxBars, 2000),
    });
    const result = await runCachedBacktest({
      primary: read.data,
      higher,
      loadMinutes: (ranges) => archive.readMinuteWindows(read.data, ranges),
      options: backtestOpts,
    });

    if (typeof flags.out === 'string') {
      const outFile = resolve(flags.out);
      await mkdir(dirname(outFile), { recursive: true });
      await writeFile(outFile, JSON.stringify(result, null, 2), 'utf8');
    }
    const compact = summarizeReport(result);
    console.log(JSON.stringify(compact, null, 2));
    return result;
  } finally {
    archive.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runCacheBacktestCli(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
