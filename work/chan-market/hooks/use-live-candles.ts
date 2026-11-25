"use client";

import {useEffect, useMemo, useRef, useState} from 'react';
import type {MarketData} from '@/lib/market-types';
import {getLiveTarget, subscribeLiveCandles} from '@/lib/live-stream';
import {acceptLiveCandle, liveCandleKey, liveDisplayCandles, type LiveCandleUpdate} from '@/lib/live-candle';
import {advanceQuoteSequence, displayQuoteSequence, type QuoteSequence} from '@/lib/quote-overlay';

type Frame = {
  key: string;
  status: 'connecting' | 'live' | 'fallback';
  update: LiveCandleUpdate | null;
  quote: QuoteSequence | null;
  lastSignalAt: number | null;
};

/** The socket owns only the displayed quote. Historical analysis, exports and
 * the journal keep using the reconciled snapshot from the candle endpoint. */
export function useLiveCandles(data: MarketData | null, enabled: boolean, refresh: () => void, nowMs: number) {
  const targetMeta = enabled && data ? getLiveTarget(data) : null;
  const key = targetMeta && data ? liveCandleKey(data) : null;
  const isLongbridge = targetMeta?.provider === 'longbridge';
  const latest = useRef({data, refresh});
  useEffect(() => { latest.current = {data, refresh}; }, [data, refresh]);
  const [frame, setFrame] = useState<Frame | null>(null);

  useEffect(() => {
    const initial = latest.current.data;
    const target = key && initial ? getLiveTarget(initial) : null;
    if (!key || !target) return;
    const streamKey = key;
    let stop: (() => void) | undefined;
    let epoch = 0;
    let paint: number | undefined;
    let reconcile: number | undefined;
    let update: LiveCandleUpdate | null = null;
    let quoteSeq: QuoteSequence | null = null;
    let lastSignalAt: number | null = null;
    let lastBoundary = 0;
    let interrupted = false;

    function flushPaint(session: number) {
      if (paint === undefined) {
        paint = window.setTimeout(() => {
          paint = undefined;
          if (session === epoch) setFrame({key: streamKey, status: 'live', update, quote: quoteSeq, lastSignalAt});
        }, 250);
      }
    }
    function suspend() {
      ++epoch;
      stop?.();
      stop = undefined;
      window.clearTimeout(paint);
      window.clearTimeout(reconcile);
      paint = reconcile = undefined;
      update = null;
      quoteSeq = null;
      lastSignalAt = null;
      lastBoundary = 0;
    }
    function connect() {
      if (stop || document.hidden || !navigator.onLine || !target) return;
      const session = ++epoch;
      setFrame({key: streamKey, status: 'connecting', update: null, quote: null, lastSignalAt: null});
      stop = subscribeLiveCandles(target, {
        onCandle(candle, eventTimeMs) {
          const snapshot = latest.current.data;
          if (session !== epoch || !snapshot || liveCandleKey(snapshot) !== streamKey) return;
          const tail = snapshot.candles.at(-1);
          if (!tail) return;
          lastSignalAt = Date.now();
          if ((candle.time > tail.time || (candle.time === tail.time && candle.closed && tail.closed === false)) && candle.time > lastBoundary) {
            // A final message and the first message of a new bar may arrive together.
            // Give the REST source a moment to publish the final OHLCV.
            lastBoundary = candle.time;
            if (reconcile === undefined) reconcile = window.setTimeout(() => {
              reconcile = undefined;
              latest.current.refresh();
            }, 3200);
          }
          const next = {key: streamKey, candle, eventTimeMs};
          if (!acceptLiveCandle(snapshot, update, next)) return;
          update = next;
          // One paint shows the latest complete OHLCV snapshot in the batch.
          flushPaint(session);
        },
        onQuote(rawQuote, eventTimeMs) {
          const snapshot = latest.current.data;
          if (session !== epoch || !snapshot || liveCandleKey(snapshot) !== streamKey) return;
          lastSignalAt = Date.now();
          const res = advanceQuoteSequence(snapshot, quoteSeq, rawQuote, eventTimeMs);
          if (res.sequence !== quoteSeq) {
            quoteSeq = res.sequence;
            flushPaint(session);
          }
        },
        onHeartbeat() {
          if (session !== epoch) return;
          lastSignalAt = Date.now();
        },
        onStatus(status) {
          if (session !== epoch) return;
          if (status === 'live') {
            if (interrupted) latest.current.refresh();
            interrupted = false;
            lastSignalAt ??= Date.now();
            if (target.provider === 'longbridge') {
              setFrame({key: streamKey, status: 'live', update, quote: quoteSeq, lastSignalAt});
            }
            return;
          }
          if (status === 'fallback') interrupted = true;
          window.clearTimeout(paint);
          paint = undefined;
          setFrame({key: streamKey, status, update, quote: quoteSeq, lastSignalAt});
        },
      });
    }
    function availability() {
      if (document.hidden || !navigator.onLine) {
        suspend();
        setFrame(previous => previous?.key === streamKey ? {...previous, status: 'fallback'} : null);
      } else if (!stop) {
        latest.current.refresh();
        connect();
      }
    }
    connect();
    document.addEventListener('visibilitychange', availability);
    window.addEventListener('online', availability);
    window.addEventListener('offline', availability);
    return () => {
      document.removeEventListener('visibilitychange', availability);
      window.removeEventListener('online', availability);
      window.removeEventListener('offline', availability);
      suspend();
    };
  }, [key]);

  const active = key !== null && frame?.key === key ? frame : null;
  const candles = useMemo(() => data ? liveDisplayCandles(data, active?.update ?? null) : null, [data, active]);
  const streaming = isLongbridge
    ? active?.status === 'live' && active.lastSignalAt !== null && nowMs - active.lastSignalAt < 90_000
    : active?.status === 'live' && active.update !== null && nowMs - active.update.eventTimeMs < 90_000 && candles !== data?.candles;
  const quote = isLongbridge && active?.status === 'live' && data
    ? displayQuoteSequence(data, active.quote, Math.max(nowMs, active.lastSignalAt ?? 0))?.quote ?? null
    : null;
  return {candles, streaming, quote};
}
