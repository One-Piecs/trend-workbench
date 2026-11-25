"use client";
import {useCallback, useMemo, useState} from 'react';
import {useLanguage,type Language} from '@/lib/language';
import {loadForecastValidationReport,type ValidationReportResult,type ValidationSummary} from '@/lib/forecast-validation-report';
import type {CacheBacktestResult} from '@/lib/cache-backtest';
import type {Instrument,Interval,Market} from '@/lib/market-types';
import {forecastPeriod} from './forecast-copy';

const marketNames={crypto:['加密货币','Crypto'],us:['美股','US equities'],hk:['港股','HK equities'],cn:['A股','A-shares'],commodity:['大宗商品','Commodities']} as const;

export interface CachedSeriesEntry {
  key:string;
  market:Market;
  symbol:string;
  interval:Interval;
  source:string;
  adjustment:string;
  contract?:string;
  pinned:boolean;
  barCount:number;
  firstTime:number|null;
  lastTime:number|null;
  lastSyncAt:number|null;
  lastError:string|null;
  backfillDone:boolean;
  segmentCount:number;
}

interface CacheStatusPayload {
  enabled:boolean;
  intervals:Interval[];
  running:boolean;
  currentTask:{market:Market;symbol:string;interval:Interval;phase:'incremental'|'backfill'}|null;
  lastCycleAt:number|null;
  watchlistCount:number;
  series:CachedSeriesEntry[];
}

export interface ForecastValidationPanelProps {
  language?:Language;
  selected?:Instrument;
  interval?:Interval;
  source?:string;
  adjustment?:string;
}

export function ForecastValidationResults({summary,language}:{summary:ValidationSummary;language:Language}) {
  const t=(zh:string,en:string)=>language==='zh'?zh:en;
  const insufficient=summary.results.some(r=>r.baseline.completed<30||r.shadow.completed<30||r.baseline.sampleStatus==='insufficient'||r.shadow.sampleStatus==='insufficient');
  const number=(value:number|null)=>value===null?'—':`${value.toFixed(2)} R`;
  const hasMinutes=summary.results.some(row=>row.baseline.minuteResolved!==undefined);
  return <>
    <p className="validation-context">{insufficient?t('历史对照 · 样本不足，趋势筛选未启用','Historical comparison · insufficient sample; trend filter remains disabled'):t('历史对照 · 仍待验证，趋势筛选未启用','Historical comparison · unvalidated; trend filter remains disabled')}</p>
    <p className="validation-date">{t('报告生成：','Report generated: ')}<time dateTime={summary.generatedAt}>{new Date(summary.generatedAt).toLocaleString(language==='zh'?'zh-CN':'en-US',{year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false})}</time></p>
    <div className="validation-table-scroll" tabIndex={0} role="region" aria-label={t('按市场与周期分别列出的历史对照','Historical comparisons separated by market and timeframe')}>
      <table className="validation-table">
        <caption>{t('各标的与周期单独计算，不合并统计','Each instrument and timeframe is calculated separately')}</caption>
        <thead><tr><th scope="col">{t('样本','Sample')}</th><th scope="col">{t('原预判已结束数','Baseline completed')}</th><th scope="col">{t('趋势筛选已结束数','Trend-filtered completed')}</th><th scope="col">{t('原预判平均净R','Baseline mean net R')}</th><th scope="col">{t('筛选后平均净R','Filtered mean net R')}</th>{hasMinutes&&<th scope="col">{t('原预判同根双触及','Baseline dual hits')}</th>}</tr></thead>
        <tbody>{summary.results.map(row=>{
          const prefix=`${row.market}-`,suffix=`-${row.interval}`;
          const symbol=row.name.startsWith(prefix)&&row.name.endsWith(suffix)?row.name.slice(prefix.length,-suffix.length):row.name;
          return <tr key={`${row.market}:${row.interval}:${row.name}`}>
            <th scope="row"><strong>{symbol}</strong><span>{marketNames[row.market][language==='zh'?0:1]} · {forecastPeriod(row.interval,language)}</span><small>{t(`${row.closedBars}根K线 · ${row.folds}段验证`,`${row.closedBars} candles · ${row.folds} folds`)}</small></th>
            <td>{row.baseline.completed}</td><td>{row.shadow.completed}</td><td>{number(row.baseline.meanNetR)}</td><td>{number(row.shadow.meanNetR)}</td>
            {hasMinutes&&<td>{row.baseline.minuteResolved===undefined?'—':row.baseline.minuteResolved||row.baseline.ambiguousExits?
              t(`分钟线查清 ${row.baseline.minuteResolved} · 顺序不明 ${row.baseline.ambiguousExits}`,`${row.baseline.minuteResolved} resolved · ${row.baseline.ambiguousExits} uncertain`):
              t('未出现','None')}</td>}
          </tr>;
        })}</tbody>
      </table>
    </div>
    {hasMinutes&&<p className="validation-explanation">{t('同根双触及指入场后同一根K线碰到止损和第二止盈。同源分钟线能查清先后时计入结果；顺序不明的单列，不计入平均净R。','A dual hit touches both the stop and second target in one bar after entry. Same-source minute candles can resolve the order. Uncertain exits are excluded from mean net R.')}</p>}
    <p className="validation-explanation">{t('R按最初止损距离计，已计假设成本；不是账户收益。','R uses the initial stop distance and includes assumed costs; it is not an account return.')}</p>
  </>;
}

