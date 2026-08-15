import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { AlertTriangle, Boxes, CheckCircle2, ChevronDown, Copy, Download, FileText, FolderOpen, Globe2, KeyRound, LayoutDashboard, Link2, ListChecks, LogIn, PackageOpen, Plus, Power, RefreshCw, Send, Settings2, Sparkles, UserRound, UsersRound, X } from 'lucide-react';
import { Badge, Button, Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle, Empty, Field, Progress, Spinner, Switch } from './components/ui.js';

const platforms = [['baijia', '百家号'], ['toutiao', '头条号'], ['zhihu', '知乎'], ['penguin', '企鹅号'], ['sohu', '搜狐号'], ['netease', '网易号']] as const;
const platformLabels = Object.fromEntries(platforms) as Record<string, string>;
type View = 'overview' | 'projects' | 'content' | 'distribution' | 'accounts' | 'settings';

function App() {
  const [view, setView] = useState<View>('overview'); const [status, setStatus] = useState<any>({ platforms: [] }); const [projects, setProjects] = useState<any[]>([]); const [project, setProject] = useState<any>(null); const [items, setItems] = useState<any[]>([]); const [workBuddy, setWorkBuddy] = useState<any>({ prepared: false }); const [update, setUpdate] = useState<any>({ phase: 'idle' }); const [message, setMessage] = useState('桌面端已就绪'); const [error, setError] = useState(false); const [editing, setEditing] = useState<any>(null);
  const notify = (text: string, failed = false) => { setMessage(text); setError(failed); };
  const refresh = async () => { const [s, p, w, u] = await Promise.all([window.geoPublisher.status(), window.geoPublisher.projects(), window.geoPublisher.workBuddyStatus(), window.geoPublisher.updateStatus()]); setStatus(s); setProjects(p.projects); setProject(p.currentProject); setWorkBuddy(w); setUpdate(u); setItems(p.currentProject ? (await window.geoPublisher.contentList(p.currentProject.id)).items : []); };
  useEffect(() => { void refresh().catch((e) => notify(e.message, true)); }, []); useEffect(() => window.geoPublisher.onStatusChanged(setStatus), []); useEffect(() => window.geoPublisher.onUpdateStatus(setUpdate), []); useEffect(() => window.geoPublisher.onAttentionRequired((a) => a && notify(`${platformLabels[a.platform]}：${a.message}`, true)), []);
  const busy = Boolean(status.busy); const articles = useMemo(() => items.filter((i) => i.kind === 'article'), [items]); const topics = useMemo(() => items.filter((i) => i.kind === 'topic'), [items]); const materials = useMemo(() => items.filter((i) => i.kind === 'material'), [items]);
  const openPlatform = async (id: string) => { if (busy) return notify(`正在执行${platformLabels[status.executingPlatform] || '平台'}任务，不能切换`, true); if (!project) return setEditing({ name: '', companyName: '', industry: '' }); try { await window.geoPublisher.openPlatform(id as any); notify(`${platformLabels[id]}已打开`); } catch (e) { notify((e as Error).message, true); } };
  const saveProject = async () => { if (!editing?.name?.trim()) return notify('请填写项目名称', true); try { const result = editing.id ? await window.geoPublisher.updateProject(editing.id, editing).then(() => window.geoPublisher.selectProject(editing.id)) : await window.geoPublisher.createProject(editing); setEditing(null); notify(`已切换到客户项目：${result.currentProject.name}`); await refresh(); } catch (e) { notify((e as Error).message, true); } };
  const connect = async () => { try { await window.geoPublisher.connectWorkBuddy(); setWorkBuddy({ prepared: true }); notify('连接指令已复制，请粘贴到 WorkBuddy'); } catch (e) { notify((e as Error).message, true); } };
  const nav = [['overview', '概览', LayoutDashboard], ['projects', '客户项目', UsersRound], ['content', '内容中心', FileText], ['distribution', '分发', Send], ['accounts', '平台账号', Globe2], ['settings', '设置', Settings2]] as const;
  const title = nav.find(([id]) => id === view)?.[1];
  return <div className="app-shell"><aside className="app-sidebar"><div className="app-brand"><img src="logo.png" alt="" /><div><strong>GEO Publisher</strong><small>内容与分发工作台</small></div></div><button id="project-switch" className="project-switcher" onClick={() => !busy && setEditing(project || { name: '', companyName: '', industry: '' })}><span className="project-avatar"><UserRound size={15} /></span><span><small>当前客户项目</small><strong>{project?.name || '尚未选择'}</strong></span><ChevronDown size={15} /></button><nav className="app-nav">{nav.map(([id, label, Icon]) => <button key={id} className={view === id ? 'nav-item active' : 'nav-item'} onClick={() => setView(id)}><Icon size={17} /><span>{label}</span>{id === 'distribution' && articles.length > 0 && <em>{articles.length}</em>}</button>)}</nav><div className="sidebar-bottom"><button id="connect-workbuddy" className="nav-item" onClick={connect}><Link2 size={17} /><span>连接 WorkBuddy</span><Badge tone={workBuddy.prepared ? 'success' : 'warning'}><span id="workbuddy-state">{workBuddy.prepared ? '已连接' : '未连接'}</span></Badge></button><button id="check-update" className="nav-item" onClick={() => void window.geoPublisher.checkForUpdates().then(setUpdate)}><RefreshCw size={17} /><span>检查更新</span><small>{update.availableVersion ? `v${update.availableVersion}` : ''}</small></button></div></aside><main className="app-main"><header className="app-header"><div><p>GEO Publisher / {title}</p><h1>{title}</h1></div><div><Badge tone={busy ? 'warning' : status.attentionRequired ? 'danger' : 'success'}>{busy ? `${platformLabels[status.executingPlatform] || '平台'}执行中` : status.attentionRequired ? '需要人工处理' : '运行正常'}</Badge><small className="version-label">v{status.version || update.currentVersion}</small></div></header><div className="content-area"><View view={view} project={project} projects={projects} status={status} items={items} articles={articles} topics={topics} materials={materials} busy={busy} setView={setView} openPlatform={openPlatform} edit={setEditing} refresh={refresh} workBuddy={workBuddy} setWorkBuddy={setWorkBuddy} update={update} setUpdate={setUpdate} connect={connect} notify={notify} /></div><footer id="action-message" className={error ? 'app-message error' : 'app-message'}>{error ? <AlertTriangle size={15} /> : <CheckCircle2 size={15} />}{message}</footer></main>{editing && <ProjectDialog editing={editing} setEditing={setEditing} save={saveProject} />}<span id="connection" hidden>{message}</span><span id="version" hidden>{status.version}</span><button id="beta-access" hidden>B</button><button id="beta-disable" hidden>S</button><span id="update-state" hidden>{update.phase}</span></div>;
}
function View({ view, project, projects, status, items, articles, topics, materials, busy, setView, openPlatform, edit, refresh, workBuddy, setWorkBuddy, update, setUpdate, connect, notify }: any) {
  if (!project && view !== 'projects' && view !== 'settings') return <Card className="welcome-card"><Sparkles size={28} /><p className="eyebrow">开始使用</p><h2>先创建一个客户项目</h2><p>公司资料、平台账号、素材和文章都会按客户项目独立保存。</p><Button icon={Plus} onClick={() => edit({ name: '', companyName: '', industry: '' })}>新建客户项目</Button></Card>;
  if (view === 'overview') return <><div className="hero-row"><div><p className="eyebrow">当前客户项目</p><h2 id="current-project-title">{project.name}</h2><p className="muted" id="current-project-company">{project.companyName || '未填写公司全称'} · {project.industry || '未填写行业'}</p></div><Button variant="outline" icon={Send} onClick={() => setView('distribution')}>进入分发</Button></div><div className="stat-grid"><Stat icon={FileText} label="文章包" value={articles.length}/><Stat icon={ListChecks} label="选题" value={topics.length}/><Stat icon={Boxes} label="素材" value={materials.length}/><Stat icon={Globe2} label="平台" value="6"/></div><Card><div className="card-head"><div><h3>平台账号</h3><p>登录态按客户项目与平台隔离保存。</p></div><Button variant="ghost" onClick={() => setView('accounts')}>查看全部</Button></div><div className="platform-grid">{platforms.map(([id,label]) => <button data-platform={id} key={id} onClick={() => openPlatform(id)} className="platform-tile"><span className="platform-dot"/><strong>{label}</strong><small>打开登录页</small></button>)}</div></Card></>;
  if (view === 'projects') return <Card><div className="card-head"><div><h3>客户项目</h3><p>每个项目都有独立的账号、资料和内容库。</p></div><Button icon={Plus} onClick={() => edit({ name: '', companyName: '', industry: '' })}>新建项目</Button></div>{projects.length ? <div className="item-list">{projects.map((p:any) => <button className="item-row" onClick={() => edit(p)} key={p.id}><span className="project-avatar"><UserRound size={15}/></span><span><strong>{p.name}</strong><small>{p.companyName || '未填写公司全称'}</small></span>{p.id === project?.id ? <Badge tone="success">当前项目</Badge> : <small>编辑</small>}</button>)}</div> : <Empty icon={UsersRound} title="暂无客户项目" description="创建第一个客户项目后即可配置平台账号。"/>}</Card>;
  if (view === 'content') return <Card><div className="card-head"><div><h3>内容中心</h3><p>WorkBuddy 生成的素材、选题和文章包会保存到当前项目。</p></div><Button variant="outline" icon={RefreshCw} onClick={() => void refresh()}>刷新</Button></div><div className="content-counts"><Badge>素材 {materials.length}</Badge><Badge>选题 {topics.length}</Badge><Badge>文章 {articles.length}</Badge></div>{items.length ? <div className="item-list">{items.map((i:any)=><div className="item-row" key={i.id}><FileText size={16}/><span><strong>{i.title || '未命名内容'}</strong><small>{i.kind} · {i.status}</small></span><Badge>{i.platform || '项目内容'}</Badge></div>)}</div> : <Empty icon={PackageOpen} title="内容库为空" description="在 WorkBuddy 中让它生成文章或整理素材，内容会自动出现在这里。"/>}</Card>;
  if (view === 'distribution') return <div className="two-col"><Card><div className="card-head"><div><h3>分发队列</h3><p>文章通过质量检查后才会进入此处。</p></div><Badge tone={busy ? 'warning' : 'neutral'}>{busy ? '执行中' : '空闲'}</Badge></div>{articles.length ? <div className="item-list">{articles.map((a:any)=><div className="item-row" key={a.id}><FileText size={16}/><span><strong>{a.title || '未命名文章'}</strong><small>{a.status}</small></span><Button variant="outline" disabled={busy} icon={Send} onClick={() => openPlatform(a.platform || 'baijia')}>分发</Button></div>)}</div> : <Empty icon={Send} title="暂无待分发文章" description="文章生成后会显示在这里。"/>}</Card><Card>{busy ? <div className="running"><Spinner/><strong>{platformLabels[status.executingPlatform] || '平台'}正在执行</strong><p>当前任务结束前不能切换客户项目或平台。</p></div> : <Empty icon={CheckCircle2} title="没有运行中的任务" description="平台任务会严格串行，并在结果不确定时先对账。"/>}</Card></div>;
  if (view === 'accounts') return <Card><div className="card-head"><div><h3>平台账号</h3><p>请在对应平台页面完成登录；任务运行中会自动锁定切换。</p></div><Badge tone={busy ? 'warning' : 'success'}>{busy ? '任务锁定' : '可操作'}</Badge></div><div className="account-grid">{platforms.map(([id,label])=><section key={id}><span className="platform-dot"/><strong>{label}</strong><p>登录状态需打开页面检查</p><Button variant="outline" icon={LogIn} disabled={busy} onClick={() => openPlatform(id)}>打开平台</Button></section>)}</div></Card>;
  return <SettingsView status={status} workBuddy={workBuddy} setWorkBuddy={setWorkBuddy} update={update} setUpdate={setUpdate} connect={connect} notify={notify} />;
}

