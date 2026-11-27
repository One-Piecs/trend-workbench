"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Search, ArrowUpRight, ArrowDownRight, ChevronDown, ChevronRight, RefreshCw, Star, X, Activity, Globe2, Layers3, Radio, Download, Upload, StepBack, StepForward, Play, Pause, RotateCcw, AlertTriangle, Check, BarChart3, Crosshair, CheckCircle2, Send, Maximize2, Minimize2, PanelLeftOpen, PanelLeftClose } from 'lucide-react';
import {parseCSV,serializeCSV} from '@/lib/csv';
import TerminalChart, {priceText, type Layers} from '@/components/terminal-chart';
import LinkedTimeframes from '@/components/linked-timeframes';
import MarketBattle from '@/components/market-battle';
import type {BattleMode} from '@/components/battle-scenarios';
import {analyze} from '@/lib/chan';
import {planSessionKey,readPlanSession} from '@/lib/plan-session';
import {LanguageProvider,useLanguage} from '@/lib/language';
import {COMMODITY_INSTRUMENTS, searchCommodities} from '@/lib/commodity-catalog';
import {filterWatchlist} from '@/lib/watchlist-search';
import {WATCHLIST_STORAGE_KEY,parseWatchlist,persistWatchlistRemote,syncWatchlistOnMount} from '@/lib/watchlist-storage';
import {WORKBENCH_BRAND} from '@/lib/workbench-brand';
import {translateAnalysis} from '@/lib/analysis-i18n';
import {marketDisplayText,marketLoadErrorText,marketVenueSuffix,translateInstrumentName} from '@/lib/market-i18n';
import TradeSetups from '@/components/trade-setups';
import ConfluencePanel from '@/components/confluence-panel';
import BreakoutFlow from '@/components/breakout-flow';
import {createChartFeedController,type ChartSnapshot} from '@/lib/market-context-loader';
import {candleAvailableAt,higherInterval} from '@/lib/timeframe-context';
import {useReplayHigher} from '@/hooks/use-replay-higher';
import {availableForecastCandles,buildForecast,marketSnapshotCutoff} from '@/lib/forecast';
import {getFeedHealth} from '@/lib/feed-health';
import {useForecastJournal} from '@/hooks/use-forecast-journal';
import {useDirectionScorecard} from '@/hooks/use-direction-scorecard';
import DirectionScorecard from '@/components/direction-scorecard';
import {useLiveCandles} from '@/hooks/use-live-candles';
import {useMarketQuote} from '@/hooks/use-market-quote';
import type {QuoteSession} from '@/lib/quote-overlay';
import {useEarlierHistory} from '@/hooks/use-earlier-history';
import {emptyBars} from '@/lib/earlier-history';
import {endAtTime} from '@/lib/chart-viewport';
import type {WatchSnapshot} from '@/lib/watch-monitor';
import FeedStatus from '@/components/feed-status';
import WorkbenchThemePicker from '@/components/workbench-theme-picker';
import HistoryCoverage from '@/components/history-coverage';
import FourHourCoverage from '@/components/four-hour-coverage';
import CenterHistory from '@/components/center-history';
import CenterLayerSelector,{type CenterLayerMode} from '@/components/center-layer-selector';
import {buildStrokeCenters} from '@/lib/center-layers';
import WatchMonitor from '@/components/watch-monitor';
import ForecastActivity from '@/components/forecast-activity';
import ForecastValidationPanel from '@/components/forecast-validation-panel';
import type {Analysis,Instrument,Interval,Market,MarketData} from '@/lib/market-types';

