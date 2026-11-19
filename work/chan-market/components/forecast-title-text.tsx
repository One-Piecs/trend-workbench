import type {MarketForecast} from '@/lib/forecast-types';
import type {Language} from '@/lib/language';
import {forecastTitleParts} from './forecast-copy';

const contextColors={long:'#85e6c0',short:'#f6a2ab',neutral:'#bfccd3'};

export default function ForecastTitleText({forecast,language,dataFresh,svg=false}:{
  forecast:MarketForecast;language:Language;dataFresh:boolean;svg?:boolean;
}) {
  const [selected,higher]=forecastTitleParts(forecast,language,dataFresh);
  if(!higher)return selected;
  const color=contextColors[forecast.timeframeAssessment?.higherDirection??'neutral'];
  return <>{selected}{' · '}{svg?<tspan fill={color}>{higher}</tspan>:<span style={{color}}>{higher}</span>}</>;
}
