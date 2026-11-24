"use client";

import {useEffect, useMemo, useSyncExternalStore} from 'react';
import type {MarketData} from '@/lib/market-types';
import {createHistorySession, emptyBars, historySeriesKey, joinSnapshot} from '@/lib/earlier-history';

export function useEarlierHistory(data: MarketData | null, online: boolean) {
  const key = data && online ? historySeriesKey(data) : '';
  const session = useMemo(() => createHistorySession(fetch, key), [key]);
  const state = useSyncExternalStore(session.subscribe, session.read, session.read);
  const snapshot = data?.candles ?? emptyBars;
  useEffect(() => { session.refresh(snapshot); }, [session, snapshot]);
  useEffect(() => () => session.cancel(), [session]);
  const candles = useMemo(() => joinSnapshot(state.bars, snapshot), [state.bars, snapshot]);
  const paging = useMemo(() => key && data ? {status: state.status, onLoad: () => {void session.load(data);}} : undefined,
    [key, data, session, state.status]);
  return {candles, paging, key};
}
