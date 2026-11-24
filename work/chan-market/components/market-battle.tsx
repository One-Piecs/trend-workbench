"use client";

import {useEffect,useId,useRef,useState} from 'react';
import {Activity,ArrowDownRight,ArrowUpRight,Layers3,Music2,RefreshCw,Swords,Volume2,VolumeX,X} from 'lucide-react';
import {useLanguage} from '@/lib/language';
import {BattleAudio,DEFAULT_BATTLE_VOLUME} from '@/lib/battle-audio';
import {battleTier} from '@/lib/battle-deployment';
import BattleArena from './battle-arena';
import {useBattleFeed} from './use-battle-feed';
import type {Analysis,Interval,Market} from '@/lib/market-types';
import type {MarketForecast} from '@/lib/forecast-types';
import BattleScenarios,{type BattleMode} from './battle-scenarios';
import {priceText} from './terminal-chart';

interface Props {
  market:Market; symbol:string; interval:Interval; mode:BattleMode;
  currency:string;
  chartPrice:{price:number;kind:'realtime'|'public'|'candle'}|null;
  analysis:Analysis|null; forecast:MarketForecast|null;
}
function share(buy:number,sell:number) {
  return buy+sell>0?Math.round(1000*buy/(buy+sell))/10:null;
}

export default function MarketBattle(props:Props) {
  const {t}=useLanguage();
  const [open,setOpen]=useState(false);
  const [audio]=useState(()=>new BattleAudio());
  const [sound,setSound]=useState(false);
  const [volume,setVolume]=useState(DEFAULT_BATTLE_VOLUME);
  const [music,setMusic]=useState(true);
  function changeVolume(level:number){
    setVolume(level);audio.setVolume(level);
    try{localStorage.setItem('trend-battle-volume',String(level));}catch{}
  }
  function toggleMusic(){
    const value=!music;
    setMusic(value);audio.setMusic(value);
    try{localStorage.setItem('trend-battle-music',value?'on':'off');}catch{}
  }
  const audioIntent=useRef(false),audioAttempt=useRef(0);
  function silence(){
    audioAttempt.current++;audioIntent.current=false;audio.close();setSound(false);
  }
  function arm(preview=false){
    audioIntent.current=true;
    const attempt=++audioAttempt.current;
    void audio.enable().then(ready=>{
      if(attempt!==audioAttempt.current||!audioIntent.current)return;
      if(!ready){silence();return;}
      setSound(true);if(preview)audio.preview();
    });
  }
  function toggle(){
    const active=!audioIntent.current;
    try{localStorage.setItem('trend-battle-sound',active?'on':'off');}catch{}
    if(active){if(volume===0)changeVolume(DEFAULT_BATTLE_VOLUME);arm(true);}else silence();
  }
  useEffect(()=>{
    function visibility(){
      if(document.hidden||!navigator.onLine){audio.suspend();return;}
      if(audioIntent.current)void audio.enable();
    }
    document.addEventListener('visibilitychange',visibility);
    window.addEventListener('offline',visibility);window.addEventListener('online',visibility);
    return ()=>{audioIntent.current=false;audio.close();document.removeEventListener('visibilitychange',visibility);window.removeEventListener('offline',visibility);window.removeEventListener('online',visibility);};
  },[audio]);
  const trigger=useRef<HTMLButtonElement>(null),dialog=useRef<HTMLDialogElement>(null);
  const titleId=useId(),id=useId();
  return <>
    <button type="button" ref={trigger} className="battle-open" aria-haspopup="dialog" aria-expanded={open} aria-controls={id}
      onClick={()=>{
        if(!dialog.current||dialog.current.open)return;
        dialog.current.showModal();setOpen(true);
        let muted=false,level=DEFAULT_BATTLE_VOLUME,score=true;
        try{
          muted=localStorage.getItem('trend-battle-sound')==='off';
          score=localStorage.getItem('trend-battle-music')!=='off';
          const saved=localStorage.getItem('trend-battle-volume');
          if(saved&&/^\d{1,3}$/.test(saved)&&Number(saved)<=100)level=Number(saved);
        }catch{}
        setVolume(level);audio.setVolume(level);setMusic(score);audio.setMusic(score);
        // Opening during cold start is also the gesture that unlocks sound when the first trades arrive.
        if(!muted&&props.market==='crypto'&&['live','unavailable','cached'].includes(props.mode)&&props.symbol.endsWith('USDT'))arm();
      }}>
      <Swords size={17} aria-hidden="true"/><span>{t('多空之战','Bull vs bear')}</span>
    </button>
    <dialog ref={dialog} id={id} className="market-battle" aria-labelledby={titleId}
      onClose={()=>{silence();setOpen(false);trigger.current?.focus({preventScroll:true});}}
      onKeyDown={e=>e.stopPropagation()}
      onClick={e=>{if(e.target===e.currentTarget){const box=e.currentTarget.getBoundingClientRect();if(e.clientX<box.left||e.clientX>box.right||e.clientY<box.top||e.clientY>box.bottom)dialog.current?.close();}}}>
      {open&&<BattleContent key={[props.market,props.symbol,props.interval,props.mode==='unavailable'?'live':props.mode].join('|')} {...props} titleId={titleId}
        sound={sound} toggle={toggle} audio={audio} volume={volume} changeVolume={changeVolume}
        music={music} toggleMusic={toggleMusic} close={()=>dialog.current?.close()}/>}
    </dialog>
  </>;
}

