import {useLanguage} from '@/lib/language';

export type CenterLayerMode='all'|'stroke'|'segment';

export default function CenterLayerSelector({value,onChange}:{value:CenterLayerMode;onChange:(value:CenterLayerMode)=>void}) {
  const {t}=useLanguage();
  return <label style={{display:'inline-flex',alignItems:'center',gap:7,marginLeft:6,fontSize:14,color:'#bed2dc'}}>
    <span>{t('中枢层级','Center layers')}</span>
    <select aria-label={t('中枢层级','Center layers')} value={value} onChange={e=>onChange(e.target.value as CenterLayerMode)} style={{border:'1px solid #527180',borderRadius:4,padding:'5px 8px',fontSize:14,background:'#172a35',color:'#e2edf2'}}>
      <option value="all">{t('全部','All')}</option>
      <option value="stroke">{t('笔中枢（局部）','Stroke centers (local)')}</option>
      <option value="segment">{t('线段中枢','Segment centers')}</option>
    </select>
  </label>;
}
