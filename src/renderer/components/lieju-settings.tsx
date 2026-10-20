import React, { useEffect, useRef, useState } from 'react';
import { CheckCircle2, X } from 'lucide-react';
import { Button, CardContent, CardDescription, CardFooter, CardHeader, CardTitle, Field, FieldGroup } from './ui.js';
import type { Project } from '../../main/project-store.js';
import { defaultLiejuSettings, liejuSettingsSchema, type LiejuFormField, type LiejuFormOptions, type LiejuSettings } from '../../shared/platform-settings.js';
import { liejuCities, liejuCategoryGroups } from '../../shared/lieju-catalog.js';

const coreFields: Record<string, keyof LiejuSettings> = { atc_zone_id: 'districtId', atc_leibie: 'subcategoryId', atc_gongsi: 'company', atc_mobphone: 'phone', atc_linkman: 'contact', atc_danjia: 'price' };

function CitySearch({ value, disabled, onChange }: { value: string; disabled: boolean; onChange: (value: string) => void }) {
  const [query, setQuery] = useState(() => liejuCities.find(city => city.value === value)?.label ?? '');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const list = useRef<HTMLUListElement>(null);
  const matches = liejuCities.filter(city => city.label.includes(query.trim().replace(/市$/, '')));
  const choose = (city: typeof liejuCities[number]) => {
    setQuery(city.label); onChange(city.value); setOpen(false); setActive(-1);
  };
  useEffect(() => { list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' }); }, [active]);
  return <div className="lieju-city-search">
    <input id="lieju-city" role="combobox" disabled={disabled} aria-autocomplete="list" aria-expanded={open && !disabled}
      aria-controls="lieju-city-options" aria-activedescendant={open && !disabled && matches[active] ? `lieju-city-option-${matches[active].value}` : undefined}
      autoComplete="off" placeholder="输入城市名，如东莞" value={query}
      onFocus={() => { setOpen(true); setActive(-1); }}
      onBlur={() => setOpen(false)}
      onChange={event => {
        const text = event.target.value;
        setQuery(text); setOpen(true); setActive(-1);
        onChange(liejuCities.find(city => city.label === text.trim().replace(/市$/, ''))?.value ?? '');
      }}
      onKeyDown={event => {
        if (event.nativeEvent.isComposing || event.keyCode === 229) return;
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault(); setOpen(true);
          setActive(previous => !matches.length ? -1 : previous < 0
            ? event.key === 'ArrowDown' ? 0 : matches.length - 1
            : (previous + (event.key === 'ArrowDown' ? 1 : -1) + matches.length) % matches.length);
        } else if (event.key === 'Enter' && open) {
          event.preventDefault();
          const city = matches[active] ?? (matches.length === 1 ? matches[0] : undefined);
          if (city) choose(city);
        } else if (event.key === 'Escape' && open) {
          event.preventDefault(); event.stopPropagation(); setOpen(false);
        }
      }}/>
    {open && !disabled && <ul ref={list} id="lieju-city-options" role="listbox" aria-label="匹配城市">
      {matches.map((city, index) => <li key={city.value} id={`lieju-city-option-${city.value}`} role="option"
        aria-selected={active === index} onMouseDown={event => event.preventDefault()} onClick={() => choose(city)}>{city.label}</li>)}
      {!matches.length && <li role="presentation">未找到城市，请输入城市中文名</li>}
    </ul>}
  </div>;
}

export function LiejuSettingsDialog({ project, busy, close, onSaved }: { project: Project; busy: boolean; close: () => void; onSaved: () => Promise<void> }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [values, setValues] = useState<LiejuSettings>(() => liejuSettingsSchema.parse(project.publishingDefaults.lieju ?? { ...defaultLiejuSettings, company: project.companyName }));
  const [group, setGroup] = useState(() => liejuCategoryGroups.find(item => item.categories.some(category => category.value === values.categoryId))?.value ?? '');
  const [form, setForm] = useState<LiejuFormOptions | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const [reload, setReload] = useState(0);
  useEffect(() => { dialog.current?.showModal(); }, []);
  useEffect(() => {
    let active = true;
    setForm(null); setMessage('');
    if (!values.cityId || !values.categoryId) { setLoading(false); return; }
    setLoading(true);
    void window.geoPublisher.liejuFormOptions(project.id, values.cityId, values.categoryId).then(result => { if (active) setForm(result); })
      .catch(error => { if (active) setMessage(String(error.message || error)); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [project.id, values.cityId, values.categoryId, reload]);
  const locked = busy || saving;
  const update = (key: keyof LiejuSettings, value: string) => setValues(previous => ({ ...previous, [key]: value }));
  const fieldValue = (field: LiejuFormField): string => String(coreFields[field.id] ? values[coreFields[field.id]] : values.extraFields[field.id] ?? '');
  const fieldValid = (field: LiejuFormField) => {
    const value = fieldValue(field);
    return (!field.required || !!value.trim()) && (!value || field.kind !== 'select' || field.options.some(option => option.value === value)) && (!field.maxLength || value.length <= field.maxLength);
  };
  const valid = !!form && form.fields.every(fieldValid) && liejuSettingsSchema.safeParse(values).success && !!values.cityId && !!values.categoryId && !!values.districtId && !!values.contact && /^[0-9]{6,12}$|^[0-9]{3,4}-[0-9]{6,8}(?:-[0-9]{1,6})?$/.test(values.phone);
  const save = async () => {
    if (!valid || locked) return;
    setSaving(true); setMessage('');
    try {
      await window.geoPublisher.updateProject(project.id, { publishingDefaults: { ...project.publishingDefaults, lieju: values } });
      await onSaved(); close();
    } catch (error) { setMessage((error as Error).message); } finally { setSaving(false); }
  };
  const dismiss = () => { if (!saving) close(); };
  return <dialog ref={dialog} className="platform-settings-dialog" aria-labelledby="lieju-settings-title" onCancel={event => { event.preventDefault(); dismiss(); }}>
    <section className="platform-settings-dialog-layout">
      <CardHeader><div><CardTitle><span id="lieju-settings-title">列举网发布设置</span></CardTitle><CardDescription>{project.name} · 设置仅用于当前客户，每次自动填写后由你完成滑块并提交。</CardDescription></div><Button variant="ghost" icon={X} disabled={saving} aria-label="关闭列举网设置" onClick={dismiss}/></CardHeader>
      <CardContent><div className="platform-setting-groups"><fieldset className="platform-setting-group" disabled={locked}><legend>地区与分类</legend><FieldGroup>
        <Field label="城市" htmlFor="lieju-city"><CitySearch value={values.cityId} disabled={locked} onChange={cityId => setValues(previous => previous.cityId === cityId ? previous : ({ ...previous, cityId, districtId: '' }))}/></Field>
        <Field label="行业大类" htmlFor="lieju-group"><select id="lieju-group" value={group} onChange={event => { setGroup(event.target.value); setValues(previous => ({ ...previous, categoryId: '', subcategoryId: '', extraFields: {} })); }}><option value="">请选择行业大类</option>{liejuCategoryGroups.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}</select></Field>
        <Field label="发布分类" htmlFor="lieju-category"><select id="lieju-category" value={values.categoryId} disabled={!group || locked} onChange={event => setValues(previous => ({ ...previous, categoryId: event.target.value, subcategoryId: '', extraFields: {} }))}><option value="">请选择发布分类</option>{liejuCategoryGroups.find(item => item.value === group)?.categories.map(category => <option key={category.value} value={category.value}>{category.label}</option>)}</select></Field>
        {form?.fields.filter(field => !['atc_gongsi', 'atc_mobphone', 'atc_linkman', 'atc_danjia'].includes(field.id)).map(field => <Field key={field.id} label={`${field.label}${field.required ? ' *' : '（选填）'}`} htmlFor={`lieju-${field.id}`}>{field.kind === 'select' ? <select id={`lieju-${field.id}`} value={fieldValue(field)} onChange={event => coreFields[field.id] ? update(coreFields[field.id], event.target.value) : setValues(previous => ({ ...previous, extraFields: { ...previous.extraFields, [field.id]: event.target.value } }))}><option value="">请选择</option>{field.options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select> : <input id={`lieju-${field.id}`} value={fieldValue(field)} maxLength={field.maxLength} onChange={event => setValues(previous => ({ ...previous, extraFields: { ...previous.extraFields, [field.id]: event.target.value } }))}/>}</Field>)}
      </FieldGroup>{loading && <p role="status">正在读取该城市和分类的表单选项…</p>}</fieldset>
      <fieldset className="platform-setting-group" disabled={locked}><legend>默认发布资料</legend><FieldGroup>
        {([['company', '公司名称'], ['phone', '联系电话'], ['contact', '联系人'], ['price', '默认单价（元）']] as const).map(([key, label]) => <Field key={key} label={label} htmlFor={`lieju-${key}`} description={key === 'price' ? '默认填写 1 元；这是网站对外显示的单价，可以修改。' : key === 'phone' ? '填写手机号或带区号的固定电话，不含空格。' : undefined}><input id={`lieju-${key}`} type="text" inputMode={key === 'price' ? 'numeric' : key === 'phone' ? 'tel' : 'text'} value={values[key]} maxLength={key === 'phone' ? 20 : key === 'contact' ? 25 : key === 'price' ? 12 : 100} onChange={event => update(key, event.target.value)}/></Field>)}
      </FieldGroup></fieldset>{message && <p role="alert" style={{ color: '#b42318', overflowWrap: 'anywhere' }}>{message}<Button variant="ghost" disabled={loading || locked} onClick={() => setReload(value => value + 1)}>重新读取选项</Button></p>}</div></CardContent>
      <CardFooter><Button variant="outline" disabled={saving} onClick={dismiss}>取消</Button><Button icon={CheckCircle2} disabled={!valid || loading || locked} onClick={() => void save()}>{saving ? '正在保存' : '保存设置'}</Button></CardFooter>
    </section>
  </dialog>;
}