interface SoundControls {
  sound:boolean;toggle:()=>void;audio:BattleAudio;volume:number;changeVolume:(value:number)=>void;
  music:boolean;toggleMusic:()=>void;
}
function BattleContent({market,symbol,interval,mode,currency,chartPrice,analysis,forecast,titleId,close,sound,toggle,audio,volume,changeVolume,music,toggleMusic}:Props&SoundControls&{titleId:string;close:()=>void}) {
  const {t,locale}=useLanguage();
  const amount=(n:number)=>n.toLocaleString(locale,{maximumFractionDigits:2});
  const when=(n:number)=>new Date(n*1000).toLocaleTimeString(locale,{hour12:false});
  const display=symbol.endsWith('USDT')?symbol.slice(0,-4)+'/USDT':symbol;
  const supported=market==='crypto'&&/^[A-Z0-9]+USDT$/.test(symbol);
  const enabled=supported&&(mode==='live'||mode==='unavailable');
  const [attempt,retry]=useState(0);
  const state=useBattleFeed(symbol,enabled,attempt);
  const trade=enabled&&state.quote?.symbol===symbol?state.quote:null;
  const price=trade?.price??chartPrice?.price;
  function priceLabel(){
    if(trade)return trade.mode==='live'?t('实时成交价','Live trade price'):t('成交快照','Last trade snapshot');
    if(price===undefined)return t('等待报价','Awaiting price');
    if(mode==='replay')return t('回放价格','Replay price');
    if(mode==='cached')return t('缓存价格','Saved price');
    if(mode==='imported')return t('导入价格','Imported price');
    if(mode==='closed')return t('休市价格','Market closed');
    if(chartPrice?.kind==='realtime')return t('实时报价','Real-time quote');
    if(chartPrice?.kind==='public')return t('最新报价','Latest quote');
    return t('最近K线价格','Last candle price');
  }
  const snap=enabled&&state.status==='ok'?state.data:undefined;
  const flow=snap?.flow,book=snap?.book;
  const battleActive=!!flow;
  useEffect(()=>{
    audio.setBattleActive(battleActive&&sound);
    return ()=>audio.setBattleActive(false);
  },[audio,battleActive,sound]);
  const buy=flow?share(flow.buy,flow.sell):null;
  const side=buy===null?null:buy===50?'neutral':buy>50?'long':'short';
  const transportText=state.transport==='live'?t('逐笔实时','Live trades'):state.transport==='snapshot'?t('定时快照','Snapshots'):
    state.transport==='retrying'?t('推送重连中','Reconnecting'):t('连接逐笔推送','Connecting');
  const modeLabel=mode==='replay'?t('历史回放','Replay'):mode==='cached'?t('本机缓存','Saved candles'):mode==='imported'?t('导入数据','Imported data'):
    mode==='closed'?t('休市','Market closed'):mode==='unavailable'?t('K线待更新','Awaiting candles'):null;
  const missing=mode==='replay'?t('回放保留当时的K线判断，逐笔成交和盘口没有历史快照。','Replay shows candle evidence at the selected time. Historical trades and depth are unavailable.'):
    mode==='cached'||mode==='imported'?t('当前数据只包含K线，可查看下方的结构和观察点位。','This dataset contains candles only. See structure and price levels below.'):
    !supported?t('此标的可查看K线结构。逐笔成交与盘口目前覆盖 USDT 现货交易对。','Candle evidence is available for this market. Trade flow and depth cover USDT spot pairs.'):
    mode==='closed'?t('当前市场已休市。','This market is closed.'):t('等待当前标的行情更新。','Waiting for the selected market to update.');
  const statusText=state.status==='loading'?t('正在读取成交和盘口…','Loading trades and depth…'):
    state.status==='offline'?t('网络已断开，恢复连接后自动更新。','Offline. Updates resume on reconnection.'):
    state.status==='stale'?t('快照已过期，等待更新。','Snapshot expired. Waiting for an update.'):
    state.status==='paused'?t('窗口隐藏，已暂停更新。','Updates paused while the window is hidden.'):
    t('暂未取得成交和盘口，稍后自动重试。','Trades and depth are unavailable. Retrying shortly.');
  const trend=mode!=='unavailable'?analysis?.confluence:undefined;
  const labelFor=(dir:string|undefined)=>dir==='long'?t('偏多','Bullish'):dir==='short'?t('偏空','Bearish'):dir==='neutral'?t('方向待明','Mixed'):t('暂无数据','Unavailable');
  const stamp=mode!=='unavailable'?(forecast?.structureAsOf??trend?.asOf):null;
  const peak=flow?Math.max(...flow.buckets.flatMap(row=>[row.buy,row.sell]),Number.MIN_VALUE):1;
  return <>
    <header className="battle-head"><div><h2 id={titleId}><Swords aria-hidden="true" size={23}/>{t('多空之战','Bull vs bear')}</h2>
      <p>{display}<i/> {interval}{modeLabel&&<> <i/> {modeLabel}</>}</p></div>
      <div className="battle-price" data-battle-price="" title={trade?when(trade.time):undefined}>
        <span>{priceLabel()}</span>
        <strong>{price===undefined?'—':priceText(price)}{price!==undefined&&<small>{trade?'USDT':currency}</small>}</strong>
      </div>
      <button className="battle-close" type="button" onClick={close} aria-label={t('关闭多空之战','Close bull vs bear')} autoFocus><X size={19}/></button>
    </header>
    <div className="battle-body">
      <section className="battle-arena" aria-label={t('主动成交战况','Aggressive trade flow')}>
        <div className="battle-section-head"><h3><Activity size={17}/>{enabled?t('实时战场','Battlefield'):t('主动成交','Trade pressure')}</h3>
          {enabled&&<div className="battle-updates">
            {state.status!=='offline'&&state.status!=='paused'&&<span className="battle-transport" data-battle-transport={state.transport}>{transportText}</span>}
            <button className="battle-audio-control" data-battle-sound="" type="button" aria-pressed={sound}
              aria-label={t('对战音效','Battle sound')} onClick={toggle}>{sound?<Volume2 size={16}/>:<VolumeX size={16}/>}
              {sound?t('音效开','Sound on'):t('音效关','Sound off')}</button>
            <label className="battle-volume"><input type="range" min="0" max="100" step="1" value={volume} data-battle-volume=""
              aria-label={t('战场音量','Battle volume')} onChange={e=>changeVolume(e.currentTarget.valueAsNumber)}/>
              <span>{volume}%</span></label>
            <button className="battle-audio-control" type="button" data-battle-music="" aria-pressed={music}
              aria-label={t('战场配乐','Battle music')} onClick={toggleMusic}><Music2 size={15}/>{t('配乐','Music')}</button>
            {snap&&<time dateTime={new Date(snap.asOf*1000).toISOString()}>{when(snap.asOf)}</time>}
            <button type="button" disabled={state.status==='loading'||state.status==='paused'||state.status==='offline'} aria-label={t('更新战况','Refresh battle')} onClick={()=>retry(n=>n+1)}><RefreshCw size={15}/></button></div>}
        </div>
        {enabled&&<BattleArena key={[attempt,snap?.source,state.transport==='live'?'push':'snapshot'].join('/')} buyShare={buy}
          bidShare={book?share(book.bid,book.ask):null} events={state.events} fills={state.fills}
          active={battleActive} en={locale.startsWith('en')} charge={state.charge}
          onStrike={(event,shotTimes)=>{if(sound)audio.strike(event.side,event.tier??battleTier(event.notional),shotTimes);}}
          onImpact={event=>{if(sound)audio.impact(event.side,event.tier??battleTier(event.notional));}}
          onCharge={side=>{if(sound)audio.charge(side);}}/>}
        {flow&&buy!==null?<><div className="battle-duel">
          <div className="battle-buy"><span><ArrowUpRight size={15}/>{t('主动买入','Taker buys')}</span><b>{buy.toFixed(1)}<em>%</em></b><small>{amount(flow.buy)} USDT</small></div>
          <div className="battle-sell"><span>{t('主动卖出','Taker sells')}<ArrowDownRight size={15}/></span><b>{(100-buy).toFixed(1)}<em>%</em></b><small>{amount(flow.sell)} USDT</small></div>
        </div>
        <div className="battle-frontline" aria-hidden="true"><i style={{width:buy+'%'}}/><b style={{left:buy+'%'}}><Swords size={13}/></b></div>
        <p className="battle-caption">{flow.limited?t('近60秒 · 部分成交','Last 60s · partial sample'):t('近60秒 · 主动成交额占比','Last 60s · share of traded value')} · {t('单一现货市场','One spot venue')} · {t(flow.count+' 条成交记录',flow.count+' trade records')}
          {flow.limited&&<> · {when(flow.firstTime)}–{when(flow.lastTime)}</>}</p>
        <div className="battle-buckets" aria-label={t('每10秒主动买入和卖出金额','Taker buys and sells by 10s bucket')}>{flow.buckets.map(b=>{
          return <div key={b.start} title={when(b.start)+' · '+t('买入','Buy')+' '+amount(b.buy)+' / '+t('卖出','Sell')+' '+amount(b.sell)+' USDT'}>
            <div className="battle-bars"><i style={{height:(100*b.buy/peak)+'%'}}/><b style={{height:(100*b.sell/peak)+'%'}}/></div>
            <small>{when(b.start).slice(-5)}</small></div>;
        })}</div>
        {flow.largest&&<p className="battle-print"><b>{t('样本内最大成交','Largest sampled trade')}</b>
          <span className={flow.largest.side==='buy'?'battle-buy':'battle-sell'}>{flow.largest.side==='buy'?t('主动买入','Taker buy'):t('主动卖出','Taker sell')}</span>
          <strong>{amount(flow.largest.amount)} USDT</strong><time>{when(flow.largest.time)}</time></p>}</>:
          <p className="battle-empty" role="status">{!enabled?missing:snap?t('近60秒暂无可核对的成交金额。','No verified trade value in the last 60 seconds.'):statusText}</p>}
      </section>
      {enabled&&snap&&<section className="battle-book">
        <div className="battle-section-head"><h3><Layers3 size={17}/>{t('近价挂单','Near-price depth')}</h3>{book&&<small>
          {state.bookLive?t('盘口推送','Live depth'):t('盘口快照','Depth snapshot')} · ±0.25% · {when(book.observedAt)}</small>}</div>
        {book?<><div className="battle-book-sides">{(['bid','ask'] as const).map(key=><div key={key} className={key==='bid'?'battle-buy':'battle-sell'}>
          <span>{key==='bid'?t('买盘挂单','Bid depth'):t('卖盘挂单','Ask depth')}</span><b>{amount(book[key])} <small>USDT</small></b>
          <small>{key==='bid'?t('买一','Best bid'):t('卖一','Best ask')} {priceText(key==='bid'?book.bestBid:book.bestAsk)} · {key==='bid'?book.bids:book.asks} {t('档','levels')}</small>
        </div>)}</div><p className="battle-caption">{book.limited?t('接口返回档位有限，以上为区间内已取得的挂单。','Depth is truncated. Totals include returned levels within the band.'):t('买卖中间价上下 0.25% 内的可见委托，挂单可随时撤销。','Visible orders within 0.25% of the midpoint. Orders may be cancelled.')}</p></>:
        <p className="battle-empty">{t('暂未取得同一来源的盘口快照。','Depth from the same venue is currently unavailable.')}</p>}
      </section>}
      <section className="battle-structure">
        <div className="battle-section-head"><h3>{interval} · {t('K线依据','Candle evidence')}</h3>
          {!!stamp&&<small>{new Date(stamp*1000).toLocaleString(locale,{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false})}</small>}</div>
        <div className="battle-evidence">{[
          [t('本周期预判','Timeframe outlook'),mode!=='unavailable'&&forecast?.status==='ready'?forecast.direction:undefined],
          ['MACD',trend?.macd.status==='ready'?trend.macd.direction:undefined],
          [t('更大周期','Higher timeframe')+(trend?.higher.interval?' · '+trend.higher.interval:''),trend?.higher.status==='ready'?trend.higher.direction:undefined]
        ].map(([name,dir])=><div key={name}><span>{name}</span><b className={dir==='long'?'battle-buy':dir==='short'?'battle-sell':''}>{labelFor(dir)}</b></div>)}</div>
      </section>
      <BattleScenarios {...{market,interval,forecast,mode,flowSide:side}}/>
    </div>
  </>;
}
