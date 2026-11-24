"use client";
import {useLanguage} from '@/lib/language';
import type {ForecastDirection,MarketForecast} from '@/lib/forecast-types';
import type {Interval,Market} from '@/lib/market-types';
import {forecastCondition,forecastKind,forecastPeriod} from './forecast-copy';
import {priceText} from './terminal-chart';

export type BattleMode='live'|'replay'|'cached'|'imported'|'unavailable'|'closed';

interface Props {
  market:Market;
  interval:Interval;
  forecast:MarketForecast|null;
  mode:BattleMode;
  flowSide:ForecastDirection|null;
}

export default function BattleScenarios({market,interval,forecast,mode,flowSide}:Props) {
  const {language,t}=useLanguage();
  const period=forecastPeriod(interval,language);
  const ready=forecast?.status==='ready'&&forecast.context.interval===interval&&forecast.context.market===market&&mode!=='unavailable'&&mode!=='cached';
  const direction=ready?forecast.direction:null;
  const tape=mode==='live'&&market==='crypto'?flowSide:null;
  const bias=direction==='long'?t('偏多','bullish'):direction==='short'?t('偏空','bearish'):t('方向待明','undecided');
  const active=tape==='long'?t('主动买入占优','Buyers lead the tape'):t('主动卖出占优','Sellers lead the tape');
  const comparison=ready&&tape&&tape!=='neutral'
    ?t(`${active}，${period}结构${bias}。`,`${active}. The ${period} structure is ${bias}.`)
    :null;
  return <section className="battle-scenarios" aria-label={t('多空条件对照','Bull and bear scenarios')}>
    <h3>{t('多空条件对照','Bull and bear scenarios')} <small>{period}</small></h3>
    {comparison&&<p className="battle-comparison">{comparison}</p>}
    {!ready?<p>{mode==='cached'||mode==='unavailable'?t('等待行情更新后核对条件。','Waiting for fresh data to check the scenarios.'):t('本周期的已完成K线还不足以计算条件。','More completed candles are needed for this timeframe.')}</p>:
      <div className="battle-scenario-grid">{(['long','short'] as const).map(key=>{
        const side=forecast[key],level=key==='long'?forecast.support:forecast.resistance;
        return <article key={key} data-side={key}>
          <h4>{key==='long'?t('多方观察','Bull case'):t('空方观察','Bear case')}</h4>
          {side.status==='ready'&&direction!=='neutral'?<>
            <b>{market==='cn'&&key==='short'?t('下行观察位','Downside level'):forecastKind(side,language)} · {priceText(side.triggerPrice)}</b>
            <p>{forecastCondition(side,language,priceText)}</p>
            <dl><div><dt>{t('入场区间','Entry zone')}</dt><dd>{priceText(side.zoneLow)} – {priceText(side.zoneHigh)}</dd></div>
              <div><dt>{t('失效位','Invalidation')}</dt><dd>{priceText(side.invalidationPrice)}</dd></div></dl>
          </>:level?<>
            <b>{key==='long'?t('观察支撑','Watch support'):t('观察阻力','Watch resistance')} · {priceText(level.price)}{level.estimated&&t('（估算）',' (est.)')}</b>
            <p>{t('等待本周期形成确认条件。','Waiting for a confirmed setup on this timeframe.')}</p>
          </>:<p>{t('尚无确认条件。','No confirmed setup yet.')}</p>}
        </article>;
      })}</div>}
  </section>;
}