function shortSource(source:string):string {
  return source.split(' · ')[0].trim();
}

function formatStamp(sec:number|null,locale:string):string {
  if(!sec)return '—';
  return new Date(sec*1000).toLocaleString(locale,{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false});
}

function formatPct(value:number|null,digits=1):string {
  return value===null?'—':`${(value*100).toFixed(digits)}%`;
}

function formatNum(value:number|null|undefined,suffix='',digits=2):string {
  return value===null||value===undefined?'—':`${value.toFixed(digits)}${suffix}`;
}

export default function ForecastValidationPanel({language:override,selected,interval,source,adjustment}:ForecastValidationPanelProps) {
  const languageContext=useLanguage(),language=override??languageContext.language,locale=language==='zh'?'zh-CN':'en-US';
  const t=(zh:string,en:string)=>language==='zh'?zh:en;
  const [report,setReport]=useState<ValidationReportResult|null>(null);
  const [cacheStatus,setCacheStatus]=useState<CacheStatusPayload|null>(null);
  const [loading,setLoading]=useState(false);
  const [selectedKey,setSelectedKey]=useState<string>('');
  const [maxBars,setMaxBars]=useState<number>(2000);
  const [folds,setFolds]=useState<number>(3);
  const [running,setRunning]=useState(false);
  const [runError,setRunError]=useState<string>('');
  const [backtestResult,setBacktestResult]=useState<(CacheBacktestResult&{cache?:{key:string;totalBars:number;segmentCount:number;truncated:boolean}})|null>(null);

  const fetchCacheStatus=useCallback(async():Promise<CacheStatusPayload|null>=>{
    try{
      const res=await fetch('/api/cache/status');
      if(!res.ok)return null;
      return await res.json() as CacheStatusPayload;
    }catch{
      return null;
    }
  },[]);

  async function load(){
    if(loading||(report&&cacheStatus))return;
    setLoading(true);
    const [staticReport,statusPayload]=await Promise.all([loadForecastValidationReport(),fetchCacheStatus()]);
    setReport(staticReport);
    setCacheStatus(statusPayload);
    setLoading(false);
  }

  async function refreshStatus(){
    const payload=await fetchCacheStatus();
    if(payload)setCacheStatus(payload);
  }

  const eligibleSeries=useMemo(()=>{
    const list=cacheStatus?.series??[];
    return list.filter(s=>s.barCount>=100);
  },[cacheStatus]);

  const effectiveSelectedKey=useMemo(()=>{
    if(selectedKey&&eligibleSeries.some(s=>s.key===selectedKey))return selectedKey;
    if(selected&&interval){
      const exact=eligibleSeries.find(s=>
        s.market===selected.market
        &&s.symbol.toUpperCase()===selected.symbol.toUpperCase()
        &&s.interval===interval
        &&(!source||s.source===source)
        &&(!adjustment||s.adjustment===adjustment)
      );
      if(exact)return exact.key;
      const samePair=eligibleSeries.find(s=>s.market===selected.market&&s.symbol.toUpperCase()===selected.symbol.toUpperCase()&&s.interval===interval);
      if(samePair)return samePair.key;
    }
    return eligibleSeries[0]?.key??'';
  },[selectedKey,eligibleSeries,selected,interval,source,adjustment]);

  const activeSeries=useMemo(
    ()=>eligibleSeries.find(s=>s.key===effectiveSelectedKey)??null,
    [eligibleSeries,effectiveSelectedKey],
  );

  async function runBacktest(targetSeries:CachedSeriesEntry|null){
    if(!targetSeries||running)return;
    setSelectedKey(targetSeries.key);
    setRunning(true);
    setRunError('');
    try{
      const res=await fetch('/api/validation/run',{
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify({
          market:targetSeries.market,
          symbol:targetSeries.symbol,
          interval:targetSeries.interval,
          source:targetSeries.source,
          adjustment:targetSeries.adjustment,
          ...(targetSeries.contract&&{contract:targetSeries.contract}),
          maxBars,
          folds,
        }),
      });
      const body=await res.json() as (CacheBacktestResult&{cache?:{key:string;totalBars:number;segmentCount:number;truncated:boolean};error?:string});
      if(!res.ok)throw new Error(body.error||t('回测运行失败。','Backtest failed.'));
      setBacktestResult(body);
    }catch(error){
      setRunError(error instanceof Error?error.message:t('回测运行失败。','Backtest failed.'));
    }finally{
      setRunning(false);
    }
  }

  function downloadJson(name:string,value:unknown){
    const url=URL.createObjectURL(new Blob([JSON.stringify(value,null,2)],{type:'application/json;charset=utf-8'}));
    const anchor=document.createElement('a');anchor.href=url;anchor.download=name;anchor.click();
    setTimeout(()=>URL.revokeObjectURL(url),0);
  }

  function csvExportHref(s:CachedSeriesEntry):string {
    const query=new URLSearchParams({
      market:s.market,
      symbol:s.symbol,
      interval:s.interval,
      source:s.source,
      adjustment:s.adjustment,
      ...(s.contract&&{contract:s.contract}),
      limit:String(Math.min(20000,Math.max(100,s.barCount))),
      format:'csv',
    });
    return `/api/cache/candles?${query}`;
  }

  const bt=backtestResult;
  const btInsufficient=bt?bt.status==='insufficient-history'||bt.baseline.completed<30||bt.shadow.completed<30:false;

  return <details className="forecast-validation panel" data-testid="forecast-validation-panel" onToggle={event=>{if(event.currentTarget.open)void load();}}>
    <summary><span>{t('预判验证','Outlook validation')}</span><small>{t('查看历史对照与本机缓存回测','View historical comparison and local cache backtests')}</small></summary>
    <div className="validation-content" aria-busy={loading||running}>
      {loading?<p role="status">{t('正在读取本机状态与报告','Reading local cache status and report')}</p>:<>
        {cacheStatus&&<section className="validation-cache-section">
          <div className="validation-cache-header">
            <div>
              <strong>{t('自选历史缓存与滚动回测','Watchlist cache & walk-forward backtest')}</strong>
              <p className="validation-context">
                {cacheStatus.enabled
                  ?cacheStatus.running&&cacheStatus.currentTask
                    ?t(`后台采集中：${cacheStatus.currentTask.symbol} · ${cacheStatus.currentTask.interval}（${cacheStatus.currentTask.phase==='backfill'?'历史回补':'增量同步'}） · 自选 ${cacheStatus.watchlistCount} 项`,
                      `Background sync running: ${cacheStatus.currentTask.symbol} · ${cacheStatus.currentTask.interval} (${cacheStatus.currentTask.phase}) · Watchlist ${cacheStatus.watchlistCount}`)
                    :t(`后台采集已开启（周期 ${cacheStatus.intervals.join(', ')}） · 自选 ${cacheStatus.watchlistCount} 项${cacheStatus.lastCycleAt?` · 上轮完成 ${formatStamp(Math.floor(cacheStatus.lastCycleAt/1000),locale)}`:''}`,
                      `Background sync enabled (${cacheStatus.intervals.join(', ')}) · Watchlist ${cacheStatus.watchlistCount}${cacheStatus.lastCycleAt?` · Last cycle ${formatStamp(Math.floor(cacheStatus.lastCycleAt/1000),locale)}`:''}`)
                  :t('桌面按需缓存模式（常驻服务端可启用后台持续采集） · 自选 ','On-demand desktop cache (daemon server enables continuous sync) · Watchlist ')+cacheStatus.watchlistCount}
              </p>
            </div>
            <button type="button" className="validation-download" onClick={()=>void refreshStatus()}>{t('刷新状态','Refresh')}</button>
          </div>

          {cacheStatus.series.length>0?<div className="validation-table-scroll" tabIndex={0} role="region" aria-label={t('已缓存的自选历史序列','Cached watchlist history series')}>
            <table className="validation-table validation-cache-table">
              <thead><tr>
                <th scope="col">{t('标的 / 周期','Instrument')}</th>
                <th scope="col">{t('行情源','Feed')}</th>
                <th scope="col">{t('已存K线','Bars')}</th>
                <th scope="col">{t('时间范围','Range')}</th>
                <th scope="col">{t('回补状态','Backfill')}</th>
                <th scope="col">{t('操作','Actions')}</th>
              </tr></thead>
              <tbody>{cacheStatus.series.map(s=><tr key={s.key}>
                <th scope="row"><strong>{s.symbol}</strong><span>{marketNames[s.market][language==='zh'?0:1]} · {forecastPeriod(s.interval,language)}</span></th>
                <td><span>{shortSource(s.source)}</span></td>
                <td>{s.barCount.toLocaleString(locale)}</td>
                <td><small>{formatStamp(s.firstTime,locale)} — {formatStamp(s.lastTime,locale)}</small></td>
                <td>{s.lastError?<span title={s.lastError}>{t('受限/异常','Limited')}</span>:s.backfillDone?t('已完成','Complete'):t('采集/待回补','Syncing')}</td>
                <td className="validation-row-actions">
                  <button type="button" className="validation-mini-btn" disabled={running||s.barCount<100} onClick={()=>void runBacktest(s)}>{t('回测','Backtest')}</button>
                  <a className="validation-mini-btn" href={csvExportHref(s)} download={`${s.symbol}-${s.interval}-cached.csv`}>CSV</a>
                </td>
              </tr>)}</tbody>
            </table>
          </div>:<p className="validation-unverified">{t('暂未缓存到自选标的K线，加星标或访问图表后会自动写入本机缓存。','No cached watchlist series yet. Star an instrument or load a chart to populate the cache.')}</p>}

          {eligibleSeries.length>0&&<div className="validation-runner-bar">
            <label>
              <span>{t('回测序列','Series')}</span>
              <select value={effectiveSelectedKey} onChange={e=>setSelectedKey(e.target.value)} disabled={running}>
                {eligibleSeries.map(s=><option key={s.key} value={s.key}>{s.symbol} · {s.interval} · {shortSource(s.source)} ({s.barCount})</option>)}
              </select>
            </label>
            <label>
              <span>{t('K线数量','Max bars')}</span>
              <select value={maxBars} onChange={e=>setMaxBars(Number(e.target.value))} disabled={running}>
                {[1000,2000,4000,6000].map(n=><option key={n} value={n}>{n}</option>)}
              </select>
            </label>
            <label>
              <span>{t('滚动折数','Folds')}</span>
              <select value={folds} onChange={e=>setFolds(Number(e.target.value))} disabled={running}>
                {[2,3,5].map(n=><option key={n} value={n}>{n}</option>)}
              </select>
            </label>
            <button type="button" className="validation-run-btn" disabled={running||!activeSeries} onClick={()=>void runBacktest(activeSeries)}>
              {running?t('正在回测…','Running…'):t('运行本机缓存回测','Run cached backtest')}
            </button>
          </div>}

          {runError&&<p className="validation-error" role="alert">{runError}</p>}

          {bt&&<div className="validation-live-result">
            <p className="validation-context">
              {bt.status==='insufficient-history'
                ?t('历史不足，样本量未达到最小滚动验证要求','Insufficient history for walk-forward validation')
                :btInsufficient
                  ?t('历史对照 · 样本不足（不足30笔已结束模拟），趋势筛选未启用','Historical comparison · insufficient sample (<30 closed), trend filter disabled')
                  :t('历史对照 · 仍待验证，趋势筛选未启用','Historical comparison · unvalidated, trend filter remains disabled')}
            </p>
            <p className="validation-date">
              <strong>{bt.data.symbol}</strong> · {marketNames[bt.data.market][language==='zh'?0:1]} · {forecastPeriod(bt.data.interval,language)} · {shortSource(bt.data.source)} · {t(`${bt.data.closedBars} 根已完成K线`,`${bt.data.closedBars} closed bars`)}
              {bt.data.higherInterval&&bt.data.higherBars>0&&` · ${t(`大周期 ${bt.data.higherInterval} (${bt.data.higherBars} 根)`,`Higher ${bt.data.higherInterval} (${bt.data.higherBars} bars)`)}`}
              {` · ${formatStamp(bt.data.firstTime,locale)} — ${formatStamp(bt.data.lastTime,locale)} · ${bt.durationMs} ms`}
            </p>
            <div className="validation-table-scroll" tabIndex={0} role="region" aria-label={t('本机缓存滚动回测结果','Local cache walk-forward backtest results')}>
              <table className="validation-table">
                <thead><tr>
                  <th scope="col">{t('对照口径','Group')}</th>
                  <th scope="col">{t('发布预判','Published')}</th>
                  <th scope="col">{t('模拟入场','Entries')}</th>
                  <th scope="col">{t('已结束','Closed')}</th>
                  <th scope="col">{t('胜率','Win rate')}</th>
                  <th scope="col">{t('平均净R','Mean net R')}</th>
                  <th scope="col">{t('中位净R','Median net R')}</th>
                  <th scope="col">{t('平均净收益','Mean net %')}</th>
                  <th scope="col">{t('T2 / 止损 / 跳空','T2 / Stop / Gap')}</th>
                  <th scope="col">{t('同根双触及','Dual hits')}</th>
                </tr></thead>
                <tbody>
                  {([
                    [t('原预判 (Baseline)','Baseline'),bt.baseline],
                    [t('趋势筛选 (Shadow)','Trend-filtered (Shadow)'),bt.shadow],
                  ] as const).map(([label,side])=><tr key={label}>
                    <th scope="row"><strong>{label}</strong><small>{t(`多 ${side.longCompleted} · 空 ${side.shortCompleted}`,`Long ${side.longCompleted} · Short ${side.shortCompleted}`)}</small></th>
                    <td>{side.published}</td>
                    <td>{side.modeledEntries}</td>
                    <td>{side.completed}</td>
                    <td>{formatPct(side.winRate)}</td>
                    <td>{formatNum(side.meanNetR,' R')}</td>
                    <td>{formatNum(side.medianNetR,' R')}</td>
                    <td>{formatNum(side.meanNetReturnPct,'%')}</td>
                    <td>{`${side.exitReasons.target2} / ${side.exitReasons.stop} / ${side.exitReasons.gapStop}`}</td>
                    <td>{side.minuteResolved||side.ambiguousExits?t(`分钟线 ${side.minuteResolved} · 不明 ${side.ambiguousExits}`,`${side.minuteResolved} min · ${side.ambiguousExits} unc.`):t('无','None')}</td>
                  </tr>)}
                </tbody>
              </table>
            </div>

            {bt.folds.length>0&&<div className="validation-table-scroll" tabIndex={0} role="region" aria-label={t('分折明细','Per-fold breakdown')}>
              <table className="validation-table">
                <thead><tr>
                  <th scope="col">{t('折次','Fold')}</th>
                  <th scope="col">{t('窗口范围','Window')}</th>
                  <th scope="col">{t('K线数','Bars')}</th>
                  <th scope="col">{t('大周期就绪','Higher ready')}</th>
                  <th scope="col">{t('原预判 (N / 胜率 / 净R)','Baseline (N / Win / R)')}</th>
                  <th scope="col">{t('趋势筛选 (N / 胜率 / 净R)','Shadow (N / Win / R)')}</th>
                </tr></thead>
                <tbody>{bt.folds.map(f=><tr key={f.number}>
                  <th scope="row"><strong>#{f.number}</strong></th>
                  <td><small>{formatStamp(f.startTime,locale)} — {formatStamp(f.endTime,locale)}</small></td>
                  <td>{f.bars}</td>
                  <td>{`${f.higherReady}/${f.snapshots}`}</td>
                  <td>{`${f.baseline.completed} / ${formatPct(f.baseline.winRate)} / ${formatNum(f.baseline.meanNetR,'R')}`}</td>
                  <td>{`${f.shadow.completed} / ${formatPct(f.shadow.winRate)} / ${formatNum(f.shadow.meanNetR,'R')}`}</td>
                </tr>)}</tbody>
              </table>
            </div>}

            {bt.recentTrades.length>0&&<details className="validation-trades-details">
              <summary>{t(`查看最近 ${bt.recentTrades.length} 笔已结束模拟交易`,`Inspect latest ${bt.recentTrades.length} closed trades`)}</summary>
              <div className="validation-table-scroll" tabIndex={0}>
                <table className="validation-table">
                  <thead><tr>
                    <th scope="col">{t('方向','Side')}</th>
                    <th scope="col">{t('入场时间','Entry time')}</th>
                    <th scope="col">{t('入场价','Entry')}</th>
                    <th scope="col">{t('出场时间','Exit time')}</th>
                    <th scope="col">{t('出场价','Exit')}</th>
                    <th scope="col">{t('方式','Reason')}</th>
                    <th scope="col">{t('净R','Net R')}</th>
                    <th scope="col">{t('净收益%','Net %')}</th>
                    <th scope="col">{t('筛选','Filter')}</th>
                  </tr></thead>
                  <tbody>{bt.recentTrades.map(tr=><tr key={tr.id}>
                    <td>{tr.side==='long'?t('做多','Long'):t('做空','Short')}</td>
                    <td><small>{formatStamp(tr.entryAt??null,locale)}</small></td>
                    <td>{formatNum(tr.entryPrice)}</td>
                    <td><small>{formatStamp(tr.exitAt??null,locale)}</small></td>
                    <td>{formatNum(tr.exitPrice)}</td>
                    <td>{tr.exitReason??'—'}{tr.intrabarResolution==='minute'?' (1m)':''}</td>
                    <td>{formatNum(tr.netR,' R')}</td>
                    <td>{formatNum(tr.netReturnPct,'%')}</td>
                    <td>{tr.shadowAccepted?t('通过','Pass'):'—'}</td>
                  </tr>)}</tbody>
                </table>
              </div>
            </details>}

            <p className="validation-explanation">{t('滚动样本内禁止未来函数，每折独立按冻结入场区与次根开盘模拟并扣除双边假设手续费与滑点；仅供参考，不构成交易收益保证。','Walk-forward runs strictly in chronological order without look-ahead, enters at next open plus assumed slippage/fees, and represents research metrics only.')}</p>
            <button type="button" className="validation-download" onClick={()=>downloadJson(`${bt.data.symbol}-${bt.data.interval}-backtest.json`,bt)}>{t('下载本次回测 JSON','Download backtest JSON')}</button>
          </div>}
        </section>}

        {report?.status==='ready'?<div className="validation-prebuilt-section">
          <ForecastValidationResults summary={report.summary} language={language}/>
          <button type="button" className="validation-download" onClick={()=>downloadJson('forecast-validation-summary.json',report.raw)}>{t('下载本次报告 JSON','Download this report as JSON')}</button>
        </div>:!cacheStatus&&<p className="validation-unverified">{t('当前模型尚未验证。','The current model has not been validated.')}</p>}
      </>}
    </div>
  </details>;
}
