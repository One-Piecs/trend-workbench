"use client";

import {useEffect, useMemo, useRef, useState} from 'react';
import type {MarketData} from '@/lib/market-types';
import {getLiveTarget, subscribeLiveCandles} from '@/lib/live-stream';
import {acceptLiveCandle, liveCandleKey, liveDisplayCandles, type LiveCandleUpdate} from '@/lib/live-candle';

type Frame = {
  key: string;
  status: 'connecting' | 'live' | 'fallback';
  update: LiveCandleUpdate | null;
};

/** The socket owns only the displayed quote. Historical analysis, exports and
 * the journal keep using the reconciled snapshot from the candle endpoint. */
export function useLiveCandles(data: MarketData | null, enabled: boolean, refresh: () => void, nowMs: number) {
  const key = enabled && data && getLiveTarget(data) ? liveCandleKey(data) : null;
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
    let lastBoundary = 0;
    let interrupted = false;

    function suspend() {
      ++epoch;
      stop?.();
      stop = undefined;
      window.clearTimeout(paint);
      window.clearTimeout(reconcile);
      paint = reconcile = undefined;
      update = null;
      lastBoundary = 0;
    }
    function connect() {
      if (stop || document.hidden || !navigator.onLine || !target) return;
      const session = ++epoch;
      setFrame({key: streamKey, status: 'connecting', update: null});
      stop = subscribeLiveCandles(target, {
        onCandle(candle, eventTimeMs) {
          const snapshot = latest.current.data;
          if (session !== epoch || !snapshot || liveCandleKey(snapshot) !== streamKey) return;
          const tail = snapshot.candles.at(-1);
          if (!tail) return;
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
          if (paint === undefined) paint = window.setTimeout(() => {
            paint = undefined;
            if (session === epoch && update) setFrame({key: streamKey, status: 'live', update});
          }, 250);
        },
        onStatus(status) {
          if (session !== epoch) return;
          if (status === 'live') {
            if (interrupted) latest.current.refresh();
            interrupted = false;
            return;
          }
          if (status === 'fallback') interrupted = true;
          window.clearTimeout(paint);
          paint = undefined;
          setFrame({key: streamKey, status, update});
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
  const streaming = active?.status === 'live' && active.update !== null
    && nowMs - active.update.eventTimeMs < 90_000 && candles !== data?.candles;
  return {candles, streaming};
}
