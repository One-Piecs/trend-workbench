import { test } from 'node:test';
import assert from 'node:assert/strict';
import { marketDisplayText, marketLoadErrorText, marketVenueSuffix, translateMarketText, translateInstrumentName } from '../lib/market-i18n.ts';

for (const language of ['zh', 'en'] as const) {
  test(`a finished spot request summarizes all failed providers once (${language})`, () => {
    const prefix = '现货行情暂不可用：';
    const unavailable = marketLoadErrorText(prefix + 'Kraken 暂不可用，正在切换独立行情源。；OKX 暂不可用，正在切换独立行情源。请稍后重试。', language);
    assert.doesNotMatch(unavailable, /kraken|okx|切换|switching/i);
    const mixed = marketLoadErrorText(prefix + 'Kraken 返回 HTTP 429；OKX 返回 HTTP 429；Binance 未收录该交易对。请稍后重试。', language);
    assert.equal(mixed.match(/HTTP 429/g)?.length, 1);
    assert.doesNotMatch(mixed, /未收录|does not list|none of the queried/i);
    const missing = marketLoadErrorText(prefix + 'Kraken 未收录该交易对；OKX 未收录该交易对。请稍后重试。', language);
    assert.match(missing, /未收录|lists this trading pair/);
    assert.equal(marketLoadErrorText('Failed to fetch', language), language === 'zh' ? '未能连接行情服务。' : 'Could not connect to the market data service.');
    assert.equal(marketLoadErrorText('signal timed out', language), language === 'zh' ? '行情请求超时。' : 'The market data request timed out.');
  });

  test(`instrument and search subtitles omit hidden venues and separators (${language})`, () => {
    for (const venue of ['Binance', 'okx', '币安', '欧易', '', undefined]) {
      assert.equal(marketVenueSuffix(venue, language), '');
    }
    assert.equal(marketVenueSuffix('Kraken', language), ' · Kraken');
    assert.equal(marketVenueSuffix('上交所', language), language === 'zh' ? ' · 上交所' : ' · Shanghai Stock Exchange');
  });

  test(`source labels, old records and error details use the public display format (${language})`, () => {
    for (const venue of ['Binance', 'OKX']) {
      const source = `${venue} 公共现货行情 · BTCUSDT`;
      assert.equal(marketDisplayText(source, language), language === 'zh' ? '公共现货行情 · BTCUSDT' : 'public spot feed · BTCUSDT');
      assert.ok(translateMarketText(source, language).startsWith(venue));
    }
    const error = marketDisplayText('现货行情暂不可用：Binance 返回 HTTP 403；OKX 连接超时或数据格式异常。请稍后重试。', language);
    assert.doesNotMatch(error, /binance|okx|币安|欧易/i);
    assert.match(error, /HTTP 403/);
    assert.doesNotMatch(marketDisplayText('https://data-api.binance.vision/api/v3/klines · www.okx.com', language), /binance|okx/i);
    assert.match(marketDisplayText('Kraken 公共现货行情 · XBTUSDT', language), /Kraken.*XBTUSDT/);
  });
}

test('market translations retain provider names, HTTP codes, numeric counts and currencies',()=>{
  const error=translateMarketText('现货行情暂不可用：Binance 返回 HTTP 403；OKX 连接超时或数据格式异常。请稍后重试。','en');
  assert.match(error,/Binance returned HTTP 403/);
  assert.match(error,/OKX connection timed out/);
  assert.doesNotMatch(error,/\p{Script=Han}/u);
  const warning=translateMarketText('当前使用 Bitget 的 BTC/USDT 现货；保留相同报价币，没有使用USD替代USDT。','en');
  assert.match(warning,/Bitget spot data for BTC\/USDT/);
  assert.match(warning,/USD is not substituted for USDT/);
  assert.match(translateMarketText('行情源本次仅返回170根K线，历史统计样本可能不足。','en'),/170 candles/);
});

test('English warning retains short-selling and open-month limitations',()=>{
  const short=translateMarketText('A股展示看多/看空倾向；看空信号不代表该标的可以直接卖空。','en');
  assert.match(short,/does not mean the stock can be shorted/);
  const month=translateMarketText('月线按上海自然月聚合；当前月在进入下月后才标记已收盘。','en');
  assert.match(month,/Shanghai calendar months/);
  assert.match(month,/only after the next month begins/);
});

test('source and dynamic period diagnostics are readable in English',()=>{
  assert.equal(translateMarketText('腾讯证券 原生美股月K · ifzq.gtimg.cn','en'),'Tencent Securities native US monthly candles · ifzq.gtimg.cn');
  assert.match(translateMarketText('Yahoo实际周期3mo与请求的1M不一致，已拒绝错周期数据。','en'),/3mo, not the requested 1M/);
  assert.match(translateMarketText('月线源本次返回170根，历史统计样本可能不足。','en'),/monthly feed returned 170 candles/);
  assert.equal(translateMarketText('上交所','en'),'Shanghai Stock Exchange');
});

test('unknown upstream prose is explicitly untranslated and retains diagnostic identifiers',()=>{
  const result=translateMarketText('未知提供商发生异常 HTTP 520，交易对 BTCUSDT','en');
  assert.match(result,/could not be translated/);
  assert.match(result,/HTTP 520/);
  assert.match(result,/BTCUSDT/);
  assert.doesNotMatch(result,/\p{Script=Han}/u);
});

test('Chinese messages and unknown proper company names are preserved',()=>{
  const warning='行情源本次仅返回170根K线，历史统计样本可能不足。';
  assert.equal(translateMarketText(warning,'zh'),warning);
  assert.equal(translateInstrumentName('比特币 Bitcoin','en'),'Bitcoin');
  assert.equal(translateInstrumentName('洛阳钼业','en'),'洛阳钼业');
  assert.equal(translateInstrumentName('苹果 Apple','zh'),'苹果 Apple');
});
