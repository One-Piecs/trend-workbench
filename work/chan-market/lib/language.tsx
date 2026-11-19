"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { WORKBENCH_BRAND } from './workbench-brand';

export type Language='zh'|'en';
type LanguageContextValue={language:Language;setLanguage:(language:Language)=>void;t:(zh:string,en:string)=>string;locale:string};
const LanguageContext=createContext<LanguageContextValue>({language:'zh',setLanguage:()=>{},t:zh=>zh,locale:'zh-CN'});
export function LanguageProvider({children}:{children:ReactNode}) {
  const [language,updateLanguage]=useState<Language>('zh');
  // The persisted preference belongs to the browser; SSR always starts in Chinese.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(()=>{try{if(localStorage.getItem('chan-language-v1')==='en')updateLanguage('en');}catch{}},[]);
  const setLanguage=useCallback((next:Language)=>{updateLanguage(next);try{localStorage.setItem('chan-language-v1',next);}catch{}},[]);
  useEffect(()=>{document.documentElement.lang=language==='zh'?'zh-CN':'en';document.title=WORKBENCH_BRAND.name[language];},[language]);
  const t=useCallback((zh:string,en:string)=>language==='zh'?zh:en,[language]);
  const value=useMemo(()=>({language,setLanguage,t,locale:language==='zh'?'zh-CN':'en-US'}),[language,setLanguage,t]);
  return <LanguageContext.Provider value={value}>{children}</LanguageContext.Provider>;
}
export const useLanguage=()=>useContext(LanguageContext);
