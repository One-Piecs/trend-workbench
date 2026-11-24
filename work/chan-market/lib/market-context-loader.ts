import type {Interval,Market,MarketData} from './market-types';
import {readMarketResponse} from './market-response.ts';
import {higherInterval} from './timeframe-context.ts';
import {compatibleMarketFeeds,deriveHigherFromPrimary} from './higher-from-primary.ts';

export type HigherFeed = {interval:Interval|null;status:'ready'|'loading'|'error'|'none'|'imported';data?:MarketData};
export interface ChartSnapshot {data:MarketData; higher:HigherFeed; receivedAt:number;cached?:true}
type Fetcher=(input:string,init:{signal:AbortSignal})=>Promise<Response>;
export type MarketContextRequest = {
  market:Market;symbol:string;interval:Interval;signal:AbortSignal;
  onPrimary:(data:MarketData)=>void;onPrimaryError:(message:string)=>void;
  onHigher:(feed:HigherFeed)=>void;fetcher?:Fetcher;
};

/** Each feed settles independently: a slow or missing parent must not blank the main chart.
 * An abort suppresses ALL callbacks, even with a transport that ignores AbortSignal.
 */
export async function loadMarketContext(request:MarketContextRequest):Promise<void> {
  const {market,symbol,interval,signal,onPrimary,onPrimaryError,onHigher}=request;
  if(signal.aborted)return;
  const fetcher=request.fetcher??((url,init)=>fetch(url,{signal:AbortSignal.any([init.signal,AbortSignal.timeout(90000)])}));
  const higher=higherInterval(market,interval);
  const load=async(period:Interval):Promise<MarketData>=>{
    const response=await fetcher(`/api/candles?market=${market}&symbol=${encodeURIComponent(symbol)}&interval=${period}`,{signal});
    return readMarketResponse(response,{market,symbol,interval:period});
  };
  onHigher({interval:higher,status:higher?'loading':'none'});
  let primary:MarketData|undefined,parent:MarketData|undefined;
  await Promise.allSettled([
    load(interval).then(data=>{primary=data;if(!signal.aborted)onPrimary(data);},error=>{if(!signal.aborted)onPrimaryError(error instanceof Error?error.message:'加载失败，请重试');}),
    higher?load(higher).then(data=>{parent=data;}):Promise.resolve(),
  ]);
  if(signal.aborted||!higher)return;
  if(primary&&parent&&compatibleMarketFeeds(primary,parent)) {
    onHigher({interval:higher,status:'ready',data:parent});return;
  }
  const derived=primary?deriveHigherFromPrimary(primary):null;
  if(signal.aborted)return;
  onHigher(derived?{interval:higher,status:'ready',data:derived}:{interval:higher,status:'error'});
}

/** A background refresh replaces the displayed pair together. On initial load
 * the candles can render while their own parent is still pending. */
export function createChartFeedController(fetcher?:Fetcher) {
  let active:AbortController|null=null;
  let generation=0;
  function cancel() { generation++;active?.abort();active=null; }
  async function load(request:Pick<MarketContextRequest,'market'|'symbol'|'interval'|'onPrimaryError'> & {
    background:boolean; onSnapshot:(snapshot:ChartSnapshot)=>void;onCache?:(snapshot:ChartSnapshot)=>void;
  }) {
    if(request.background&&active)return;
    cancel();
    const version=generation;
    const controller=new AbortController();active=controller;
    const parentInterval=higherInterval(request.market,request.interval);
    let primary:MarketData|undefined;
    let receivedAt=0;
    if(!request.background&&request.onCache){
      const {market,symbol,interval}=request;
      const uri='/api/cached-candles?'+new URLSearchParams({market,symbol,interval});
      const read=fetcher??fetch;
      void read(uri,{signal:AbortSignal.any([controller.signal,AbortSignal.timeout(4000)])})
        .then(response=>readMarketResponse(response,{market,symbol,interval}))
        .then(data=>{
          if(!primary&&!controller.signal.aborted&&version===generation)
            request.onCache?.({data,higher:{interval:parentInterval,status:parentInterval?'loading':'none'},receivedAt:Date.parse(data.asOf),cached:true});
        }).catch(()=>{/* A new installation or a web host may have no desktop cache. */});
    }
    try {
      await loadMarketContext({...request,fetcher,signal:controller.signal,
        onPrimary(data) {
          primary=data;
          receivedAt=Date.now();
          if(!parentInterval||!request.background)request.onSnapshot({data,receivedAt,higher:{interval:parentInterval,status:parentInterval?'loading':'none'}});
        },
        onHigher(higher) {
          if(primary)request.onSnapshot({data:primary,higher,receivedAt});
        },
      });
    } finally {
      if(active===controller)active=null;
    }
  }
  return {load,cancel};
}