const PRESETS: Instrument[]=[
  {id:'crypto:BTCUSDT',symbol:'BTCUSDT',name:'Bitcoin',market:'crypto',exchange:'Binance',currency:'USDT'},
  {id:'crypto:ETHUSDT',symbol:'ETHUSDT',name:'Ethereum',market:'crypto',exchange:'Binance',currency:'USDT'},
  {id:'crypto:SOLUSDT',symbol:'SOLUSDT',name:'Solana',market:'crypto',exchange:'Binance',currency:'USDT'},
  {id:'crypto:BNBUSDT',symbol:'BNBUSDT',name:'BNB',market:'crypto',exchange:'Binance',currency:'USDT'},
  {id:'crypto:XRPUSDT',symbol:'XRPUSDT',name:'XRP',market:'crypto',exchange:'Binance',currency:'USDT'},
  {id:'crypto:DOGEUSDT',symbol:'DOGEUSDT',name:'Dogecoin',market:'crypto',exchange:'Binance',currency:'USDT'},
  {id:'us:NVDA',symbol:'NVDA',name:'NVIDIA 英伟达',market:'us',exchange:'NASDAQ',currency:'USD'},
  {id:'us:AAPL',symbol:'AAPL',name:'Apple 苹果',market:'us',exchange:'NASDAQ',currency:'USD'},
  {id:'us:TSLA',symbol:'TSLA',name:'Tesla 特斯拉',market:'us',exchange:'NASDAQ',currency:'USD'},
  {id:'us:MSFT',symbol:'MSFT',name:'Microsoft 微软',market:'us',exchange:'NASDAQ',currency:'USD'},
  {id:'us:SPY',symbol:'SPY',name:'标普500 ETF',market:'us',exchange:'NYSE Arca',currency:'USD'},
  {id:'hk:00700.HK',symbol:'00700.HK',name:'腾讯控股',market:'hk',exchange:'港交所',currency:'HKD'},
  {id:'hk:09988.HK',symbol:'09988.HK',name:'阿里巴巴-W',market:'hk',exchange:'港交所',currency:'HKD'},
  {id:'hk:03690.HK',symbol:'03690.HK',name:'美团-W',market:'hk',exchange:'港交所',currency:'HKD'},
  {id:'hk:01810.HK',symbol:'01810.HK',name:'小米集团-W',market:'hk',exchange:'港交所',currency:'HKD'},
  {id:'hk:00388.HK',symbol:'00388.HK',name:'香港交易所',market:'hk',exchange:'港交所',currency:'HKD'},
  {id:'cn:600519.SH',symbol:'600519.SH',name:'贵州茅台',market:'cn',exchange:'上交所',currency:'CNY'},
  {id:'cn:300750.SZ',symbol:'300750.SZ',name:'宁德时代',market:'cn',exchange:'深交所',currency:'CNY'},
  {id:'cn:000001.SZ',symbol:'000001.SZ',name:'平安银行',market:'cn',exchange:'深交所',currency:'CNY'},
  {id:'cn:601318.SH',symbol:'601318.SH',name:'中国平安',market:'cn',exchange:'上交所',currency:'CNY'},
  {id:'cn:002594.SZ',symbol:'002594.SZ',name:'比亚迪',market:'cn',exchange:'深交所',currency:'CNY'},
  ...COMMODITY_INSTRUMENTS,
];
const MARKETS: {id:Market;title:string;en:string}[]=[{id:'crypto',title:'加密货币',en:'CRYPTO'},{id:'us',title:'美股',en:'US EQUITIES'},{id:'hk',title:'港股',en:'HK EQUITIES'},{id:'cn',title:'A股',en:'CHINA A'},{id:'commodity',title:'大宗商品',en:'COMMODITIES'}];
const INTERVALS:Interval[]=['1m','5m','15m','30m','1h','4h','1d','1w','1M'];
const TIME_LABEL:Record<Interval,string>={'1m':'1分','5m':'5分','15m':'15分','30m':'30分','1h':'1小时','4h':'4小时','1d':'日线','1w':'周线','1M':'月线'};
const initialLayers:Layers={anchoredVwap:false,strokes:true,segments:true,centers:true,signals:true,scenarios:false,fractals:false,setups:true};
function displaySymbol(s:string){return s.endsWith('USDT')?s.slice(0,-4)+'/USDT':s;}
function readableTime(t:number,locale:string){return new Date(t*1000).toLocaleString(locale,{year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false});}
function download(name:string,body:string,type:string){const url=URL.createObjectURL(new Blob([body],{type}));const a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
export default function Home(){return <LanguageProvider><HomeContent/></LanguageProvider>;}
function HomeContent(){
  const {language,setLanguage,t,locale}=useLanguage();
  const mt=(text:string)=>marketDisplayText(text,language);
  const instrumentName=(name:string)=>name==='本地导入数据'?t('本地导入数据','Imported local data'):translateInstrumentName(name,language);
  const [market,setMarket]=useState<Market>('crypto'),[selected,setSelected]=useState<Instrument>(PRESETS[0]),[interval,setInterval]=useState<Interval>('1h');
  const [snapshot,setSnapshot]=useState<ChartSnapshot|null>(null),[fetchLoading,setLoading]=useState(true);
  const [feedError,setFeedError]=useState<{key:string;message:string}|null>(null);
  const [chartFeed]=useState(()=>createChartFeedController());
  const [imported,setImported]=useState(false);
  const [healthClock,setHealthClock]=useState(()=>Date.now()),[feedSuccess,setFeedSuccess]=useState<{key:string;at:number}|null>(null);
  const {journal,ready:journalReady,saved:journalSaved,notices,observe}=useForecastJournal();
  const {records:directionRecords,saved:directionSaved,observe:observeDirection}=useDirectionScorecard();
  const [monitorEnabled,setMonitorEnabled]=useState(false);
  useEffect(()=>{const timer=window.setInterval(()=>setHealthClock(Date.now()),10000);return()=>clearInterval(timer);},[]);
  const storedData=snapshot?.data,receivedAt=snapshot?.receivedAt;
  const cutoff=storedData?marketSnapshotCutoff(storedData.asOf,receivedAt):0;
  // Gate every quote and analysis in the render itself, before selection effects run.
  const isLocalSnapshot=snapshot?.higher.status==='imported';
  const data=useMemo(()=>{
    if(!storedData||storedData.instrument.market!==selected.market||storedData.instrument.symbol!==selected.symbol||storedData.interval!==interval||isLocalSnapshot!==imported)return null;
    if(imported)return storedData;
    const candles=availableForecastCandles(storedData.candles,{market:selected.market,interval,source:storedData.source},cutoff);
    return {...storedData,candles};
  },[storedData,selected.market,selected.symbol,interval,isLocalSnapshot,imported,cutoff]);
  const selectionKey=`${selected.market}:${selected.symbol}:${interval}`;
  const history=useEarlierHistory(data,!imported);
  const timeline=history.candles;
  const [cacheSeriesInfo,setCacheSeriesInfo]=useState<{key:string;barCount:number}|null>(null);
  const activeSeriesIdentity=data&&!imported?JSON.stringify([data.instrument.market,data.instrument.symbol.toUpperCase(),data.interval,data.source,data.adjustment,data.instrument.contract??'']):null;
  useEffect(()=>{
    if(!activeSeriesIdentity||!data)return;
    const controller=new AbortController();
    void fetch('/api/cache/status?all=1',{signal:controller.signal}).then(res=>res.ok?res.json():null).then((body:{series?:{market:string;symbol:string;interval:string;source:string;adjustment:string;contract?:string;barCount:number}[]}|null)=>{
      if(controller.signal.aborted||!body?.series)return;
      const match=body.series.find(s=>JSON.stringify([s.market,s.symbol.toUpperCase(),s.interval,s.source,s.adjustment,s.contract??''])===activeSeriesIdentity);
      setCacheSeriesInfo(match?{key:activeSeriesIdentity,barCount:match.barCount}:null);
    }).catch(()=>{});
    return()=>controller.abort();
  },[activeSeriesIdentity,data]);
  const cachedSeriesBars=activeSeriesIdentity&&cacheSeriesInfo?.key===activeSeriesIdentity?cacheSeriesInfo.barCount:undefined;
  const linkedData=useMemo(()=>data&&timeline!==data.candles?{...data,candles:timeline}:data,[data,timeline]);
  const cached=Boolean(data&&snapshot?.cached);
  const error=!imported&&feedError?.key===selectionKey?feedError.message:'';
  const loading=fetchLoading||(!data&&!error);
  const [watchlist,setWatchlist]=useState<Instrument[]>([PRESETS[0],PRESETS[1],PRESETS[2],PRESETS[6],PRESETS[7],PRESETS[11]]),[watchTab,setWatchTab]=useState<'all'|'favorites'>('all');
  const watchlistTouched=useRef(false);
  const [searchOpen,setSearchOpen]=useState(false),[searchMarket,setSearchMarket]=useState<Market|'all'|'favorites'>('all'),[query,setQuery]=useState(''),[searchResults,setSearchResults]=useState<Instrument[]>([]),[searching,setSearching]=useState(false),[searchWarning,setSearchWarning]=useState('');
  const [layers,setLayers]=useState<Layers>(initialLayers);
  const [layerMenu,setLayerMenu]=useState(false);
  const [focused,setFocused]=useState(false);
  const [sidebarCollapsed,setSidebarCollapsed]=useState(false);
  useEffect(()=>{setSidebarCollapsed(localStorage.getItem('chan-sidebar-collapsed')==='1');},[]);
  const toggleSidebar=useCallback(()=>{setSidebarCollapsed(collapsed=>{localStorage.setItem('chan-sidebar-collapsed',collapsed?'0':'1');return !collapsed;});},[]);
  const focusButton=useRef<HTMLButtonElement>(null);
  const scrollBeforeFocus=useRef(0);
  const toggleFocus=useCallback(()=>{
    if(!focused) scrollBeforeFocus.current=window.scrollY;
    setFocused(!focused);
    window.requestAnimationFrame(()=>{
      window.scrollTo(0,focused?scrollBeforeFocus.current:0);
      focusButton.current?.focus({preventScroll:true});
    });
  },[focused]);
  useEffect(()=>{
    if(!focused||searchOpen)return;
    function exit(event:KeyboardEvent){if(event.key==='Escape'&&!document.querySelector('dialog[open]'))toggleFocus();}
    window.addEventListener('keydown',exit);
    return ()=>window.removeEventListener('keydown',exit);
  },[focused,searchOpen,toggleFocus]);
  const [centerLayer,setCenterLayer]=useState<CenterLayerMode>('all');
  const penMode='new' as const;
  const [replayTime,setReplayTime]=useState<number|null>(null),[playing,setPlaying]=useState(false),[toast,setToast]=useState('');
  const replay=replayTime===null?null:endAtTime(timeline,replayTime);
  const seekReplay=useCallback((count:number)=>{
    setReplayTime(count>=timeline.length?null:timeline[Math.max(0,count-1)]?.time??null);
  },[timeline]);
  const [signalTab,setSignalTab]=useState<'setups'|'scenarios'|'signals'>('setups');
  const importGeneration=useRef(0),fileInput=useRef<HTMLInputElement>(null),searchInput=useRef<HTMLInputElement>(null);
  const cancelPendingImport=useCallback(()=>{importGeneration.current++;},[]);
  // Hydrate browser watchlist and synchronize with the local workbench server if available.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(()=>{
    let cancelled=false;
    let initial=[PRESETS[0],PRESETS[1],PRESETS[2],PRESETS[6],PRESETS[7],PRESETS[11]];
    try{
      const parsed=parseWatchlist(JSON.parse(localStorage.getItem(WATCHLIST_STORAGE_KEY)||'null'));
      if(parsed){initial=parsed;setWatchlist(parsed);}
    }catch{}
    void syncWatchlistOnMount(initial).then(remote=>{
      if(cancelled||watchlistTouched.current||!remote)return;
      setWatchlist(remote);
      try{localStorage.setItem(WATCHLIST_STORAGE_KEY,JSON.stringify(remote));}catch{}
    });
    return()=>{cancelled=true;};
  },[]);
  const notify=useCallback((message:string)=>{setToast(message);setTimeout(()=>setToast(''),5500);},[]);
  const lastNotice=useRef<string|null>(null);
  useEffect(()=>{const notice=notices[0];if(!notice||lastNotice.current===notice.id)return;lastNotice.current=notice.id;const event=notice.intrabar?notice.type==='invalidation'?t('收到报价触及止损价','Received quote touched the stop-loss price'):notice.type==='target1'?t('收到报价触及第一止盈价','Received quote touched the take-profit 1 price'):t('收到报价触及第二止盈价','Received quote touched the take-profit 2 price'):notice.type==='condition-met'?t('预判条件满足','Outlook condition met'):notice.type==='invalidated'?t('止损价触及','Stop-loss price touched'):notice.type==='target1'?t('第一止盈价触及','Take-profit 1 price touched'):t('第二止盈价触及','Take-profit 2 price touched');notify(`${notice.symbol} · ${notice.interval} · ${event} ${priceText(notice.price)}`);},[notices,notify,t]);
  const fetchData=useCallback(async(background=false)=>{
    if(!background){
      cancelPendingImport();
      // Keep the last matching candles and any known failure until fresh data arrives.
      // The selection guard above already excludes another instrument, interval or CSV.
      setLoading(true);setReplayTime(null);setPlaying(false);
    }
    await chartFeed.load({market:selected.market,symbol:selected.symbol,interval,background,
      onCache:result=>setSnapshot(previous=>previous&&!previous.cached&&previous.data.instrument.market===selected.market&&previous.data.instrument.symbol===selected.symbol&&previous.data.interval===interval&&previous.higher.status!=='imported'?previous:result),
      onSnapshot:result=>{
        setSnapshot(result);setFeedSuccess({key:selectionKey,at:result.receivedAt});setHealthClock(Date.now());setLoading(false);setFeedError(null);
      },
      onPrimaryError:message=>{setFeedError({key:selectionKey,message});setLoading(false);},
    });
  },[chartFeed,cancelPendingImport,selectionKey,selected.market,selected.symbol,interval]);
  // Synchronize the selected market with the remote feed, cancelling obsolete requests.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(()=>{if(!imported)void fetchData();return()=>{chartFeed.cancel();cancelPendingImport();};},[chartFeed,cancelPendingImport,fetchData,imported]);
  useEffect(()=>{if(imported||replay!==null||playing)return;const timer=window.setInterval(()=>{if(!document.hidden)void fetchData(true);},30000);return()=>window.clearInterval(timer);},[fetchData,imported,replay,playing]);
  const replayActive=replay!==null,wasReplaying=useRef(false);
  useEffect(()=>{
    if(replayActive&&!wasReplaying.current)chartFeed.cancel();
    if(!replayActive&&wasReplaying.current&&!imported)void fetchData(true);
    wasReplaying.current=replayActive;
  },[chartFeed,fetchData,imported,replayActive]);
  useEffect(()=>{
    function handler(event:KeyboardEvent){
      if(document.querySelector('dialog[open]'))return;
      if(event.key==='Escape')setSearchOpen(false);
      if(event.key==='/'&&!(event.target instanceof HTMLInputElement)&&!(event.target instanceof HTMLTextAreaElement)){
        event.preventDefault();setSearchOpen(true);
      }
    }
    window.addEventListener('keydown',handler);
    return ()=>window.removeEventListener('keydown',handler);
  },[]);
  useEffect(()=>{if(searchOpen)setTimeout(()=>searchInput.current?.focus(),70);},[searchOpen]);
  useEffect(()=>{
    if(!searchOpen)return;const controller=new AbortController();const q=query.trim();
    // Search results and loading state synchronize with an external directory.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSearchWarning('');
    if(searchMarket==='favorites'){setSearching(false);return;}
    if(!q){setSearchResults(PRESETS.filter(i=>searchMarket==='all'||i.market===searchMarket));setSearching(false);return;}
    setSearching(true);const timer=setTimeout(async()=>{try{const res=await fetch(`/api/search?market=${searchMarket}&q=${encodeURIComponent(q)}`,{signal:controller.signal});const result=await res.json() as {results?:Instrument[];warning?:string;error?:string};if(controller.signal.aborted)return;if(!res.ok)throw new Error(result.error||'搜索源暂不可用');setSearchResults(result.results||[]);setSearchWarning(result.warning||'');}catch{if(!controller.signal.aborted){setSearchResults(PRESETS.filter(i=>(searchMarket==='all'||i.market===searchMarket)&&(i.name.toLowerCase().includes(q.toLowerCase())||i.symbol.toLowerCase().includes(q.toLowerCase())||i.market==='commodity'&&searchCommodities(q).some(c=>c.id===i.id))));setSearchWarning('在线搜索暂不可用，当前仅显示常用标的匹配结果。');}}finally{if(!controller.signal.aborted)setSearching(false);}},300);
    return()=>{clearTimeout(timer);controller.abort();};
  },[query,searchMarket,searchOpen]);
  useEffect(()=>{
    if(!playing||replay===null)return;
    const timer=window.setTimeout(()=>{
      if(replay+1>=timeline.length)setPlaying(false);
      seekReplay(replay+1);
    },650);
    return ()=>window.clearTimeout(timer);
  },[playing,replay,seekReplay,timeline.length]);
  const chartSnapshot=useMemo(()=>replay===null?timeline:timeline.slice(0,replay),[timeline,replay]);
  // Requests for older chart history must never change an already-issued live outlook.
  const candles=useMemo(()=>{
    if(!data)return emptyBars;
    if(replay===null)return data.candles;
    return chartSnapshot.slice(-data.candles.length);
  },[data,replay,chartSnapshot]);
  const analysisStart=chartSnapshot.length-candles.length;
  const live=replay===null&&!imported&&!cached;
  const reconcile=useCallback(()=>{void fetchData(true);},[fetchData]);
  const push=useLiveCandles(data,live,reconcile,healthClock);
  const pollQuoteEnabled=live&&!(data?.source.startsWith('Longbridge ')&&push.streaming);
  const supplemental=useMarketQuote(data,pollQuoteEnabled,healthClock,reconcile);
  const quote=push.quote??supplemental.quote;
  const quoteCandles=live&&push.candles?push.candles:chartSnapshot;
  const liveBar=supplemental.candle??(live&&push.candles!==data?.candles?push.candles?.at(-1):undefined);
  const replayBar=chartSnapshot.at(-1);
  const replayCutoff=replayActive&&data&&replayBar&&!imported?Math.min(cutoff,candleAvailableAt(replayBar,data.instrument.market,data.interval,data.source)):null;
  const higherFeed=useReplayHigher(linkedData,snapshot?.higher,replayCutoff);
  const planKey=data&&!imported?planSessionKey({market:data.instrument.market,symbol:data.instrument.symbol,interval:data.interval,source:data.source,penMode}):null;
  const analysisContext=useMemo(()=>{
    if(!data||!higherFeed)return undefined;
    let higher=higherFeed;
    if(!replayActive&&error&&higher.status==='loading')higher={interval:higher.interval,status:'error'};
    return {market:data.instrument.market,symbol:data.instrument.symbol,interval:data.interval,source:data.source,adjustment:data.adjustment,higher};
  },[data,higherFeed,replayActive,error]);
  const pendingContext=!replayActive&&analysisContext?.higher.status==='loading';
  const rawAnalysis=useMemo<Analysis|null>(()=>{
    if(candles.length<3||pendingContext)return null;
    try{return analyze(candles,{penMode,horizon:12,skipTradePlans:true,planSession:live&&planKey?readPlanSession(planKey):undefined,context:analysisContext});}catch{return null;}
  },[candles,penMode,live,planKey,analysisContext,pendingContext]);
  // Legacy plan sessions are read-only archives; forward outlooks have a separate observation journal.
  const analysis=useMemo(()=>rawAnalysis?translateAnalysis(rawAnalysis,language):null,[rawAnalysis,language]);
  const strokeCenters=useMemo(()=>rawAnalysis?buildStrokeCenters(rawAnalysis.strokes):[],[rawAnalysis]);
  const rawForecast=useMemo(()=>rawAnalysis&&data?buildForecast(candles,rawAnalysis,{market:data.instrument.market,symbol:data.instrument.symbol,interval:data.interval,source:data.source,adjustment:data.adjustment,...(live?{asOf:cutoff}:{})}):null,[rawAnalysis,data,candles,live,cutoff]);
  const health=useMemo(()=>getFeedHealth(data,{nowMs:healthClock,lastSuccessAtMs:feedSuccess?.key===selectionKey?feedSuccess.at:undefined,error}),[data,healthClock,feedSuccess,selectionKey,error]);
  const displayForecast=imported||replay!==null||!cached&&(health.allowSignals||health.state==='closed');
  let battleMode:BattleMode='live';
  if(replayActive) battleMode='replay';
  else if(imported) battleMode='imported';
  else if(cached) battleMode='cached';
  else if(!data||error||health.state==='stale'||health.state==='error'||health.state==='unknown') battleMode='unavailable';
  else if(health.state==='closed'&&!quote?.session&&!push.streaming) battleMode='closed';
  useEffect(()=>{
    if(!live||!data||!rawForecast||loading||['error','stale','unknown'].includes(health.state))return;
    if(journalReady)observe(data,rawForecast,health.allowSignals);
    observeDirection(data,rawForecast,health.allowSignals||health.state==='closed');
  },[data,rawForecast,live,journalReady,loading,health.state,health.allowSignals,observe,observeDirection]);
  const onWatchSnapshot=useCallback((snapshot:WatchSnapshot)=>{
    if(!live||snapshot.data.interval!==interval||snapshot.data.instrument.market===selected.market&&snapshot.data.instrument.symbol===selected.symbol)return;
    if(['error','stale','unknown'].includes(snapshot.health.state))return;
    observe(snapshot.data,snapshot.forecast,snapshot.health.allowSignals);
    observeDirection(snapshot.data,snapshot.forecast,snapshot.health.allowSignals||snapshot.health.state==='closed');
  },[observe,observeDirection,live,selected.market,selected.symbol,interval]);
  const snapshotTail=quoteCandles.at(-1);
  const last=supplemental.candle??snapshotTail;
  const prior=supplemental.candle&&snapshotTail&&supplemental.candle.time>snapshotTail.time?snapshotTail:quoteCandles.at(-2);
  const useLongbridgeHeadline=Boolean(live&&!supplemental.candle&&quote&&quote.provider==='longbridge'&&data?.source.startsWith('Longbridge '));
  const headlinePrice=useLongbridgeHeadline?quote!.price:last?.close??null;
  const headlinePrior=useLongbridgeHeadline?(snapshotTail?.closed===false?quoteCandles.at(-2):snapshotTail):prior;
  const change=headlinePrice!==null&&headlinePrior&&headlinePrior.close!==0?(headlinePrice-headlinePrior.close)/Math.abs(headlinePrior.close)*100:0;
  const quoteSessionLabel=(session?:QuoteSession)=>session==='pre'?t('盘前','Pre-market'):session==='regular'?t('盘中','Regular'):session==='post'?t('盘后','Post-market'):session==='overnight'?t('夜盘','Overnight'):null;
  const currentInstrument=data?{
    ...data.instrument,
    name:data.instrument.market==='cn'&&/^\d{6}(?:\.(?:SH|SZ|BJ))?$/i.test(data.instrument.name.trim())?selected.name:data.instrument.name,
  }:selected;
  const available=data?.availableIntervals||INTERVALS;
  const center=analysis?.centers.at(-1),cal=analysis?.calibration;
  const watchRows=watchTab==='favorites'?watchlist:PRESETS.filter(i=>i.market===market);
  const displayedSearchResults=useMemo(()=>searchMarket==='favorites'?filterWatchlist(watchlist,query,language):searchResults,[searchMarket,watchlist,query,searchResults,language]);
  function choose(i:Instrument){
    cancelPendingImport();
    if(imported||i.market!==selected.market||i.symbol!==selected.symbol)chartFeed.cancel();
    setImported(false);setSelected(i);setMarket(i.market);setSearchOpen(false);setQuery('');
  }
  function chooseInterval(i:Interval){
    cancelPendingImport();
    if(i!==interval)chartFeed.cancel();
    setInterval(i);
  }
  function switchMarket(m:Market){const p=PRESETS.find(i=>i.market===m)!;setWatchTab('all');choose(p);chooseInterval(m==='crypto'?'1h':'1d');}
  function star(i:Instrument){watchlistTouched.current=true;setWatchlist(prev=>{const next=prev.some(w=>w.id===i.id)?prev.filter(w=>w.id!==i.id):[...prev,i];localStorage.setItem(WATCHLIST_STORAGE_KEY,JSON.stringify(next));void persistWatchlistRemote(next);return next;});}
  function exportCSV(){if(!chartSnapshot.length)return;download(`${selected.symbol}-${interval}${replay!==null?'_replay':''}.csv`,serializeCSV(chartSnapshot),'text/csv;charset=utf-8');notify(t(`已导出 ${chartSnapshot.length} 根K线。`,`Exported ${chartSnapshot.length} bars.`));}
  function exportAnalysis(){if(!analysis||!data)return;download(`${selected.symbol}-${interval}-analysis.json`,JSON.stringify({instrument:data.instrument,interval,source:data.source,adjustment:data.adjustment,asOf:data.asOf,delayNotice:data.delayNotice,lastCandle:candles.at(-1)?.time,ruleVersion:analysis.ruleVersion,penMode,replay:replay!==null,candles,analysis,forecast:rawForecast,feedHealth:health},null,2),'application/json');}
  async function importFile(file:File){
    const generation=++importGeneration.current;
    try {
      const text=await file.text();
      if(generation!==importGeneration.current)return;
      const parsed=parseCSV(text,market);
      chartFeed.cancel();
      const symbol=file.name.replace(/\.csv$/i,'').slice(0,40)||'CSV';
      const ins:Instrument={id:`${market}:csv-${symbol}`,symbol,name:'本地导入数据',market,exchange:'CSV',currency:market==='cn'?'CNY':market==='hk'?'HKD':'USD'};
      const data:MarketData={instrument:ins,interval,candles:parsed,source:`本地CSV · ${file.name}`,asOf:new Date().toISOString(),delayNotice:'用户提供的历史数据；保留closed状态，缺少closed列时按已完成处理。',adjustment:'由CSV原始数据决定',warnings:['导入数据未与交易所校验；请确认时区、复权口径和所选周期。'],availableIntervals:[interval]};
      setImported(true);setSelected(ins);setSnapshot({data,receivedAt:Date.now(),higher:{interval:higherInterval(market,interval),status:'imported'}});
      setReplayTime(null);setPlaying(false);setLoading(false);setFeedError(null);
      notify(t(`已导入 ${parsed.length.toLocaleString(locale)} 根K线`,`Imported ${parsed.length.toLocaleString(locale)} bars`));
    }catch(e){
      if(generation===importGeneration.current)notify(e instanceof Error?mt(e.message):t('文件读取失败','Could not read the file'));
    }
  }
  let connectionLabel=market==='commodity'?t('延时行情 · 30秒刷新','Delayed feed · 30s refresh'):t('定时行情 · 30秒刷新','Polling · 30s refresh');
  if(imported) connectionLabel=t('本地数据','Local data');
  else if(replayActive) connectionLabel=t('历史回放 · 刷新暂停','Replay · refresh paused');
  else if(cached) connectionLabel=error?t('本机历史 · 更新失败','Saved history · refresh failed'):t('本机历史 · 正在更新','Saved history · updating');
  else if(error) connectionLabel=push.streaming?t('实时推送 · 历史更新失败','Live · history refresh failed'):data?t('行情未更新','Refresh failed'):t('暂无行情','Data unavailable');
  else if(push.streaming) connectionLabel=t('实时推送','Live stream');
  else if(quote)connectionLabel=quote.quality==='realtime'?t('实时报价 · 轮询','Real-time quote · polling'):t('公开报价 · 轮询','Public quote · polling');
  else if(supplemental.status==='closed')connectionLabel=t('休市','Market closed');
  else if(supplemental.status==='delayed'||market==='commodity'&&supplemental.status==='unconfigured')connectionLabel=t('延时行情','Delayed feed');
  else if(loading&&!data) connectionLabel=t('连接中','Connecting');
  return <div className={`observatory trading-workspace${focused?' chart-focus-layout':''}${sidebarCollapsed?' sidebar-collapsed':''}`}>
    <header className="topbar">
      <div className="topbar-start">
        <a className="brand" href="/">
          <span className="brand-mark" aria-hidden="true"><Activity size={23}/></span>
          <b>{WORKBENCH_BRAND.name[language]}</b>
        </a>

      </div>
      <nav className="official-links" aria-label={t('开发者与社区','Developer and community')}>
        <a href={WORKBENCH_BRAND.developerUrl} target="_blank" rel="noopener noreferrer" title={t('在 X 查看开发者主页','Open the developer profile on X')}>
          <span className="official-x" aria-hidden="true">𝕏</span>
          <span>{t(`开发者（${WORKBENCH_BRAND.developer}）`,`Developer (${WORKBENCH_BRAND.developer})`)}</span>
        </a>
        <a href={WORKBENCH_BRAND.communityUrl} target="_blank" rel="noopener noreferrer" title={t('在 Telegram 打开社区','Open the community on Telegram')}>
          <Send size={16} aria-hidden="true"/>
          <span>{t('社区交流','Community')}</span>
        </a>
      </nav>
      <div className="top-right"><button type="button" className="top-refresh" disabled={loading||imported} aria-busy={loading} aria-label={t('刷新行情','Refresh market data')} title={imported?t('本地导入数据无需在线刷新','Imported data does not need an online refresh'):t('刷新当前标的行情和分析','Refresh this instrument and its analysis')} onClick={()=>void fetchData()}><RefreshCw size={17} className={loading?'spin':''} aria-hidden="true"/><span>{loading?t('刷新中','Refreshing'):t('刷新行情','Refresh')}</span></button><span className={`connection ${error?'warning':''}`}><i/>{connectionLabel}</span><div className="language-switch" role="group" aria-label={t('界面语言','Interface language')}><button aria-pressed={language==='zh'} className={language==='zh'?'active':''} onClick={()=>setLanguage('zh')}>中文</button><button aria-pressed={language==='en'} className={language==='en'?'active':''} onClick={()=>setLanguage('en')}>EN</button></div><WorkbenchThemePicker/></div>
    </header>
    <aside className={`sidebar${sidebarCollapsed?' collapsed':''}`}>
      <div className="sidebar-heading">
        <button type="button" className="sidebar-toggle" onClick={toggleSidebar} aria-expanded={!sidebarCollapsed} aria-label={sidebarCollapsed?t('展开侧栏','Expand sidebar'):t('折叠侧栏','Collapse sidebar')} title={sidebarCollapsed?t('展开侧栏','Expand sidebar'):t('折叠侧栏','Collapse sidebar')}>
          {sidebarCollapsed?<PanelLeftOpen size={14}/>:<PanelLeftClose size={14}/>}
        </button>
        {!sidebarCollapsed&&<><span>{t("市场导航","Markets")}</span><Globe2 size={14}/></>}
      </div>
      <div className="market-menu">{MARKETS.map(m=><button key={m.id} className={market===m.id?'active':''} onClick={()=>switchMarket(m.id)} title={sidebarCollapsed?t(m.title,m.en):undefined}><span className="market-icon">{m.id==='crypto'?'₿':m.id==='us'?'$':m.id==='hk'?'H':m.id==='commodity'?'◇':'A'}</span><span>{t(m.title,m.en)}<small>{m.en}</small></span>{market===m.id&&<span className="active-marker"/>}</button>)}</div>
      {!sidebarCollapsed&&<>
      <div className="sidebar-tabs"><button className={watchTab==='all'?'active':''} onClick={()=>setWatchTab('all')}>{t("常用标的","Popular")}</button><button className={watchTab==='favorites'?'active':''} onClick={()=>setWatchTab('favorites')}>{t("我的自选 ","Watchlist ")}<span>{watchlist.length}</span></button></div>
      <div className="watch-list">{watchRows.map(i=><div className={`watch-row ${selected.id===i.id?'selected':''}`} key={i.id}><button onClick={()=>choose(i)}><span className={`asset-symbol ${i.market}`}>{i.symbol==='BTCUSDT'?'₿':i.symbol==='ETHUSDT'?'Ξ':i.symbol.slice(0,1)}</span><span><b>{displaySymbol(i.symbol)}</b><small>{instrumentName(i.name)}</small></span></button><button className="watch-star" onClick={()=>star(i)} title={watchlist.some(w=>w.id===i.id)?t('移出自选','Remove from watchlist'):t('加入自选','Add to watchlist')} aria-label={`${watchlist.some(w=>w.id===i.id)?t('移出自选','Remove from watchlist'):t('加入自选','Add to watchlist')} ${i.symbol}`}><Star size={12} fill={watchlist.some(w=>w.id===i.id)?'currentColor':'none'}/></button></div>)}{!watchRows.length&&<p className="empty-watch">{t("搜索标的后点星号，建立你的观察列表。","Search for an instrument and star it to build your watchlist.")}</p>}</div>
      <button className="add-symbol" onClick={()=>setSearchOpen(true)}><Search size={14}/>{t('搜索更多标的','Find instruments')} <span>/</span></button>
      </>}
    </aside>
    <main className="workspace">
      <div className="workspace-grid">
        <section className={`chart-panel panel${focused?' chart-focused':''}`}>
          <div className="quote-heading trading-quote"><div className="instrument-identity"><span className={`asset-big ${market}`}>{selected.symbol==='BTCUSDT'?'₿':selected.symbol==='ETHUSDT'?'Ξ':selected.symbol.slice(0,1)}</span><div><button className="instrument-selector" onClick={()=>setSearchOpen(true)}>{displaySymbol(currentInstrument.symbol)}<ChevronDown size={15}/></button><p>{instrumentName(currentInstrument.name)}<span>{marketVenueSuffix(currentInstrument.exchange,language)}{market==='commodity'&&!imported&&(' · '+(currentInstrument.symbol==='CL=F'?t('美元/桶','USD/bbl'):t('美元/盎司','USD/oz')))}</span></p></div><button className={`favorite-button ${watchlist.some(w=>w.id===selected.id)?'selected':''}`} disabled={imported} onClick={()=>star(selected)} aria-label={t("切换当前标的自选","Toggle watchlist")}><Star size={17} fill={watchlist.some(w=>w.id===selected.id)?'currentColor':'none'}/></button></div><div className="quote-price"><strong>{headlinePrice!==null?priceText(headlinePrice):'—'}</strong><span className={change>=0?'positive':'negative'}>{headlinePrice!==null&&headlinePrior&&headlinePrior.close!==0?`${change>=0?'+':''}${change.toFixed(2)}%`:'—'} <small>{t("较前一根","vs previous bar")}</small></span></div>
            <MarketBattle key={selectionKey} symbol={selected.symbol} market={selected.market} interval={interval}
              currency={currentInstrument.currency} session={live?quote?.session:undefined}
              chartPrice={quote?{price:quote.price,kind:quote.quality==='realtime'?'realtime':'public'}:
                data&&last?{price:last.close,kind:push.streaming?'realtime':'candle'}:null}
              analysis={data&&battleMode!=='unavailable'?rawAnalysis:null} forecast={rawForecast} mode={battleMode}/>
            <button className="global-search" aria-label={t('搜索标的','Search instruments')} onClick={()=>setSearchOpen(true)}><Search size={17}/><span>{t('搜索代码或名称','Search symbol or name')}</span><kbd>/</kbd></button>
          </div>
          <div className="chart-toolbar"><div className="interval-buttons">{INTERVALS.map(i=><button key={i} className={interval===i?'active':''} disabled={!available.includes(i)||imported} onClick={()=>chooseInterval(i)}>{t(TIME_LABEL[i],({'1d':'Day','1w':'Week','1M':'Month'} as Partial<Record<Interval,string>>)[i]||i)}</button>)}</div><div className="chart-tools-end">
            <button type="button" className="layer-menu-toggle" aria-expanded={layerMenu} aria-controls="chart-layers" onClick={()=>setLayerMenu(open=>!open)}><Layers3 size={15}/>{t('图层','Layers')}</button>
            <button type="button" className="chart-focus-toggle" ref={focusButton} aria-pressed={focused} onClick={toggleFocus}>{focused?<Minimize2 size={15}/>:<Maximize2 size={15}/>} {focused?t('退出专注','Exit focus'):t('专注看盘','Focus chart')}</button>
            <div className="chart-actions"><button className="icon-button" disabled={loading||imported} onClick={()=>void fetchData()} title={t("刷新行情","Refresh market data")} aria-label={t("刷新行情","Refresh market data")}><RefreshCw size={14} className={loading?'spin':''}/></button><button className="icon-button" disabled={!data} onClick={exportCSV} title={t("导出历史K线CSV","Export candle history as CSV")} aria-label={t("导出CSV","Export CSV")}><Download size={14}/></button><button className="icon-button" onClick={()=>fileInput.current?.click()} title={t("导入CSV","Import CSV")} aria-label={t("导入CSV","Import CSV")}><Upload size={14}/></button></div></div></div>
          {layerMenu&&<div id="chart-layers" className="layer-toolbar"><span><Layers3 size={12}/>{t('结构图层','Layers')}</span>{([['setups','点位预判','Outlook'],['strokes','笔','Strokes'],['segments','线段','Segments'],['centers','中枢','Centers'],['signals','历史信号','Signals'],['fractals','分型','Fractals'],['anchoredVwap','突破均价线','Breakout VWAP']] as const).map(([key,zh,en])=><button type="button" key={key} aria-pressed={layers[key]} className={layers[key]?'active':''} onClick={()=>setLayers(l=>({...l,[key]:!l[key]}))}><span className="layer-state-indicator" aria-hidden="true">{layers[key]&&<Check size={13} strokeWidth={3}/>}</span>{t(zh,en)}</button>)}{layers.centers&&<CenterLayerSelector value={centerLayer} onChange={setCenterLayer}/>}</div>}
          {error&&<div className="data-error" role="alert"><AlertTriangle size={20}/><div>
            <b>{displaySymbol(selected.symbol)} · {t(TIME_LABEL[interval],interval)} · {data?t('行情更新失败','Refresh failed'):t('暂无行情','Data unavailable')}</b>
            <p>{marketLoadErrorText(error,language)} {data&&receivedAt&&t(`图中保留 ${readableTime(receivedAt/1000,locale)} 获取的K线，新信号已暂停。`,`Showing candles fetched at ${readableTime(receivedAt/1000,locale)}. New signals are paused.`)}</p>
            <button disabled={loading} onClick={()=>void fetchData()}>{loading?t('正在重试','Retrying'):t('重新加载','Retry')}</button><button onClick={()=>fileInput.current?.click()}>{t('导入CSV','Import CSV')}</button>
          </div></div>}
          {data&&cached&&!replayActive&&!error&&<div className="source-quote-line" role="status">{t('正在显示本机保存的已完成K线，等待最新行情。','Showing completed candles saved on this computer while updating.')}</div>}
          {data&&(!cached||replayActive)&&(!error||replayActive)&&<FeedStatus data={data} displayBar={last} forecast={rawForecast} health={health} replay={replayActive} imported={imported}/>}
          {quote&&<div className="source-quote-line">
            <strong>{quote.venue}{quote.session&&` · ${quoteSessionLabel(quote.session)}`}{quote.contract&&' · '+quote.contract}</strong>
            <span>{quote.quality==='realtime'?t('最新成交','Last trade'):t('最新报价','Latest quote')} {priceText(quote.price)}</span>
            <time dateTime={new Date(quote.time*1000).toISOString()}>{new Date(quote.time*1000).toLocaleTimeString(locale,{hour12:false})}</time>
            {quote.nativeCandle&&!quote.candle&&<span>{interval} · {t('开','O')} {priceText(quote.nativeCandle.open)}　{t('高','H')} {priceText(quote.nativeCandle.high)}　{t('低','L')} {priceText(quote.nativeCandle.low)}　{t('收','C')} {priceText(quote.nativeCandle.close)}</span>}
          </div>}
          {(data||!error)&&<>
          <TerminalChart key={history.key||`${selected.id}-${interval}-${imported}`} candles={chartSnapshot} liveBar={liveBar} analysisStart={analysisStart} historyPaging={history.paging} penMode={penMode} analysis={analysis} layers={layers} market={market} source={data?.source} symbol={selected.symbol} interval={interval} loading={loading&&!data} forecast={rawForecast??undefined} dataFresh={displayForecast} strokeCenters={strokeCenters} centerLayer={centerLayer}/>
          <LinkedTimeframes data={linkedData} higher={cached&&!replayActive?undefined:higherFeed} replayBar={last} replaying={replayActive} asOf={cutoff} imported={imported}/>
          <div className="replay-toolbar"><span><RotateCcw size={13}/>{replay===null?t('历史回放','Replay'):t('正在回放','Replaying')}</span>
            <button aria-label={t("回退一根K线","Previous bar")} disabled={timeline.length<2} onClick={()=>{setPlaying(false);seekReplay(Math.max(1,(replay??timeline.length)-1));}}><StepBack size={14}/></button>
            <button className={playing?'active':''} aria-label={playing?t('暂停回放','Pause replay'):t('播放历史','Play history')} disabled={timeline.length<2} onClick={()=>{if(replay===null)seekReplay(Math.min(80,timeline.length-1));setPlaying(p=>!p);}}>{playing?<Pause size={14}/>:<Play size={14}/>}</button>
            <button aria-label={t("前进一根K线","Next bar")} disabled={!data||replay===null} onClick={()=>{setPlaying(false);seekReplay((replay??0)+1);}}><StepForward size={14}/></button>
            <input aria-label={t("历史回放进度","Replay position")} type="range" min={1} max={timeline.length||1} value={replay??(timeline.length||1)} disabled={!data} onChange={e=>{setPlaying(false);seekReplay(Number(e.target.value));}}/>
            {replay!==null&&<span className="replay-counter">{chartSnapshot.length} / {timeline.length}</span>}<button className="return-live" disabled={replay===null} onClick={()=>{setReplayTime(null);setPlaying(false);}}>{t("回到最新","Latest")}</button></div>
          <div className="data-source"><span><Radio size={11}/>{data?mt(data.source):t('等待行情源','Waiting for data')} · {data?mt(data.adjustment):'—'}{replay!==null&&<b> · {t('历史回放','Replay')}</b>}</span>{data&&!imported&&interval==='4h'&&(market==='cn'||market==='hk'||market==='us')&&<span>{market==='cn'?t('4H：每交易日一根','4H: one candle per trading day'):market==='hk'?t('4H：按香港常规盘分段，半日市缩短','4H: Hong Kong regular session, shortened on half-days'):t('4H：按纽约常规盘分段，提前收市日缩短','4H: New York regular session, shortened on early closes')}</span>}<span>{chartSnapshot.length?`${readableTime(chartSnapshot[0].time,locale)} — ${readableTime(last!.time,locale)}`:t('数据时间 —','Data time —')}</span></div>
          {data?.instrument.market==='commodity'&&data.warnings.length>0&&<details className="commodity-data-notes"><summary>{t('历史行情说明','Historical data notes')}</summary>{data.warnings.map(warning=><p key={warning}>{mt(warning)}</p>)}</details>}
          <HistoryCoverage data={data} earlierBars={Math.max(0,timeline.length-(data?.candles.length??0))} cachedBars={cachedSeriesBars} onLoadCached={()=>{void history.loadCached(5000);}} loadingCached={history.loading}/>
          {data&&!imported&&(market==='cn'||market==='hk'||market==='us')&&interval==='4h'&&<FourHourCoverage data={data} bars={candles} replay={replay!==null}/>}
          </>}
        </section>
        <aside className="analysis-rail">
          <ConfluencePanel analysis={analysis} loading={loading||pendingContext} interval={interval} market={market} forecast={rawForecast??undefined} dataFresh={displayForecast}
            breakoutFlow={data&&!cached&&!imported&&market==='crypto'&&['BTCUSDT','ETHUSDT'].includes(data.instrument.symbol)&&<BreakoutFlow candles={candles} interval={interval} symbol={data.instrument.symbol} venue={data.instrument.exchange}/>}/>
          <section className="bias-card panel"><div className="card-top"><span><Crosshair size={15}/>{t('多空结构倾向','Long / short bias')}</span></div><div className="bias-label"><span className={`status-dot ${analysis&&analysis.bias.long<50?'bear':''}`}/>{analysis?.bias.label||t('等待结构识别','Waiting for structure')}<small>{replay!==null?t('历史截面','Historical snapshot'):last?.closed===false?t('以已完成K线分析','Closed bars only'):t('当前截面','Current snapshot')}</small></div><div className="bias-numbers"><div><span>{t("多方","Long")}</span><strong className="positive">{analysis?Math.round(analysis.bias.long):'—'}<small>%</small></strong></div><div><span>{market==='cn'?t('看空','Bearish'):t('空方','Short')}</span><strong className="negative">{analysis?Math.round(analysis.bias.short):'—'}<small>%</small></strong></div></div><div className="bias-bar"><span style={{width:`${analysis?.bias.long??50}%`}}/><span style={{width:`${analysis?.bias.short??50}%`}}/></div><p className="bias-note">{rawAnalysis?.bias.label==='样本不足'?t('样本不足，暂按中性显示。','Limited history; showing a neutral bias.'):t('结构倾向 · 非胜率','Structural bias · not win probability')}</p><div className="factor-list">{analysis?.bias.factors.map((f,i)=><div className="factor" key={i} title={f.detail}><span>{f.name}</span><div className="factor-track"><i style={{width:`${Math.min(100,Math.abs(f.value)*4)}%`,background:f.value>=0?'var(--green)':'var(--red)'}}/></div><b className={f.value>=0?'positive':'negative'}>{f.value>0?'+':''}{f.value}</b></div>)||<div className="empty-mini">{t('加载行情后计算结构因子','Factors appear after data loads')}</div>}</div>{market==='cn'&&<p className="market-note">{t('空方表示看空倾向，A股普通账户不能直接裸卖空。','Short expresses bearish bias; ordinary A-share accounts cannot sell naked short.')}</p>}</section>
          <section className="center-card panel"><div className="card-top"><span><Layers3 size={15}/>{t('最近线段中枢','Latest segment center')}</span><span className="mini-tag">{center?`${t('段','S')}${analysis!.centers.length}`:t('待识别','No center yet')}</span></div><div className="structure-stats"><div><small>{t("有效笔","Valid strokes")}</small><b>{analysis?.strokes.filter(s=>s.confirmed).length??'—'}</b></div><div><small>{t("线段","Segments")}</small><b>{analysis?.segments.filter(s=>s.confirmed).length??'—'}</b></div><div><small>{t("线段中枢","Segment centers")}</small><b>{analysis?.centers.length??'—'}</b></div></div><div className="boundary"><span>{t("中枢上沿 ","Center upper ")}<b>ZG</b></span><strong>{center?priceText(center.high):t('尚未形成','Not formed')}</strong></div><div className="boundary"><span>{t("中枢下沿 ","Center lower ")}<b>ZD</b></span><strong>{center?priceText(center.low):t('尚未形成','Not formed')}</strong></div><p className="micro-copy">{center?center.status==='active'?t('观察中枢震荡与次级别离开后的回试。','Track center consolidation and retests after lower-level departures.'):t('最近中枢已被突破，跟踪后续结构。','The latest center has broken; track subsequent structure.'):t('当前区间尚未形成中枢。','No center has formed in this range.')}</p><CenterHistory centers={analysis?.centers??[]} strokeCenters={strokeCenters} candles={candles} interval={interval}/></section>
          <section className="sample-card panel"><div className="card-top"><span><BarChart3 size={15}/>{t('相似样本结果','Similar historical outcomes')}</span><span className="sample-n">n = {cal?.samples??0}</span></div><p className="micro-copy">{t(`相似走势之后 ${cal?.horizon??12} 根K线`,`Next ${cal?.horizon??12} bars after similar structures`)}</p><div className="sample-bar">{cal&&cal.samples>0?<><i style={{width:`${cal.up}%`}}/><i style={{width:`${cal.flat}%`}}/><i style={{width:`${cal.down}%`}}/></>:<i className="no-samples"/>}</div><div className="sample-values"><span><i className="green"/>{t("上涨 ","Up ")}<b>{cal&&cal.samples?`${cal.up.toFixed(0)}%`:'—'}</b></span><span><i className="gray"/>{t("横盘 ","Flat ")}<b>{cal&&cal.samples?`${cal.flat.toFixed(0)}%`:'—'}</b></span><span><i className="red"/>{t("下跌 ","Down ")}<b>{cal&&cal.samples?`${cal.down.toFixed(0)}%`:'—'}</b></span></div><div className="sample-confidence">{cal&&cal.samples>=20?<><CheckCircle2 size={12}/><span>{t('上涨比例95%区间','95% interval for up frequency')} {cal.wilsonLow.toFixed(0)}–{cal.wilsonHigh.toFixed(0)}%</span></>:<><AlertTriangle size={12}/><span>{t("样本不足20个，比例仅供观察","Fewer than 20 samples; descriptive only")}</span></>}</div><p className="micro-copy">{t('历史涨跌分布','Historical price outcomes')}</p></section>
        </aside>
        <section className="outlook-panel panel"><div className="outlook-heading"><div className="outlook-tabs"><button className={signalTab==='setups'?'active':''} onClick={()=>setSignalTab('setups')}>{t("后续点位预判 ","Forward outlook ")}<span>{rawForecast?.status==='ready'?rawForecast.direction==='neutral'?t('支撑 / 阻力','Support / resistance'):t('当前周期','Current timeframe'):'—'}</span></button><button className={signalTab==='signals'?'active':''} onClick={()=>setSignalTab('signals')}>{t("历史信号 ","History ")}<span>{analysis?.signals.length??0}</span></button></div><button className="text-button" onClick={exportAnalysis} disabled={!analysis}>{t("导出分析 ","Export analysis ")}<Download size={12}/></button></div>{signalTab==='setups'?<TradeSetups analysis={analysis} loading={loading||pendingContext} forecast={rawForecast??undefined} dataFresh={displayForecast}/>:signalTab==='scenarios'?<div className="scenario-grid">{(analysis?.scenarios||[{side:'long',title:t('向上延伸','Upward extension'),trigger:t('加载行情后显示触发条件','Trigger rules appear after data loads'),invalidation:'—',target:'—'},{side:'range',title:t('中枢震荡','Center consolidation'),trigger:t('加载行情后显示结构区间','Structure range appears after data loads'),invalidation:'—',target:'—'},{side:'short',title:t('向下演化','Downward extension'),trigger:t('加载行情后显示触发条件','Trigger rules appear after data loads'),invalidation:'—',target:'—'}]).map((s,i)=><article className={`scenario ${s.side}`} key={s.side}><div className="scenario-title"><span className="scenario-icon">{s.side==='long'?<ArrowUpRight size={18}/>:s.side==='short'?<ArrowDownRight size={18}/>:<Activity size={18}/>}</span><h3>{s.title}</h3><span>0{i+1}</span></div><div className="scenario-line"><span>{t("触发","Trigger")}</span><p>{s.trigger}</p></div><div className="scenario-line"><span>{t("观察","Target")}</span><p>{s.target}</p></div><div className="scenario-invalidation">{t('失效','Invalidation')} · {s.invalidation}</div></article>)}</div>:<div className="signals-table">{analysis?.signals.length?<table><thead><tr><th>{t("结构极值时间","Extreme time")}</th><th>{t("结构信号","Structure signal")}</th><th>{t("价格","Price")}</th><th>{t("状态","Status")}</th></tr></thead><tbody>{[...analysis.signals].reverse().slice(0,30).map((s,i)=><tr key={i}><td>{readableTime(s.time,locale)}</td><td className={s.side==='long'?'positive':'negative'}>{s.label}</td><td>{priceText(s.price)}</td><td><span className="signal-status">{s.confirmed?t('结构确认','Confirmed structure'):t('候选信号','Candidate')}</span></td></tr>)}</tbody></table>:<p className="empty-signals">{t("当前历史窗口未发现满足条件的结构信号。","No qualifying structure signals in this history window.")}</p>}</div>}<div className="scenario-footer"><span>{t('预判随当前周期行情更新；历史记录保留发布时点位','Outlooks update with this timeframe; historical records retain published levels')}</span></div></section>
      </div>
      <footer className="workspace-footer"><span>{push.streaming?t('当前K线随推送更新，结构信号按已完成K线确认。','The current candle updates live. Structure signals use completed candles.'):data?mt(data.delayNotice):t('加密货币 · 美股 · 港股 · A股 · 大宗商品','Crypto · US · HK · A-shares · Commodities')}</span></footer>
      <WatchMonitor watchlist={watchlist} interval={interval} enabled={monitorEnabled&&live} onEnabledChange={setMonitorEnabled} onSnapshot={onWatchSnapshot}/>
      <ForecastActivity journal={journal} data={data} notices={notices} saved={journalSaved}/>
      <DirectionScorecard records={directionRecords} saved={directionSaved} data={data} forecast={rawForecast}/>
      <ForecastValidationPanel selected={currentInstrument} interval={interval} source={data?.source} adjustment={data?.adjustment}/>
    </main>
    <input type="file" accept=".csv,text/csv" ref={fileInput} hidden onChange={e=>{const f=e.target.files?.[0];e.target.value='';if(f)void importFile(f);}}/>
    {toast&&<div className="toast" role="status"><Check size={16}/>{toast}</div>}
    {searchOpen&&<div className="modal-backdrop" onMouseDown={e=>{if(e.target===e.currentTarget)setSearchOpen(false);}}><div className="search-modal" role="dialog" aria-modal="true" aria-labelledby="search-title"><div className="modal-search-input"><Search size={21}/><input ref={searchInput} id="search-title" value={query} onChange={e=>setQuery(e.target.value)} placeholder={t('搜索代码或名称，如 BTC、NVDA、00700.HK、茅台、黄金…','Search by name or symbol, e.g. BTC, NVDA, 00700.HK, Gold…')}/><button onClick={()=>setSearchOpen(false)} aria-label={t("关闭搜索","Close search")}><X size={20}/></button></div><div className="search-markets"><button type="button" className={searchMarket==='favorites'?'active':''} onClick={()=>setSearchMarket('favorites')}>{t('自选','Watchlist')}</button><button type="button" className={searchMarket==='all'?'active':''} onClick={()=>setSearchMarket('all')}>{t('全市场','All markets')}</button>{MARKETS.map(m=><button type="button" key={m.id} className={searchMarket===m.id?'active':''} onClick={()=>setSearchMarket(m.id)}>{t(m.title,m.en)}</button>)}<span>{query.trim()?t('搜索结果','Results'):searchMarket==='favorites'?t(`我的自选 · ${watchlist.length}`,`Watchlist · ${watchlist.length}`):t('常用标的','Popular')}</span></div>{searchWarning&&<p className="search-warning">{mt(searchWarning)}</p>}<div className="search-results">{searchMarket!=='favorites'&&searching?<div className="search-empty"><span className="spinner"/>{t('正在搜索行情目录','Searching market directories')}</div>:displayedSearchResults.length?displayedSearchResults.map(i=><button key={i.id} onClick={()=>choose(i)}><span className="search-result-symbol">{displaySymbol(i.symbol)}</span><span className="search-result-name">{instrumentName(i.name)}</span><small>{t(MARKETS.find(m=>m.id===i.market)!.title,MARKETS.find(m=>m.id===i.market)!.en)}{marketVenueSuffix(i.exchange,language)}</small><ChevronRight size={15}/></button>):<div className="search-empty">{searchMarket==='favorites'?(query.trim()?t('自选中未找到匹配标的，可切换到“全市场”搜索。','No matching instruments in your watchlist. Switch to All markets to search.'):t('暂无自选标的，点击标的旁星号即可加入自选。','No watchlist instruments yet. Star an instrument to add it.')):t("未找到匹配标的。请尝试完整代码、英文名或六位股票代码。","No matching instruments. Try the company name, full ticker or six-digit A-share code.")}</div>}</div><div className="search-foot"><span>{t("按市场查找，避免同名代码混淆","Search all markets or filter by exchange group")}</span><kbd>{t("ESC 关闭","ESC Close")}</kbd></div></div></div>}
  </div>;
}

