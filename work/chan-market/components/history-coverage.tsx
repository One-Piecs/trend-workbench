import type { MarketData } from '@/lib/market-types';
import { useLanguage, type Language } from '@/lib/language';

export default function HistoryCoverage({data,earlierBars=0,language:override}:{data:MarketData|null;earlierBars?:number;language?:Language}) {
  const context=useLanguage(),language=override??context.language,locale=language==='zh'?'zh-CN':'en-US';
  const t=(zh:string,en:string)=>language==='zh'?zh:en;
  if(!data)return null;
  const history=data.history;
  const received=data.candles.length+earlierBars;
  const closed=data.candles.filter(candle=>candle.closed!==false).length+earlierBars;
  const status=history?.status??(closed<35?'insufficient':null);
  const statusText=status==='insufficient'?t('历史不足','Insufficient history'):status==='limited'?t('历史有限','Limited history'):status==='target-met'?t('已达加载目标','Load target met'):null;
  return <div className={`history-coverage${status?` ${status}`:''}`} role="status" aria-label={t('历史数据覆盖','History coverage')} data-testid="history-coverage">
    <span>{t('已加载','Loaded')} <strong>{received.toLocaleString(locale)}</strong> {t('根','bars')}{!earlierBars&&history&&<> / {t('首批目标','initial target')} <strong>{history.requested.toLocaleString(locale)}</strong> {t('根','bars')}</>}</span>
    <span>{t('已完成','Completed')} <strong>{closed.toLocaleString(locale)}</strong> {t('根','bars')}</span>
    {!earlierBars&&statusText&&<span className="history-coverage-state">{statusText}</span>}
  </div>;
}
