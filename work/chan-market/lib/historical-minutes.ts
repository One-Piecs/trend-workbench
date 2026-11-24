import type {Candle, MarketData} from './market-types';

type Feed = Pick<MarketData, 'instrument' | 'source' | 'adjustment'>;
type Venue = 'Binance' | 'Bitget' | 'Bybit' | 'OKX';
const pageLimits: Record<Venue, number> = {Binance:1000, Bitget:200, Bybit:1000, OKX:100};

// Only accept identities emitted by the corresponding spot adapter. A display
// label, inferred USD pair or futures feed must never stand in for this history.
function identify(feed:Feed):{venue:Venue; pair:string} {
  const {instrument,source,adjustment}=feed;
  const venue=instrument.exchange;
  if(instrument.market!=='crypto'||instrument.id!==`crypto:${instrument.symbol}`||
     !Object.hasOwn(pageLimits,venue)||!/^[A-Z0-9]{2,40}$/.test(instrument.symbol)||
     !/^[A-Z0-9]{1,12}$/.test(instrument.currency)||!instrument.symbol.endsWith(instrument.currency)||
     instrument.symbol.length<=instrument.currency.length||adjustment!=='原始成交价格，不复权')
    throw new Error('Exact-source minute history is unavailable for this feed.');
  const pair=venue==='OKX'?instrument.symbol.slice(0,-instrument.currency.length)+'-'+instrument.currency:instrument.symbol;
  if(source!==`${venue} 公共现货行情 · ${pair}`&&!(venue==='Bitget'&&source===`Bitget saved spot monthly response · ${pair}`))
    throw new Error('Spot source and trading pair do not match.');
  return {venue:venue as Venue,pair};
}

function pageUrl(venue:Venue,pair:string,start:number,end:number,limit:number) {
  const first=start*1000,last=end*1000;
  switch(venue){
    case 'Binance': return `https://data-api.binance.vision/api/v3/klines?symbol=${pair}&interval=1m&startTime=${first}&endTime=${last-1}&limit=${limit}`;
    case 'Bybit': return `https://api.bybit.com/v5/market/kline?category=spot&symbol=${pair}&interval=1&start=${first}&end=${last-1}&limit=${limit}`;
    case 'Bitget': return `https://api.bitget.com/api/v2/spot/market/history-candles?symbol=${pair}&granularity=1min&endTime=${last}&limit=${limit}`;
    case 'OKX': return `https://www.okx.com/api/v5/market/history-candles?instId=${pair}&bar=1m&after=${last}&limit=${limit}`;
  }
}

function pageRows(payload:unknown,venue:Venue,pair:string):unknown[] {
  if(venue==='Binance'&&Array.isArray(payload))return payload;
  if(payload&&typeof payload==='object'){
    if(venue==='Bybit'&&'retCode' in payload&&payload.retCode===0&&'result' in payload){
      const r=payload.result;
      if(r&&typeof r==='object'&&'category' in r&&r.category==='spot'&&'symbol' in r&&r.symbol===pair&&'list' in r&&Array.isArray(r.list))return r.list;
    }
    if((venue==='OKX'||venue==='Bitget')&&'code' in payload&&payload.code===(venue==='OKX'?'0':'00000')&&'data' in payload&&Array.isArray(payload.data))return payload.data;
  }
  throw new Error('Minute feed returned an unrecognized response.');
}

/** Request only a fully elapsed, aligned interval [start,end). The entire range
 * must be present; padding, alternate venues and out-of-range rows are rejected. */
export async function fetchHistoricalMinutes(feed:Feed,start:number,end:number,options:{fetcher?:typeof fetch;signal?:AbortSignal}={}):Promise<MarketData> {
  const {venue,pair}=identify(feed);
  if(![start,end].every(t=>Number.isSafeInteger(t)&&t>0&&t%60===0)||end<=start||end-start>31*86400||end*1000>Date.now())
    throw new Error('Expected one closed interval of at most 31 days.');
  const deadline=AbortSignal.timeout(45000),signal=options.signal?AbortSignal.any([options.signal,deadline]):deadline;
  const candles:Candle[]=[];
  for(let cursor=start;cursor<end;){
    const count=Math.min((end-cursor)/60,pageLimits[venue]),next=cursor+count*60;
    const response=await (options.fetcher??fetch)(pageUrl(venue,pair,cursor,next,count),{signal,credentials:'omit',redirect:'error',headers:{Accept:'application/json'}});
    if(!response.ok)throw new Error(`Historical minute request returned HTTP ${response.status}.`);
    const rows=pageRows(await response.json(),venue,pair);
    const bars:Candle[]=rows.map(row=>{
      if(!Array.isArray(row)||row.length<6||row.slice(0,6).some(v=>!(typeof v==='number'||(typeof v==='string'&&v.trim().length))))
        throw new Error('Malformed minute candle.');
      const [ms,open,high,low,close,volume]=row.slice(0,6).map(Number);
      if(![ms,open,high,low,close,volume].every(Number.isFinite)||!Number.isSafeInteger(ms)||ms%60000||
         low<=0||low>Math.min(open,close)||high<Math.max(open,close)||volume<0||
         (venue==='OKX'&&row[8]!=='1')||(venue==='Binance'&&Number(row[6])!==ms+59999))
        throw new Error('Unconfirmed or invalid minute candle.');
      return {time:ms/1000,open,high,low,close,volume,closed:true};
    }).sort((a,b)=>a.time-b.time);
    if(bars.length!==count||bars.some((bar,i)=>bar.time!==cursor+i*60))throw new Error('Historical minute coverage is incomplete.');
    candles.push(...bars);
    cursor=next;
  }
  return {...feed,interval:'1m',candles,asOf:new Date().toISOString(),availableIntervals:['1m'],warnings:[],delayNotice:'Historical one-minute spot candles.'};
}
