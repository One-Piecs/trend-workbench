import type { Analysis } from '@/lib/market-types';
import type { ReactNode } from 'react';
import { isDirectionUnclear } from '@/lib/plan-presentation';
import { useLanguage } from '@/lib/language';
import { priceText } from './terminal-chart';
import { PlanConfluence, confluenceSummary } from './confluence-panel';
import { candleCompletionCopy } from '@/lib/candle-copy';
import type { MarketForecast } from '@/lib/forecast-types';
import ForecastPanel from './forecast-panel';

function PlanRecords({muted,children}:{muted:boolean;children:ReactNode}) {
  const {t}=useLanguage();
  return muted?<details className="unclear-plan-records" data-testid="unclear-plan-records"><summary>{t('查看计划记录','View plan records')}</summary>{children}</details>:<>{children}</>;
}

function LegacyTradeSetups({analysis,loading,historicalOnly=false}:{analysis:Analysis|null;loading:boolean;historicalOnly?:boolean}) {
  const {t,locale,language}=useLanguage();
  const plans=analysis?.tradePlans||[];
  const decision=analysis?.decision;
  const unclear=historicalOnly||isDirectionUnclear(decision);
  const barTime=(time:number)=>new Date(time*1000).toLocaleString(locale,{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false});
  const role=(status:string)=>status==='triggered'
    ?unclear?t('历史触发记录','Historical trigger record'):t('已有触发 · 继续跟踪','Previously triggered · tracking')
    :status==='untriggered'
      ?decision?.state==='tracking'?t('另一方向 · 等待触发','Other direction · awaiting trigger'):t('等待K线结束确认','Awaiting candle-close confirmation')
      :t('方案已结束','Plan ended');
  return <div className="trade-setups-panel" role="region" aria-label={t('多空交易计划','Long and short trade plans')}>
    {decision&&!historicalOnly&&<div className={`trade-decision ${unclear?'quiet':`${decision.direction} ${decision.state}`}`}><strong>{decision.title}</strong><p>{decision.summary}</p>{analysis?.confluence&&!unclear&&<p className="confluence-summary">{confluenceSummary(analysis,language)}</p>}</div>}
    <PlanRecords muted={unclear&&!historicalOnly} key={unclear?plans.map(p=>p.id).join(':'):'active'}>
    <p className="setups-intro">{historicalOnly?t('以下记录仅描述历史价格事件，不表示持仓，也不作为当前操作依据。','These records describe historical price events, not positions or current action guidance.'):unclear?t('以下为已有方案记录，不是新的入场提示。','These are existing plan records, not new entry signals.'):t('多头 / 空头按钮用于切换查看方案。已触发的计划继续跟踪，不表示此刻重新入场。','Long / Short switches the plan being viewed. A triggered plan remains under tracking; it is not a fresh entry signal.')}</p>
    {plans.length?<div className="trade-setup-grid">{plans.map(s=><article key={s.id} className={`trade-setup ${s.side}`} data-testid={`trade-plan-${s.side}`}>
      <header><h3>{s.label}</h3><span className={`plan-state ${s.status}`}>{s.status==='triggered'?unclear?t('历史已触发','Previously triggered'):t('已触发 · 跟踪中','Triggered · tracking'):s.statusLabel}</span></header>
      <div className="plan-priority">{role(s.status)} · {s.strategy}</div>
      {analysis&&!historicalOnly&&<PlanConfluence analysis={analysis} plan={s} language={language}/>}
      {s.triggeredAt&&<p className="plan-trigger-bar">{t('触发K线','Triggered bar')} {barTime(s.triggeredAt)}</p>}
      <div className="setup-price"><strong>{priceText(s.entryLow)} – {priceText(s.entryHigh)}</strong><span>{s.status==='triggered'?t('原入场区','Original entry zone'):t('参考入场区','Reference entry zone')}</span></div>
      <div className="plan-level-grid">
        <div><span>{t('K线结束确认价','Candle-close trigger')}</span><strong>{priceText(s.triggerPrice)}</strong></div>
        <div className="plan-stop"><span>{t('止损价','Stop loss')}</span><strong>{priceText(s.stopLoss)}</strong></div>
        <div><span>{t('第一目标 T1','Target T1')}</span><strong>{priceText(s.target1)}</strong><small>{t('盈亏比','Reward / risk')} {s.rr1.toFixed(2)} : 1</small></div>
        <div><span>{t('第二目标 T2','Target T2')}</span><strong>{priceText(s.target2)}</strong><small>{t('盈亏比','Reward / risk')} {s.rr2.toFixed(2)} : 1</small></div>
      </div>
      <p className="plan-status-reason">{s.status==='untriggered'
        ?t(
          `等待本周期K线结束，结束价${s.side==='long'?'从下向上突破':'从上向下跌破'} ${priceText(s.triggerPrice)}，且位于 ${priceText(s.entryLow)}–${priceText(s.entryHigh)} 入场区内。`,
          `Wait for a candle close to cross ${s.side==='long'?'above':'below'} ${priceText(s.triggerPrice)} from ${s.side==='long'?'below':'above'}, and close within ${priceText(s.entryLow)}–${priceText(s.entryHigh)}.`)
        :candleCompletionCopy(s.statusReason)}</p>
      <dl>
        {s.status==='untriggered'&&<div><dt>{t('执行提示','Entry reminder')}</dt><dd>{t('K线未结束时触及不触发；结束价越过入场区则跳过，不追价。','An intrabar touch does not trigger entry. Skip a close beyond the entry zone; do not chase.')}</dd></div>}
        <div><dt>{t('失效条件','Invalidation')}</dt><dd>{t(
          `已完成K线${s.side==='long'?'低点触及或跌破':'高点触及或突破'}止损 ${priceText(s.stopLoss)} 时失效；生成后 12 根已完成K线未触发则到期。`,
          `Invalidated when a closed candle's ${s.side==='long'?'low reaches or falls below':'high reaches or rises above'} the stop at ${priceText(s.stopLoss)}. Expires after 12 closed candles without an entry trigger.`)}</dd></div>
      </dl>
      <footer className="plan-timestamp">{t('方案生成K线','Creation bar')} {barTime(s.generatedAt)}{s.previousOutcome&&<span> · {t('上次方案：','Previous: ')}{s.previousOutcome.status==='target_reached'?t('目标到达','target reached'):t('已失效','invalidated')}</span>}</footer>
    </article>)}</div>:<p className="empty-setups">{loading?t('正在计算多空计划','Calculating trade plans'):t('已完成K线数据不足，暂无法计算有效入场、止损和目标价格。','Not enough closed candles to calculate a valid entry, stop and targets.')}</p>}
    </PlanRecords>
  </div>;
}

export default function TradeSetups({analysis,loading,forecast,dataFresh=true}:{analysis:Analysis|null;loading:boolean;forecast?:MarketForecast;dataFresh?:boolean}) {
  const {t}=useLanguage();
  if(!forecast&&!analysis)return <div className="trade-setups-panel"><p className="empty-setups">{loading?t('正在计算本周期预判','Calculating the current timeframe outlook'):t('加载行情后显示后续参考价位','Load market data to see forward reference levels')}</p></div>;
  if(!forecast)return <LegacyTradeSetups analysis={analysis} loading={loading}/>;
  return <div className="trade-setups-panel forward-outlook-panel">
    <ForecastPanel forecast={forecast} dataFresh={dataFresh}/>
    {!!analysis?.tradePlans.length&&<details className="forecast-history-records" data-testid="historical-plan-records" key={`${forecast.context.market}:${forecast.context.symbol}:${forecast.context.interval}`}><summary>{t('历史计划记录','Historical plan records')}</summary><LegacyTradeSetups analysis={analysis} loading={false} historicalOnly/></details>}
  </div>;
}
