import type { Interval } from './market-types';

type YahooHost='query1.finance.yahoo.com'|'query2.finance.yahoo.com';
export type YahooHistoryWindow={host:YahooHost; start:number; end:number;atRetentionStart:boolean};
export class HistoryBoundary extends Error {
  status:'end'|'unsupported';
  constructor(status:'end'|'unsupported'){super('历史行情窗口已到边界。');this.status=status;}
}

/** Yahoo uses both a typed HTTP 400 and an empty 200 for an empty window.
 * A gap can also be a suspension, so verify the listing/retention boundary. */
interface YahooEnvelope {
  chart?: {error?:{code?:string;description?:string};result?:{meta?:{symbol?:string;firstTradeDate?:number};timestamp?:unknown[]}[]};
}
export async function loadYahooHistory<T>(url:URL,window:YahooHistoryWindow,symbol:string,fetcher:typeof fetch=fetch):Promise<T> {
  const options={headers:{'User-Agent':'Mozilla/5.0',Accept:'application/json'},signal:AbortSignal.timeout(10000)};
  const res=await fetcher(url.toString(),options);
  const payload=await res.json() as YahooEnvelope&T;
  const result=payload?.chart?.result?.[0], meta=result?.meta;
  if(!res.ok){
    const problem=payload?.chart?.error;
    if(res.status!==400||problem?.code!=='Bad Request'||!/^Data doesn't exist for startDate\s*=/.test(problem?.description??''))throw new Error('历史行情请求失败（HTTP '+res.status+'）。');
  }else{
    if(payload?.chart?.error||!meta||meta.symbol!==symbol)throw new Error('历史行情合约与当前图表不一致。');
    if(Array.isArray(result.timestamp)&&result.timestamp.length)return payload;
  }
  if(window.atRetentionStart)throw new HistoryBoundary('end');
  let listing=meta?.firstTradeDate;
  if(!Number.isFinite(listing)){
    const metadata=new URL(url);metadata.search=new URLSearchParams({range:'5d',interval:'1d'}).toString();
    const check=await fetcher(metadata.toString(),options);
    if(!check.ok)throw new Error('历史行情边界核验失败，请重试。');
    const info=(await check.json() as YahooEnvelope)?.chart?.result?.[0]?.meta;
    if(info?.symbol!==symbol)throw new Error('历史行情边界的标的不一致。');
    listing=info.firstTradeDate;
  }
  throw new HistoryBoundary(typeof listing==='number'&&Number.isFinite(listing)&&window.end<=listing?'end':'unsupported');
}

// Public intraday archives have a rolling retention window. Keep minute
// requests small and allow a trading week for holidays before the cursor.
export function yahooHistoryWindow(source:string,interval:Interval,before:number,count:number,now:number):YahooHistoryWindow|null {
  const host=source.endsWith(' · query1.finance.yahoo.com')?'query1.finance.yahoo.com':
    source.endsWith(' · query2.finance.yahoo.com')?'query2.finance.yahoo.com':null;
  if(!host)return null;
  const day=86400;
  const daysPerBar={ '1m':1/240,'5m':1/48,'15m':1/16,'30m':1/8,'1h':1/4,'4h':1,'1d':2,'1w':7,'1M':31 }[interval];
  const retention=interval==='1m'?30:['5m','15m','30m'].includes(interval)?60:['1h','4h'].includes(interval)?730:Infinity;
  const floor=Math.max(0,Math.ceil(now-retention*day));
  const span=Math.min(interval==='1m'?7:Infinity,Math.ceil(count*daysPerBar)+8+(interval==='1M'?31:0));
  const start=Math.max(floor,before-span*day);
  return {host,start,end:before,atRetentionStart:start===floor};
}
