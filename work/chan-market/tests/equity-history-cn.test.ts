import test from 'node:test';
import assert from 'node:assert/strict';
import {getCandles} from '../lib/market-data.ts';
import {equitySessionOn} from '../lib/equity-calendar.ts';

const dates:string[]=[];
for(let stamp=Date.parse('2026-11-13T00:00:00Z');dates.length<260;stamp-=86400000){
  const date=new Date(stamp).toISOString().slice(0,10);
  if(equitySessionOn('cn',date).status==='open')dates.unshift(date);
}
const stamps={30:['10:00','10:30','11:00','11:30','13:30','14:00','14:30','15:00'],60:['10:30','11:30','14:00','15:00']} as const;
function rows(scale:30|60,count:number){return dates.flatMap(date=>stamps[scale].map(clock=>({day:`${date} ${clock}:00`,open:'100',close:'101',high:'102',low:'99',volume:'100'}))).slice(-count);}

test('CN 4h requests the longer Sina hourly window and aggregates 1023 real children into 255 complete days',async()=>{
  const original=globalThis.fetch,urls:string[]=[];
  globalThis.fetch=async input=>{
    const url=String(input);urls.push(url);
    if(!url.includes('sina.cn'))return new Response('Unavailable',{status:503});
    const params=new URL(url).searchParams,scale=params.get('scale')==='60'?60:30;
    const count=Math.min(1023,Number(params.get('datalen'))||1023);
    return new Response(`var _data=(${JSON.stringify(rows(scale,count))});`);
  };
  try {
    const result=await getCandles('cn','600880.SH','4h',800);
    assert.ok(urls[0].includes('scale=60&'),'try the longer hourly window first');
    assert.ok(result.source.includes('1小时聚合4小时'));assert.equal(result.candles.length,255);
    assert.ok(result.candles.every(c=>c.closed));assert.equal(result.candles[0].volume,400);
    assert.ok(result.warnings.some(w=>w.includes('每个交易日一根')));
  }finally{globalThis.fetch=original;}
});

test('CN 4h compares independent successful backups instead of returning the shallow primary immediately',async()=>{
  const original=globalThis.fetch;
  globalThis.fetch=async input=>{
    const url=String(input),params=new URL(url).searchParams;
    if(url.includes('sina.cn'))return new Response('Unavailable',{status:503});
    if(url.includes('eastmoney.com')) {
      const scale=params.get('klt')==='60'?60:30,raw=rows(scale,scale===60?124:248);
      return new Response(JSON.stringify({data:{code:'600881',market:1,name:'Depth Test',klines:raw.map(r=>`${r.day.slice(0,16)},${r.open},${r.close},${r.high},${r.low},${r.volume}`)}}));
    }
    if(url.includes('gtimg.cn')) {
      const [ticker,period]=(params.get('param')||'').split(','),scale=period==='m60'?60:30;
      const raw=rows(scale,320).map(r=>[r.day.replace(/[- :]/g,'').slice(0,12),r.open,r.close,r.high,r.low,r.volume]);
      return new Response(JSON.stringify({code:0,data:{[ticker]:{[period]:raw,qt:{[ticker]:['','Depth Test']}}}}));
    }
    return new Response('Unexpected source',{status:503});
  };
  try {
    const result=await getCandles('cn','600881.SH','4h',800);
    assert.ok(result.source.includes('腾讯'),'the 80-day independent feed should beat the 31-day primary');
    assert.ok(result.source.includes('1小时聚合4小时'));assert.equal(result.candles.length,80);
    assert.equal(result.candles.at(-1)!.close,101);assert.equal(result.candles.at(-1)!.volume,40000);
    assert.ok(result.adjustment.includes('未独立核验'),'retain the selected source adjustment disclosure');
  }finally{globalThis.fetch=original;}
});

test('ordinary CN half-hour and hourly queries replace a short successful primary with a deeper same-date source',async()=>{
  const original=globalThis.fetch;
  globalThis.fetch=async input=>{
    const url=String(input),params=new URL(url).searchParams;
    if(url.includes('eastmoney.com')) {
      const scale=params.get('klt')==='60'?60:30,raw=rows(scale,scale===60?124:248),code=params.get('secid')!.split('.')[1];
      return new Response(JSON.stringify({data:{code,market:1,name:'Short Primary',klines:raw.map(r=>`${r.day.slice(0,16)},200,201,202,199,100`)}}));
    }
    if(url.includes('sina.cn')) {
      const scale=params.get('scale')==='60'?60:30,count=Math.min(1023,Number(params.get('datalen'))||1023);
      return new Response(`var _data=(${JSON.stringify(rows(scale,count))});`);
    }
    return new Response('Other backup unavailable',{status:503});
  };
  try {
    for(const [symbol,interval] of [['600882.SH','30m'],['600883.SH','1h']] as const) {
      const result=await getCandles('cn',symbol,interval,800);
      assert.equal(result.candles.length,800);assert.ok(result.source.includes('新浪'));
      assert.equal(result.interval,interval);assert.ok(result.candles.every(c=>c.close===101));
      assert.equal(result.candles.at(-1)!.time,Date.parse('2026-11-13T15:00:00+08:00')/1000);
    }
  }finally{globalThis.fetch=original;}
});

test('ordinary CN history keeps the latest short source when the deeper alternative ends a session earlier',async()=>{
  const original=globalThis.fetch;
  globalThis.fetch=async input=>{
    const url=String(input);
    if(url.includes('eastmoney.com'))return new Response(JSON.stringify({data:{code:'600884',market:1,name:'Current Primary',klines:rows(60,124).map(r=>`${r.day.slice(0,16)},200,201,202,199,100`)}}));
    if(url.includes('sina.cn'))return new Response(`var _data=(${JSON.stringify(rows(60,804).slice(0,-4))});`);
    return new Response('Other backup unavailable',{status:503});
  };
  try {
    const result=await getCandles('cn','600884.SH','1h',800);
    assert.ok(result.source.includes('东方财富'));assert.equal(result.candles.length,124);
    assert.ok(result.candles.every(c=>c.close===201));
  }finally{globalThis.fetch=original;}
});
