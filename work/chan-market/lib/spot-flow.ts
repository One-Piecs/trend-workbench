/** Side volumes in base currency for a single confirmed spot breakout.
 * Binance Spot GET /api/v3/klines: field 5 = traded volume, 9 = taker-buy
 * base volume. A kline's OHLC alone does not contain trade direction.
 * https://github.com/binance/binance-spot-api-docs/blob/master/rest-api.md#klinecandlestick-data
 */
export interface SpotFlowWindow {
  symbol: string;
  venue: string;
  start: number; // UTC epoch seconds, inclusive
  end: number; // UTC epoch seconds, exclusive
}

export type SpotFlowResult = SpotFlowWindow & (
  {status:'unavailable'; reason:'unsupported'|'incomplete'|'no-trades'|'upstream'|'budget'} |
  {status:'ready'; observedStart:number; observedEnd:number; minutes:number; baseAsset:'BTC'|'ETH';
    buyVolume:number; sellVolume:number; totalVolume:number; buyShare:number}
);
interface SpotBar { time:number; open:number; high:number; low:number; close:number; volume:number; takerBuy:number }
type Crossing = {direction:'up'|'down'; boundary:number; parentClose?:number};
type Query = SpotFlowWindow & {crossing?:Crossing};
type SpotData = SpotBar[] | 'incomplete' | 'upstream';

function parseWindow(params:URLSearchParams): Query {
  const symbol=params.get('symbol')??'',venue=params.get('venue')??'';
  const start=Number(params.get('start')),end=Number(params.get('end'));
  const direction=params.get('direction'),price=params.get('boundary'),parent=params.get('parentClose');
  const crossing=direction!==null||price!==null;
  if(!/^[A-Z0-9]{2,30}$/.test(symbol)||!venue||venue.length>40||
    !Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<=0||end<=start||end>8640000000000||
    start%60!==0||end%60!==0||end-start>(crossing?31*86400:3600)||
    end-start>4*3600&&(start%3600!==0||end%3600!==0)) {
    throw new RangeError('成交观察区间或标的无效。');
  }
  if(!crossing&&parent===null)return {symbol,venue,start,end};
  const boundary=Number(price);
  if((direction!=='up'&&direction!=='down')||!Number.isFinite(boundary)||boundary<=0||
    parent!==null&&(!Number.isFinite(Number(parent))||Number(parent)<=0)) {
    throw new RangeError('中枢边界或突破方向无效。');
  }
  return {symbol,venue,start,end,crossing:{direction,boundary,parentClose:parent===null?undefined:Number(parent)}};
}

// Blank/null sizes are missing fields, even when Number(null) would be zero.
function decimal(value:unknown) {
  return typeof value==='string'&&/^\d+(?:\.\d+)?$/.test(value)?Number(value):NaN;
}
function readBars(raw:unknown,start:number,end:number,span:number):SpotData {
  if(!Array.isArray(raw)||raw.length!==(end-start)/span)return 'incomplete';
  const bars:SpotBar[]=[];
  for(const row of raw){
    const time=start+bars.length*span;
    if(!Array.isArray(row)||row[0]!==time*1000||row[6]!==(time+span)*1000-1)return 'incomplete';
    const volume=decimal(row[5]),takerBuy=decimal(row[9]);
    const [open,high,low,close]=row.slice(1,5).map(decimal);
    if(!Number.isFinite(volume)||!Number.isFinite(takerBuy)||takerBuy>volume||
      ![open,high,low,close].every(n=>Number.isFinite(n)&&n>0)||
      high<Math.max(open,close)||low>Math.min(open,close))return 'incomplete';
    bars.push({time,open,high,low,close,volume,takerBuy});
  }
  return bars;
}

function beyond(price:number,crossing:Crossing):boolean {
  return crossing.direction==='up'?price>crossing.boundary:price<crossing.boundary;
}
function matchesClose(price:number,crossing:Crossing):boolean {
  return beyond(price,crossing)&&(crossing.parentClose===undefined||price===crossing.parentClose);
}
function observe(minutes:SpotBar[],window:SpotFlowWindow,crossing?:Crossing):SpotFlowResult {
  if(crossing){
    // The chart checks the preceding parent close against the same fixed boundary.
    // Walk back to the first close in the final uninterrupted run on the new side.
    if(!matchesClose(minutes[minutes.length-1].close,crossing))return {...window,status:'unavailable',reason:'incomplete'};
    let first=minutes.length-1;
    while(first>0&&beyond(minutes[first-1].close,crossing))first--;
    minutes=minutes.slice(first,first+5);
  }
  let buyVolume=0,sellVolume=0;
  for(const minute of minutes){
    buyVolume+=minute.takerBuy;
    sellVolume+=minute.volume-minute.takerBuy;
  }
  const totalVolume=buyVolume+sellVolume;
  if(!Number.isFinite(totalVolume))return {...window,status:'unavailable',reason:'incomplete'};
  if(totalVolume===0)return {...window,status:'unavailable',reason:'no-trades'};
  return {...window,status:'ready',observedStart:minutes[0].time,observedEnd:minutes[minutes.length-1].time+60,
    minutes:minutes.length,baseAsset:window.symbol==='BTCUSDT'?'BTC':'ETH',
    buyVolume,sellVolume,totalVolume,buyShare:buyVolume/totalVolume};
}

