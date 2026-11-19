import type { Candle } from './market-types';

const MAX_CANDLES = 2000;
function cells(line: string): string[] {
  return line.split(/,(?=(?:(?:[^"]*"){2})*[^"]*$)/).map(cell => cell.trim().replace(/^"|"$/g, ''));
}

/** Imported files stay in the browser. Missing closed column means user-supplied completed history. */
export function parseCSV(text: string): Candle[] {
  const lines = text.replace(/^\uFEFF/, '').trim().split(/\r?\n/).filter(line => line.trim());
  if (lines.length < 36) throw new Error('至少需要35根K线，首行为 time/date,open,high,low,close,volume,closed。');
  if (lines.length > MAX_CANDLES + 1) throw new Error(`单次最多导入${MAX_CANDLES.toLocaleString()}根K线，请缩小文件。`);
  const headers = cells(lines[0]).map(h => h.toLowerCase());
  if (new Set(headers).size !== headers.length) throw new Error('表头有重复列，请检查CSV。');
  const ti = headers.findIndex(h => ['time', 'date', 'datetime', 'timestamp'].includes(h));
  const columns = ['open', 'high', 'low', 'close', 'volume'].map(h => headers.indexOf(h));
  const closedColumn = headers.indexOf('closed');
  if (ti < 0 || columns.slice(0, 4).some(i => i < 0)) throw new Error('表头缺少 time/date 或 open,high,low,close。volume、closed 可选。');
  const result = lines.slice(1).map((line, i): Candle => {
    const row = cells(line), raw = row[ti];
    if (!raw) throw new Error(`第${i + 2}行缺少时间。`);
    let time = Number(raw);
    if (!Number.isFinite(time)) time = Date.parse(raw) / 1000;
    else if (time >= 1e11) time /= 1000;
    const values = columns.map((c, j) => c < 0 && j === 4 ? 0 : row[c] === '' || row[c] === undefined ? NaN : Number(row[c]));
    if (!Number.isFinite(time) || time <= 0 || time > Date.now() / 1000 + 86400 || values.some(v => !Number.isFinite(v))) throw new Error(`第${i + 2}行的时间或价格无效。`);
    const [open, high, low, close, volume] = values;
    if (low <= 0 || volume < 0 || high < Math.max(open, close, low) || low > Math.min(open, close)) throw new Error(`第${i + 2}行不满足OHLC价格关系。`);
    const closedRaw = closedColumn < 0 ? 'true' : row[closedColumn]?.toLowerCase();
    if (!['true', 'false', '1', '0'].includes(closedRaw)) throw new Error(`第${i + 2}行closed须为true/false或1/0。`);
    return {time: Math.floor(time), open, high, low, close, volume, closed: closedRaw === 'true' || closedRaw === '1'};
  }).sort((a, b) => a.time - b.time);
  if (new Set(result.map(c => c.time)).size !== result.length) throw new Error('存在重复时间，请先去重后导入。');
  return result;
}

export function serializeCSV(candles: Candle[]): string {
  return 'time,open,high,low,close,volume,closed\n' + candles.map(c => [new Date(c.time * 1000).toISOString(), c.open, c.high, c.low, c.close, c.volume, c.closed !== false].join(',')).join('\n');
}
