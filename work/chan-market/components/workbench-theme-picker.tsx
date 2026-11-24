"use client";

import {useEffect, useId, useRef, useState, useSyncExternalStore} from 'react';
import type {CSSProperties, KeyboardEvent} from 'react';
import {Check, Palette} from 'lucide-react';
import {useLanguage} from '@/lib/language';
import {applyWorkbenchTheme, DEFAULT_THEME, findWorkbenchTheme, WORKBENCH_THEME_KEY, workbenchThemes, type WorkbenchTheme} from '@/lib/workbench-themes';

const changeEvent = 'workbench-theme-change';
const getTheme = () => findWorkbenchTheme(document.documentElement.dataset.workbenchTheme).id;
const getDefault = () => DEFAULT_THEME;

function subscribe(notify: () => void) {
  function synchronize(event: StorageEvent) {
    if (event.key !== WORKBENCH_THEME_KEY && event.key !== null) return;
    try { if (event.storageArea !== window.localStorage) return; } catch { return; }
    applyWorkbenchTheme(findWorkbenchTheme(event.newValue));
    notify();
  }
  window.addEventListener('storage', synchronize);
  window.addEventListener(changeEvent, notify);
  return () => {
    window.removeEventListener('storage', synchronize);
    window.removeEventListener(changeEvent, notify);
  };
}

function ThemePreview({theme}: {theme: WorkbenchTheme}) {
  const colors = {
    '--preview-paper':theme.chart, '--preview-accent':theme.accent,
    '--preview-up':theme.up, '--preview-down':theme.down,
  } as CSSProperties;
  return <span className="workbench-theme-preview" style={colors} aria-hidden="true"><i/><i/><i/><i/><i/></span>;
}

export default function WorkbenchThemePicker() {
  const {language,t} = useLanguage();
  const selected = useSyncExternalStore(subscribe, getTheme, getDefault);
  const [opening,setOpening] = useState<'selected'|'first'|'last'|null>(null);
  const box = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const id = useId();

  useEffect(() => {
    if (!opening) return;
    const items = menu.current?.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]');
    if (items?.length) {
      const initial = opening === 'first' ? items[0] : opening === 'last' ? items[items.length-1]
        : menu.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]');
      initial?.focus({preventScroll:true});
    }
    function outside(event: PointerEvent) {
      if (event.target instanceof Node && !box.current?.contains(event.target)) setOpening(null);
    }
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [opening]);

  function closeAndFocus() {
    setOpening(null);
    trigger.current?.focus({preventScroll:true});
  }
  function choose(theme: WorkbenchTheme) {
    applyWorkbenchTheme(theme);
    try { localStorage.setItem(WORKBENCH_THEME_KEY, theme.id); } catch { /* The selection still applies in this window. */ }
    window.dispatchEvent(new Event(changeEvent));
    closeAndFocus();
  }
  function navigate(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape' || (event.key === 'Tab' && event.shiftKey)) {
      event.preventDefault();
      event.stopPropagation();
      closeAndFocus();
      return;
    }
    const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]'));
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    let next: number;
    switch (event.key) {
      case 'Home': next = 0; break;
      case 'End': next = items.length-1; break;
      case 'ArrowDown': next = (index+1)%items.length; break;
      case 'ArrowUp': next = (index+items.length-1)%items.length; break;
      default: return;
    }
    event.preventDefault();
    items[next]?.focus();
  }

  return <div ref={box} className="workbench-theme-picker" onBlur={e=>{
    if (!e.currentTarget.contains(e.relatedTarget)) setOpening(null);
  }}>
    <button ref={trigger} type="button" className="workbench-theme-trigger"
      aria-label={t('切换主题','Switch theme')} title={t('切换主题','Switch theme')}
      aria-haspopup="menu" aria-expanded={!!opening} aria-controls={opening?id:undefined}
      onClick={()=>setOpening(opening?null:'selected')}
      onKeyDown={event=>{
        if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
        event.preventDefault();
        setOpening(event.key === 'ArrowDown' ? 'first' : 'last');
      }}>
      <Palette size={17} strokeWidth={1.8} aria-hidden="true"/><span>{t('主题','Theme')}</span>
    </button>
    {opening&&<div ref={menu} id={id} role="menu" aria-label={t('界面主题','Appearance themes')} className="workbench-theme-menu" onKeyDown={navigate}>
      {workbenchThemes.map(theme=><button key={theme.id} type="button" role="menuitemradio" tabIndex={-1}
        data-theme-id={theme.id} aria-checked={selected===theme.id} className="workbench-theme-option" onClick={()=>choose(theme)}>
        <ThemePreview theme={theme}/><span>{theme[language]}</span>{selected===theme.id&&<Check size={17} strokeWidth={2.4} aria-hidden="true"/>}
      </button>)}
    </div>}
  </div>;
}
