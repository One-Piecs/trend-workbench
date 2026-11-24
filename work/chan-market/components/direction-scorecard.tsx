"use client";
import {useState} from 'react';
import {useLanguage} from '@/lib/language';
import {marketDisplayText} from '@/lib/market-i18n';
import {directionVersion,pairedDirectionInterval,type DirectionBook} from '@/lib/direction-scorecard';
import type {MarketData} from '@/lib/market-types';
import type {MarketForecast} from '@/lib/forecast-types';

interface Props {records:DirectionBook[];saved:boolean;data:MarketData|null;forecast?:MarketForecast|null}
const markets={crypto:['加密货币','Crypto'],cn:['A股','A-shares'],us:['美股','US equities'],commodity:['大宗商品','Commodities']} as const;
const pct=(x:number,n:number)=>n?(100*x/n).toFixed(1)+'%':'—';
const points=(value:number)=>(value>0?'+':'')+value.toFixed(1);

export default function DirectionScorecard({records,saved,data,forecast}:Props) {
  const {t,language}=useLanguage();
  const [all,setAll]=useState(false);
  const version=forecast?directionVersion(forecast):null;
  const visible=records.filter(b=>all||(b.market===data?.instrument.market&&b.interval===data.interval&&b.version===version))
    .sort((a,b)=>Number(b.symbol===data?.instrument.symbol)-Number(a.symbol===data?.instrument.symbol)||b.lastAnchor-a.lastAnchor);
  return <details className="forecast-validation panel">
    <summary><span>{t('方向成绩单','Direction scorecard')}</span><small>{t('记录后第12根K线核对','Checked after 12 full candles')}</small></summary>
    <label><input type="checkbox" checked={all} onChange={e=>setAll(e.target.checked)}/> {t('查看所有市场、周期和版本','Show all markets, timeframes and versions')}</label>
    {!saved&&<p role="status">{t('本机记录暂时无法读写。','Local records are currently unavailable.')}</p>}
    {!visible.length&&<p className="validation-context">{t('此范围还没有观测。工作台会保存看盘和自选监测时实际出现的方向判断。','No observations here yet. The workbench saves calls seen on the live chart or watchlist monitor.')}</p>}
    {visible.length>0&&<div className="validation-table-scroll" tabIndex={0} role="region" aria-label={t('方向成绩明细','Direction results')}>
      <table className="validation-table"><thead><tr>
        {[['标的与周期','Series'],['已核对 / 待核对','Matured / pending'],['方向命中','Correct calls'],['方向待明','Abstention'],['动量基准','Momentum baseline'],['领先基准','Lead, pp']].map(([zh,en])=><th key={en} scope="col">{t(zh,en)}</th>)}
      </tr></thead><tbody>{visible.map(b=>{
        const bounds=pairedDirectionInterval(b);
        return <tr key={b.series}>
          <th scope="row"><strong>{b.symbol} · {b.interval}</strong><small>{markets[b.market][language==='zh'?0:1]} {b.contract}</small>
            <details><summary>{t('来源与版本','Source and version')}</summary><small>{marketDisplayText(b.source,language)} · {marketDisplayText(b.adjustment,language)}<br/>{b.version}</small></details>
          </th>
          <td>{b.matured} / {b.pending.length}<small>{b.gap>0&&t(`缺口或修订 ${b.gap}`,`Gaps or revisions: ${b.gap}`)}</small></td>
          <td>{pct(b.hits,b.calls)}<small>{b.hits} / {b.calls}{b.calls<30&&t(' · 小样本',' · small sample')}</small></td>
          <td>{pct(b.abstained,b.matured)}<small>{b.abstained} / {b.matured}</small></td>
          <td>{pct(b.baselineHits,b.pairs)}<small>{b.baselineHits} / {b.pairs}</small></td>
          <td>{b.pairs?points(100*(b.pairedHits-b.baselineHits)/b.pairs)+' pp':'—'}
            <small>{bounds?t(`非重叠 ${b.separatePairs} 组，95%参考区间 ${points(bounds[0])} 至 ${points(bounds[1])} pp`,`Disjoint n=${b.separatePairs}, approximate 95% interval ${points(bounds[0])} to ${points(bounds[1])} pp`):
              t(`非重叠 ${b.separatePairs}/30 组，暂缺区间`,`Disjoint n=${b.separatePairs}/30, interval pending`)}</small></td>
        </tr>;
      })}</tbody></table></div>}
    <details className="cost-study"><summary>{t('成绩怎么算','How scoring works')}</summary>
      <p>{t('每根已完成K线只记首次看到的判断。从记录后第一根完整K线的开盘价，算到第12根的收盘价。偏多遇涨、偏空遇跌记命中，平价算未命中。“方向待明”计入弃权比例。','The first observed call per closed candle is frozen. We compare the open of the first full candle after publication with the close of the 12th. Long/up and short/down score a hit. A flat outcome misses a directional call. Neutral calls count as abstentions.')}</p>
      <p>{t('基准沿用记录时前12根K线的涨跌方向。领先值只比较双方都有判断的同一批样本，以百分点（pp）表示。参考区间使用时间互不重叠的同标的样本，市场走势之间的相关性仍会影响估计。','The baseline repeats the prior 12-candle direction. Lead uses matched calls and is expressed in percentage points (pp). The interval uses non-overlapping windows for each instrument. Market dependence can still affect its coverage.')}</p>
    </details>
  </details>;
}
