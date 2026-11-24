import test from 'node:test';
import assert from 'node:assert/strict';
import {auditFourHourCoverage} from '../lib/four-hour-coverage.ts';
const epoch=(s:string)=>Date.parse(s)/1000;
const bar=(s:string,closed=true)=>({time:epoch(s),open:10,high:12,low:9,close:11,volume:50,closed});

test('a truncated first session, Thanksgiving and early-close afternoon create no phantom gaps',()=>{
  const bars=[bar('2026-11-25T13:30-05:00'),bar('2026-11-27T09:30-05:00')];
  const audit=auditFourHourCoverage('us',bars,epoch('2026-11-27T16:15-05:00'))!;
  assert.equal(audit.expected,2);assert.deepEqual(audit.gaps,[]);
});
test('missing completed slots include a whole absent session and distinguish an unconfirmed bar',()=>{
  const bars=[bar('2026-11-24T13:30-05:00'),bar('2026-11-27T09:30-05:00',false)];
  const audit=auditFourHourCoverage('us',bars,epoch('2026-11-27T13:15-05:00'))!;
  assert.deepEqual(audit.gaps.map(g=>[g.date,g.start,g.end,g.present]),[
    ['2026-11-25',570,810,false],['2026-11-25',810,960,false],['2026-11-27',570,780,true]]);
  const earlier=auditFourHourCoverage('us',bars,epoch('2026-11-27T13:14-05:00'))!;
  assert.equal(earlier.expected,3);
});
test('A-share lunch and the National Day closure do not create artificial 4-hour gaps',()=>{
  const bars=[bar('2026-09-30T09:30+08:00')];
  assert.equal(auditFourHourCoverage('cn',bars,epoch('2026-10-08T10:00+08:00'))!.expected,1);
  assert.equal(auditFourHourCoverage('cn',bars,epoch('2026-10-08T13:23+08:00'))!.gaps.length,0);
  assert.deepEqual(auditFourHourCoverage('cn',bars,epoch('2026-10-09T13:23+08:00'))!.gaps.map(g=>g.date),['2026-10-08']);
  assert.equal(auditFourHourCoverage('us',[bar('2040-01-02T09:30-05:00')],epoch('2040-01-02T16:20-05:00')),null);
});