function SettingsView({ status, workBuddy, setWorkBuddy, update, setUpdate, connect, notify }: any) {
  const [launchAtLogin, setLaunchAtLogin] = useState({ available: false, enabled: false });
  const [betaCode, setBetaCode] = useState('');
  const [working, setWorking] = useState<string | null>(null);

  useEffect(() => {
    void window.geoPublisher.launchAtLoginStatus().then(setLaunchAtLogin).catch((error) => notify(error.message, true));
  }, []);

  const checkUpdate = async () => {
    setWorking('update');
    try {
      const next = await window.geoPublisher.checkForUpdates();
      setUpdate(next);
      notify(next.message);
    } catch (error) {
      notify((error as Error).message, true);
    } finally {
      setWorking(null);
    }
  };
  const installUpdate = async () => {
    const result = await window.geoPublisher.installUpdate();
    notify(result.message, !result.accepted);
  };
  const activateBeta = async () => {
    if (!betaCode.trim()) return notify('请输入 Beta 邀请码', true);
    setWorking('beta');
    try {
      const result = await window.geoPublisher.activateBeta(betaCode);
      setUpdate(result.update);
      if (result.accepted) setBetaCode('');
      notify(result.message, !result.accepted);
    } finally {
      setWorking(null);
    }
  };
  const deactivateBeta = async () => {
    setWorking('beta');
    try {
      const result = await window.geoPublisher.deactivateBeta();
      setUpdate(result.update);
      notify(result.message, !result.accepted);
    } finally {
      setWorking(null);
    }
  };
  const toggleLaunchAtLogin = async (enabled: boolean) => {
    setWorking('launch');
    try {
      const result = await window.geoPublisher.setLaunchAtLogin(enabled);
      setLaunchAtLogin(result);
      notify(result.enabled ? '已开启开机启动' : '已关闭开机启动');
    } catch (error) {
      notify((error as Error).message, true);
    } finally {
      setWorking(null);
    }
  };
  const copyDiagnostics = async () => {
    try {
      await window.geoPublisher.copyDiagnostics();
      notify('脱敏诊断信息已复制');
    } catch (error) {
      notify((error as Error).message, true);
    }
  };
  const openDataDirectory = async () => {
    const result = await window.geoPublisher.openDataDirectory();
    notify(result.opened ? '已打开本地数据目录' : `无法打开数据目录：${result.error || '未知错误'}`, !result.opened);
  };

  return <div className="settings-grid">
    <div className="settings-column">
      <Card className="settings-card">
        <CardHeader><div><CardTitle>WorkBuddy 连接</CardTitle><CardDescription>刷新生产 Skill 和当前电脑的 CLI 调用路径。</CardDescription></div><Badge tone={workBuddy.prepared ? 'success' : 'warning'}>{workBuddy.prepared ? '已准备' : '未配置'}</Badge></CardHeader>
        <CardContent><div className="setting-row"><div><strong>生产 CLI</strong><p>只向 WorkBuddy 提供发布所需命令，开发诊断命令不会随安装包分发。</p></div><Badge>production</Badge></div></CardContent>
        <CardFooter><Button id="settings-connect-workbuddy" icon={Link2} onClick={() => void connect()}>重新连接 WorkBuddy</Button></CardFooter>
      </Card>

    </div>

    <div className="settings-column">
      <Card className="settings-card">
        <CardHeader><div><CardTitle>应用更新</CardTitle><CardDescription>当前版本 v{update.currentVersion || status.version}，使用{update.channel === 'beta' ? '灰度' : '正式'}更新通道。</CardDescription></div><Badge tone={update.channel === 'beta' ? 'warning' : 'success'}>{update.channel === 'beta' ? 'Beta' : 'Stable'}</Badge></CardHeader>
        <CardContent>
          <div className="setting-row"><div><strong>{update.message || '等待检查更新'}</strong><p>{update.availableVersion ? `可更新到 v${update.availableVersion}` : '发现新版本后会自动下载，任务执行期间不会重启。'}</p></div>{update.progress != null && <span className="setting-value">{update.progress}%</span>}</div>
          {update.progress != null && <Progress value={update.progress} />}
          {update.channel === 'beta' ? <div className="beta-panel"><div><strong>Beta 灰度已开启</strong><p>退出后会重新检查正式版通道，不会立即降级当前应用。</p></div><Button variant="outline" disabled={working === 'beta'} onClick={() => void deactivateBeta()}>退出 Beta</Button></div> : <Field label="Beta 邀请码" description="只有参与灰度测试时才需要填写。" htmlFor="beta-invite-code"><div className="input-action"><KeyRound size={16}/><input id="beta-invite-code" value={betaCode} onChange={(event) => setBetaCode(event.target.value)} placeholder="BETA-XXXXXX" autoComplete="off"/><Button variant="outline" disabled={working === 'beta'} onClick={() => void activateBeta()}>启用</Button></div></Field>}
        </CardContent>
        <CardFooter><Button variant="outline" icon={RefreshCw} disabled={working === 'update'} onClick={() => void checkUpdate()}>检查更新</Button>{update.canRestart && <Button icon={Download} disabled={status.busy} onClick={() => void installUpdate()}>重启并安装</Button>}</CardFooter>
      </Card>

      <Card className="settings-card">
        <CardHeader><div><CardTitle>启动与后台运行</CardTitle><CardDescription>开机后启动桌面端并保持待机，不会自动发布文章。</CardDescription></div><Power size={18}/></CardHeader>
        <CardContent><div className="setting-row"><div><strong>开机启动</strong><p>{launchAtLogin.available ? '后台启动后，WorkBuddy 可以直接连接生产 CLI。' : '开发模式下不可修改，正式安装包中可用。'}</p></div><Switch label="开机启动" checked={launchAtLogin.enabled} disabled={!launchAtLogin.available || working === 'launch'} onCheckedChange={(enabled) => void toggleLaunchAtLogin(enabled)} /></div></CardContent>
      </Card>

      <Card className="settings-card">
        <CardHeader><div><CardTitle>诊断与本地数据</CardTitle><CardDescription>用于排查连接和更新问题，不会复制客户资料或账号信息。</CardDescription></div><Badge>本机保存</Badge></CardHeader>
        <CardContent><div className="setting-row"><div><strong>脱敏诊断信息</strong><p>仅包含版本、系统、生产 CLI、任务状态和错误码。</p></div></div><div className="setting-row"><div><strong>应用数据目录</strong><p>客户项目、内容库和平台会话按项目隔离保存在本机。</p></div></div></CardContent>
        <CardFooter><Button variant="outline" icon={Copy} onClick={() => void copyDiagnostics()}>复制诊断信息</Button><Button variant="outline" icon={FolderOpen} onClick={() => void openDataDirectory()}>打开数据目录</Button></CardFooter>
      </Card>
    </div>
  </div>;
}
function Stat({icon:Icon,label,value}:any){return <Card className="stat"><Icon size={18}/><span>{label}</span><strong>{value}</strong></Card>}
function ProjectDialog({editing,setEditing,save}:any){return <dialog id="project-dialog" open className="project-dialog"><div className="dialog-head"><div><p className="eyebrow">客户资料</p><h2>{editing.id?'编辑客户项目':'新建客户项目'}</h2></div><Button variant="ghost" icon={X} onClick={()=>setEditing(null)} aria-label="关闭"/></div><div className="dialog-body"><label>项目名称<input id="project-input-name" value={editing.name||''} onChange={e=>setEditing({...editing,name:e.target.value})}/></label><label>公司全称<input id="project-company-name" value={editing.companyName||''} onChange={e=>setEditing({...editing,companyName:e.target.value})}/></label><label>行业与核心业务<textarea id="project-industry" rows={3} value={editing.industry||''} onChange={e=>setEditing({...editing,industry:e.target.value})}/></label><details><summary>补充资料</summary><label>核心产品或服务<textarea rows={3} value={editing.products||''} onChange={e=>setEditing({...editing,products:e.target.value})}/></label><label>差异化价值与目标客户<textarea rows={3} value={editing.valueAndAudience||''} onChange={e=>setEditing({...editing,valueAndAudience:e.target.value})}/></label></details></div><div className="dialog-foot"><Button variant="outline" onClick={()=>setEditing(null)}>取消</Button><Button id="project-save" icon={editing.id?CheckCircle2:Plus} onClick={()=>void save()}>{editing.id?'保存修改':'创建项目'}</Button></div></dialog>}
createRoot(document.getElementById('root')!).render(<App/>);
