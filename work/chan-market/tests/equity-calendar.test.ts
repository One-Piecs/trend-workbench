import test from 'node:test';
import assert from 'node:assert/strict';
import {equityCalendarCoverage,equityExchangeClock,equityFourHourWindows,equitySessionOn,equityWeekLastSession} from '../lib/equity-calendar.ts';
import {stockBarClosed} from '../lib/market-data.ts';

function verify2026(market:'cn'|'us',closures:Set<string>){
  for(let day=Date.UTC(2026,0,1);day<Date.UTC(2027,0,1);day+=86400000){
    const date=new Date(day),iso=date.toISOString().slice(0,10);
    const expected=date.getUTCDay()===0||date.getUTCDay()===6||closures.has(iso.slice(5))?'closed':'open';
    assert.equal(equitySessionOn(market,iso).status,expected,iso);
  }
}
test('SSE and SZSE 2026 holiday notices, Saturday makeup workdays and regular lunch',()=>{
  verify2026('cn',new Set(['01-01','01-02','02-16','02-17','02-18','02-19','02-20','02-23','04-06',
    '05-01','05-04','05-05','06-19','09-25','10-01','10-02','10-05','10-06','10-07']));
  assert.deepEqual(equitySessionOn('cn','2026-02-24').segments,[{start:570,end:690},{start:780,end:900}]);
  assert.deepEqual(equityFourHourWindows('cn','2026-02-24'),[{start:570,end:900}]);
});

test('NYSE 2026 schedule uses exactly two early closes, no pre-holiday short day on July 2',()=>{
  verify2026('us',new Set(['01-01','01-19','02-16','04-03','05-25','06-19','07-03','09-07','11-26','12-25']));
  const short:string[]=[];
  for(let day=Date.UTC(2026,0,1);day<Date.UTC(2027,0,1);day+=86400000){
    const date=new Date(day).toISOString().slice(0,10),session=equitySessionOn('us',date);
    if(session.status!=='open')continue;
    if(session.segments[0].end===780)short.push(date);
    else assert.deepEqual(equityFourHourWindows('us',date),[{start:570,end:810},{start:810,end:960}]);
  }
  assert.deepEqual(short,['2026-11-27','2026-12-24']);
  assert.deepEqual(equityFourHourWindows('us',short[0]),[{start:570,end:780}]);
  assert.deepEqual(equityWeekLastSession('us','2026-12-21'),{date:'2026-12-24',end:780});
});

test('coverage is explicit; malformed, unannounced and uncovered dates stay unknown',()=>{
  assert.deepEqual(equityCalendarCoverage('cn'),{start:'2000-01-01',end:'2026-12-31'});
  assert.deepEqual(equityCalendarCoverage('us'),{start:'2000-01-01',end:'2028-12-31'});
  for(const date of ['1999-12-31','2027-01-04','2026-02-30','not a date']){
    assert.equal(equitySessionOn('cn',date).status,'unknown');
    assert.deepEqual(equityFourHourWindows('cn',date),[]);
  }
  assert.equal(equitySessionOn('us','2029-01-01').status,'unknown');
});

test('New York opens one UTC hour earlier in DST and late November confirms at the 13:00 close',()=>{
  const t=(s:string)=>Date.parse(s)/1000;
  for(const ts of ['2026-03-06T14:30Z','2026-03-09T13:30Z','2026-10-30T13:30Z','2026-11-02T14:30Z']){
    assert.equal(equityExchangeClock('us',t(ts)).minute,570);
  }
  for(const [interval,label] of [['1h','2026-11-27T12:30:00-05:00'],['1d','2026-11-27T09:30:00-05:00'],['1w','2026-11-23T09:30:00-05:00']] as const){
    assert.equal(stockBarClosed(t(label),interval,'us',t('2026-11-27T13:14:59-05:00')),false);
    assert.equal(stockBarClosed(t(label),interval,'us',t('2026-11-27T13:15:00-05:00')),true);
  }
});
