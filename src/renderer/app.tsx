import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { AlertTriangle, Boxes, BriefcaseBusiness, Building2, CheckCircle2, ChevronDown, ContactRound, Copy, Download, FileText, FolderOpen, Globe2, KeyRound, LayoutDashboard, Link2, ListChecks, LogIn, MessageSquareText, PackageOpen, Plus, Power, RefreshCw, Send, Settings2, ShieldCheck, Sparkles, UserRound, UsersRound, X } from 'lucide-react';
import { Badge, Button, Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle, Empty, Field, FieldGroup, Progress, Spinner, Switch } from './components/ui.js';

const platforms = [['baijia', '百家号'], ['toutiao', '头条号'], ['zhihu', '知乎'], ['penguin', '企鹅号'], ['sohu', '搜狐号'], ['netease', '网易号']] as const;
const platformLabels = Object.fromEntries(platforms) as Record<string, string>;
type View = 'overview' | 'projects' | 'content' | 'distribution' | 'accounts' | 'settings';

function App() {
  const [view, setView] = useState<View>('overview'); const [status, setStatus] = useState<any>({ platforms: [] }); const [projects, setProjects] = useState<any[]>([]); const [project, setProject] = useState<any>(null); const [items, setItems] = useState<any[]>([]); const [workBuddy, setWorkBuddy] = useState<any>({ prepared: false }); const [update, setUpdate] = useState<any>({ phase: 'idle' }); const [message, setMessage] = useState('桌面端已就绪'); const [error, setError] = useState(false); const [editing, setEditing] = useState<any>(null);
  const appliedRevision = useRef(-1);
  const pendingRevision = useRef(-1);
  const notify = useCallback((text: string, failed = false) => { setMessage(text); setError(failed); }, []);
  const applyWorkspaceSnapshot = useCallback((snapshot: Awaited<ReturnType<typeof window.geoPublisher.workspaceSnapshot>>) => {
    if (snapshot.revision < appliedRevision.current) return;
    appliedRevision.current = snapshot.revision;
    pendingRevision.current = Math.max(pendingRevision.current, snapshot.revision);
    setProjects(snapshot.projects);
    setProject(snapshot.currentProject);
    setItems(snapshot.items);
  }, []);
  const refreshWorkspace = useCallback(async () => applyWorkspaceSnapshot(await window.geoPublisher.workspaceSnapshot()), [applyWorkspaceSnapshot]);
  const refresh = useCallback(async () => {
    const [s, w, u, snapshot] = await Promise.all([window.geoPublisher.status(), window.geoPublisher.workBuddyStatus(), window.geoPublisher.updateStatus(), window.geoPublisher.workspaceSnapshot()]);
    setStatus(s); setWorkBuddy(w); setUpdate(u); applyWorkspaceSnapshot(snapshot);
  }, [applyWorkspaceSnapshot]);
  useEffect(() => { void refresh().catch((e) => notify(e.message, true)); }, [refresh, notify]);
  useEffect(() => window.geoPublisher.onStatusChanged(setStatus), []);
  useEffect(() => window.geoPublisher.onUpdateStatus(setUpdate), []);
  useEffect(() => window.geoPublisher.onAttentionRequired((a) => a && notify(`${platformLabels[a.platform]}：${a.message}`, true)), [notify]);
  useEffect(() => {
    let refreshTimer: number | undefined;
    const scheduleRefresh = (revision: number) => {
      pendingRevision.current = Math.max(pendingRevision.current, revision);
      if (refreshTimer !== undefined) window.clearTimeout(refreshTimer);
      refreshTimer = window.setTimeout(() => {
        refreshTimer = undefined;
        if (pendingRevision.current <= appliedRevision.current) return;
        void refreshWorkspace().catch((e) => notify(e.message, true));
      }, 200);
    };
    const checkRevision = () => {
      void window.geoPublisher.dataRevision()
        .then((revision) => { if (revision > appliedRevision.current) scheduleRefresh(revision); })
        .catch((e) => notify(e.message, true));
    };
    const unsubscribe = window.geoPublisher.onDataChanged((change) => scheduleRefresh(change.revision));
    const onVisibilityChange = () => { if (document.visibilityState === 'visible') checkRevision(); };
    window.addEventListener('focus', checkRevision);
    document.addEventListener('visibilitychange', onVisibilityChange);
    const interval = window.setInterval(checkRevision, 30_000);
    return () => {
      unsubscribe();
      window.removeEventListener('focus', checkRevision);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      window.clearInterval(interval);
      if (refreshTimer !== undefined) window.clearTimeout(refreshTimer);
    };
  }, [refreshWorkspace, notify]);
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
function ProjectDialog({ editing, setEditing, save }: any) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const profileFields = ['name', 'companyName', 'industry', 'products', 'strengths', 'valueAndAudience', 'operatingYears', 'cases', 'credentials', 'serviceArea', 'website', 'contact', 'customerQuestions', 'allowedSources', 'forbiddenPhrases'];
  const completed = profileFields.filter((field) => String(editing[field] || '').trim()).length;
  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
    return () => { if (dialog?.open) dialog.close(); };
  }, []);
  const update = (field: string, value: string) => setEditing({ ...editing, [field]: value });
  return <dialog ref={dialogRef} id="project-dialog" className="project-sheet" aria-labelledby="project-dialog-title" onCancel={(event) => { event.preventDefault(); setEditing(null); }}>
    <form className="project-sheet-form" onSubmit={(event) => { event.preventDefault(); void save(); }}>
      <header className="project-sheet-head">
        <div className="project-sheet-identity"><span className="project-sheet-avatar"><Building2 size={20} /></span><div><p className="eyebrow">{editing.id ? '客户项目资料' : '创建客户项目'}</p><h2 id="project-dialog-title">{editing.id ? (editing.name || '编辑客户项目') : '建立客户资料'}</h2><p>{editing.id ? '资料会用于选题、文章生成和平台分发。' : '先填写必要信息，其余资料可以以后继续完善。'}</p></div></div>
        <div className="project-sheet-actions"><Badge tone={completed >= 10 ? 'success' : 'neutral'}>已完善 {completed}/{profileFields.length}</Badge><Button type="button" variant="ghost" icon={X} onClick={() => setEditing(null)} aria-label="关闭客户资料" /></div>
      </header>
      <div className="project-sheet-body">
        <section className="project-form-section">
          <div className="project-section-head"><span><Building2 size={17} /></span><div><h3>基础信息</h3><p>用于识别当前客户，项目名称只在桌面端内部显示。</p></div></div>
          <FieldGroup>
            <Field label="项目名称" description="建议使用客户简称，方便快速切换。" htmlFor="project-input-name"><input id="project-input-name" autoFocus value={editing.name || ''} onChange={(event) => update('name', event.target.value)} placeholder="例如：沧州华晨压瓦机械" /></Field>
            <Field label="公司或品牌全称" htmlFor="project-company-name"><input id="project-company-name" value={editing.companyName || ''} onChange={(event) => update('companyName', event.target.value)} placeholder="文章中需要使用的正式名称" /></Field>
            <Field label="行业与核心业务" htmlFor="project-industry"><textarea id="project-industry" value={editing.industry || ''} onChange={(event) => update('industry', event.target.value)} placeholder="公司属于什么行业，主要解决什么问题" /></Field>
          </FieldGroup>
        </section>

        <section className="project-form-section">
          <div className="project-section-head"><span><BriefcaseBusiness size={17} /></span><div><h3>业务内容</h3><p>这些信息会直接影响选题是否具体、文章是否像这个行业的人写的。</p></div></div>
          <FieldGroup>
            <Field label="核心产品或服务" htmlFor="project-products"><textarea id="project-products" value={editing.products || ''} onChange={(event) => update('products', event.target.value)} placeholder="列出主要产品、服务或解决方案" /></Field>
            <Field label="核心优势" htmlFor="project-strengths"><textarea id="project-strengths" value={editing.strengths || ''} onChange={(event) => update('strengths', event.target.value)} placeholder="填写1-3个最有区分度、可以公开表达的优势" /></Field>
            <Field label="目标客户与客户价值" htmlFor="project-audience"><textarea id="project-audience" value={editing.valueAndAudience || ''} onChange={(event) => update('valueAndAudience', event.target.value)} placeholder="客户是谁，他们通常关心什么，公司能提供什么价值" /></Field>
          </FieldGroup>
        </section>

        <details className="project-form-more">
          <summary><span className="project-more-icon"><ShieldCheck size={17} /></span><span><strong>案例与信任资料</strong><small>经营年限、真实案例和资质认证</small></span><ChevronDown size={17} /></summary>
          <FieldGroup>
            <Field label="经营年限或成立时间" htmlFor="project-years"><input id="project-years" value={editing.operatingYears || ''} onChange={(event) => update('operatingYears', event.target.value)} placeholder="例如：成立于2012年" /></Field>
            <Field label="代表案例" htmlFor="project-cases"><textarea id="project-cases" value={editing.cases || ''} onChange={(event) => update('cases', event.target.value)} placeholder="只填写允许公开的真实客户、项目、动作和结果" /></Field>
            <Field label="资质与权威背书" htmlFor="project-credentials"><textarea id="project-credentials" value={editing.credentials || ''} onChange={(event) => update('credentials', event.target.value)} placeholder="认证、专利、奖项、许可证或行业标准" /></Field>
          </FieldGroup>
        </details>

        <details className="project-form-more">
          <summary><span className="project-more-icon"><ContactRound size={17} /></span><span><strong>服务范围与联系方式</strong><small>对外展示的信息，可暂时不填</small></span><ChevronDown size={17} /></summary>
          <FieldGroup>
            <Field label="服务地区或应用场景" htmlFor="project-service-area"><input id="project-service-area" value={editing.serviceArea || ''} onChange={(event) => update('serviceArea', event.target.value)} placeholder="例如：全国服务、海外市场、工业园区" /></Field>
            <Field label="官方网站" htmlFor="project-website"><input id="project-website" value={editing.website || ''} onChange={(event) => update('website', event.target.value)} placeholder="https://" /></Field>
            <Field label="公开联系方式或行动引导" htmlFor="project-contact"><input id="project-contact" value={editing.contact || ''} onChange={(event) => update('contact', event.target.value)} placeholder="仅填写允许出现在文章中的联系方式" /></Field>
          </FieldGroup>
        </details>

        <details className="project-form-more">
          <summary><span className="project-more-icon"><MessageSquareText size={17} /></span><span><strong>内容偏好与边界</strong><small>帮助 WorkBuddy 选题并避免不合适的表达</small></span><ChevronDown size={17} /></summary>
          <FieldGroup>
            <Field label="客户经常问的问题" htmlFor="project-questions"><textarea id="project-questions" value={editing.customerQuestions || ''} onChange={(event) => update('customerQuestions', event.target.value)} placeholder="销售沟通、搜索或咨询中经常出现的问题" /></Field>
            <Field label="允许引用的来源" htmlFor="project-sources"><textarea id="project-sources" value={editing.allowedSources || ''} onChange={(event) => update('allowedSources', event.target.value)} placeholder="官网、公众号、资料链接或指定行业来源" /></Field>
            <Field label="禁用词与敏感内容" htmlFor="project-forbidden"><textarea id="project-forbidden" value={editing.forbiddenPhrases || ''} onChange={(event) => update('forbiddenPhrases', event.target.value)} placeholder="不希望出现的承诺、竞品、敏感词或话题" /></Field>
          </FieldGroup>
        </details>
      </div>
      <footer className="project-sheet-foot"><p>{editing.id ? '保存后，WorkBuddy 下次生成内容时会使用最新资料。' : '创建后会自动切换到这个客户项目。'}</p><div><Button type="button" variant="outline" onClick={() => setEditing(null)}>取消</Button><Button id="project-save" type="submit" icon={editing.id ? CheckCircle2 : Plus}>{editing.id ? '保存修改' : '创建项目'}</Button></div></footer>
    </form>
  </dialog>;
}
createRoot(document.getElementById('root')!).render(<App/>);
