/** Clarify older saved descriptions without rewriting plan records or their state. */
export function candleCompletionCopy(text:string):string {
  return text
    .replace(/已收盘\s*K\s*线/g,'已完成K线')
    .replace(/未收盘\s*K\s*线/g,'尚未结束的K线')
    .replaceAll('此前收盘已触发','此前K线结束时已触发')
    .replaceAll('触发收盘形成前','触发K线结束前')
    .replaceAll('最近收盘','最近K线结束价')
    .replaceAll('当前收盘','当前K线结束价')
    .replaceAll('收盘','K线结束价');
}
