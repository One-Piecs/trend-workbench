export const WORKBENCH_THEME_KEY = 'workbench-theme-v1';
export const DEFAULT_THEME = 'mint';

export const workbenchThemes = [
  {id:'mint', zh:'薄荷白', en:'Mint White', scheme:'light', surface:'#ffffff', chart:'#ffffff', accent:'#056c67', up:'#087e65', down:'#c94249'},
  {id:'tradingview', zh:'TradingView 深色', en:'TradingView Dark', scheme:'dark', surface:'#1e222d', chart:'#131722', accent:'#2962ff', up:'#26a69a', down:'#ef5350'},
  {id:'parchment', zh:'暖纸铜', en:'Parchment Copper', scheme:'light', surface:'#fffcf6', chart:'#fffaf0', accent:'#924721', up:'#207555', down:'#ab4540'},
  {id:'glacier', zh:'冰川蓝', en:'Glacier Blue', scheme:'light', surface:'#fbfdff', chart:'#f4faff', accent:'#2456a6', up:'#007967', down:'#b93657'},
  {id:'amethyst', zh:'紫晶夜', en:'Amethyst Night', scheme:'dark', surface:'#2b2337', chart:'#211c2c', accent:'#ae85d5', up:'#63cbb4', down:'#ef829b'},
] as const;
export type WorkbenchTheme = typeof workbenchThemes[number];

export function findWorkbenchTheme(id: string | null | undefined): WorkbenchTheme {
  return workbenchThemes.find(theme => theme.id === id) ?? workbenchThemes[0];
}

export function applyWorkbenchTheme(theme: WorkbenchTheme) {
  const root = document.documentElement;
  root.dataset.workbenchTheme = theme.id;
  root.style.colorScheme = theme.scheme;
  document.querySelector('meta[name="color-scheme"]')?.setAttribute('content', theme.scheme);
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme.surface);
}

// Both desktop and web run this before first paint. Embed only the shell
// colors, so restoring a preference doesn't need the React bundle.
const appearance = workbenchThemes.map(({id,scheme,surface}) => ({id,scheme,surface}));
export const themeInitScript = `(()=>{const themes=${JSON.stringify(appearance)};let id;try{id=localStorage.getItem(${JSON.stringify(WORKBENCH_THEME_KEY)})}catch{}const t=themes.find(t=>t.id===id)||themes[0];const root=document.documentElement;root.dataset.workbenchTheme=t.id;root.style.colorScheme=t.scheme;document.querySelector('meta[name="theme-color"]')?.setAttribute('content',t.surface);document.querySelector('meta[name="color-scheme"]')?.setAttribute('content',t.scheme)})()`;