export function createSpotFlowReader(fetcher:typeof fetch=fetch,now:()=>number=Date.now){
  // Freeze completed minutes by window. Different center boundaries on the same
  // candle reuse one response. Transient gaps and connection errors expire quickly.
  const cache=new Map<string,{data:SpotData;expires:number}>();
  const pending=new Map<string,Promise<SpotData>>();
  let rateLimitedUntil=0;
  async function load(window:SpotFlowWindow,span:60|3600):Promise<SpotData>{
    const {start,end,symbol}=window;
    const params=new URLSearchParams({symbol,interval:span===60?'1m':'1h',startTime:String(start*1000),endTime:String(end*1000-1),limit:String((end-start)/span)});
    try{
      const response=await fetcher('https://data-api.binance.vision/api/v3/klines?'+params,{
        credentials:'omit',signal:AbortSignal.timeout(6500),redirect:'error',headers:{Accept:'application/json'}
      });
      if(response.status===429||response.status===418){
        const retry=response.headers.get('retry-after');
        const until=retry&&/^\d+$/.test(retry)?now()+Number(retry)*1000:Date.parse(retry??'');
        rateLimitedUntil=Math.max(rateLimitedUntil,Number.isFinite(until)&&until>now()?until:now()+60000);
      }
      if(!response.ok)return 'upstream';
      return readBars(await response.json(),start,end,span);
    }catch{return 'upstream';}
  }
  async function cached(window:SpotFlowWindow,span:60|3600):Promise<SpotData>{
    const key=[window.symbol,span,window.start,window.end].join(':');
    const saved=cache.get(key);
    if(saved&&saved.expires>now())return saved.data;
    let request=pending.get(key);
    if(!request){
      if(pending.size>=4||rateLimitedUntil>now())return 'upstream';
      request=load(window,span).then(value=>{
        cache.delete(key);
        if(cache.size>=96)cache.delete(cache.keys().next().value!);
        cache.set(key,{data:value,expires:now()+(Array.isArray(value)?3600000:5000)});
        return value;
      }).finally(()=>pending.delete(key));
      pending.set(key,request);
    }
    return request;
  }

  async function observeLong(window:SpotFlowWindow,crossing:Crossing):Promise<SpotFlowResult>{
    const hours=await cached(window,3600);
    const unavailable=(reason:'incomplete'|'budget'|'upstream'):SpotFlowResult=>({...window,status:'unavailable',reason});
    if(typeof hours==='string')return unavailable(hours);
    if(!matchesClose(hours[hours.length-1].close,crossing))return unavailable('incomplete');
    const checked=new Map<number,SpotBar[]>();
    const started=now();
    async function minutesOf(hour:SpotBar):Promise<SpotData|'budget'> {
      const saved=checked.get(hour.time);
      if(saved)return saved;
      if(checked.size>=8||now()-started>=12000)return 'budget';
      const bars=await cached({...window,start:hour.time,end:hour.time+3600},60);
      if(typeof bars==='string')return bars;
      if(bars[0].open!==hour.open||bars[59].close!==hour.close||
        Math.max(...bars.map(b=>b.high))!==hour.high||Math.min(...bars.map(b=>b.low))!==hour.low)return 'incomplete';
      checked.set(hour.time,bars);
      return bars;
    }
    // A whole hour whose lowest trade stayed above an upper boundary (or
    // highest stayed below a lower one) cannot contain a minute close back inside.
    let first=window.start;
    for(let i=hours.length-1;i>=0;i--){
      const hour=hours[i];
      if(!beyond(hour.close,crossing)){first=hour.time+3600;break;}
      if(beyond(crossing.direction==='up'?hour.low:hour.high,crossing))continue;
      const bars=await minutesOf(hour);
      if(typeof bars==='string')return unavailable(bars);
      const lastInside=bars.findLast(b=>!beyond(b.close,crossing));
      if(lastInside){first=lastInside.time+60;break;}
    }
    const stop=Math.min(first+300,window.end),observed:SpotBar[]=[];
    for(let time=first;time<stop;time+=60){
      const hour=hours[Math.floor((time-window.start)/3600)];
      const bars=await minutesOf(hour);
      if(typeof bars==='string')return unavailable(bars);
      const b=bars[(time-hour.time)/60];
      if(!beyond(b.close,crossing))return unavailable('incomplete');
      observed.push(b);
    }
    return observe(observed,window);
  }
  return async function getSpotFlow(params:URLSearchParams):Promise<SpotFlowResult>{
    const {crossing,...window}=parseWindow(params);
    if(!['BTCUSDT','ETHUSDT'].includes(window.symbol)||window.venue!=='Binance')
      return {...window,status:'unavailable',reason:'unsupported'};
    if(window.end*1000>now())return {...window,status:'unavailable',reason:'incomplete'};
    if(crossing&&window.end-window.start>4*3600)return observeLong(window,crossing);
    const data=await cached(window,60);
    if(typeof data==='string')return {...window,status:'unavailable',reason:data};
    return observe(data,window,crossing);
  };
}
export const getSpotFlow=createSpotFlowReader();
