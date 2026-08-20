import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { AlertTriangle, ArrowLeft, BookOpen, Boxes, BriefcaseBusiness, Building2, CheckCircle2, ChevronDown, CircleAlert, Clock3, Copy, Download, Eye, FileText, FolderOpen, Globe2, ImagePlus, KeyRound, LayoutDashboard, Link2, ListChecks, LogIn, MessageSquareText, PackageOpen, Pencil, Plus, Power, RefreshCw, Rocket, Search, Send, Settings2, ShieldCheck, Sparkles, Tag, UserRound, UsersRound, X } from 'lucide-react';
import { Badge, Button, Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle, Empty, Field, FieldGroup, Progress, Spinner, Switch } from './components/ui.js';
import { friendlyProjectSaveError, projectProfileFields, validateProjectProfile, type ProjectProfileField, type ProjectProfileIssue } from '../shared/project-profile.js';

const platforms = [['baijia', '百家号'], ['toutiao', '头条号'], ['zhihu', '知乎'], ['penguin', '企鹅号'], ['sohu', '搜狐号'], ['netease', '网易号']] as const;
const platformLabels = Object.fromEntries(platforms) as Record<string, string>;
const contentStatusLabels: Record<string, string> = { draft: '草稿', ready: '待分发', published: '已发布', active: '已整理', pending_analysis: '待整理', approved: '待使用', used: '已使用', pending_review: '待确认', paused: '已暂停', reserved: '生成中', failed: '失败' };
const articleTypeLabels: Record<string, string> = { eeat: '专业权威型', question: '问题解答型', case: '案例型', pitfall: '避坑型', recommendation: '推荐选型', operation: '操作指南', seven_dimension: '七大维度', b2b_four_step: 'B2B 决策型' };
const materialCategoryLabels: Record<string, string> = { image: '图片', product: '产品', equipment: '设备', factory: '工厂', case: '案例', credential: '资质', team: '团队', brand: '品牌', other: '其他' };
type View = 'overview' | 'projects' | 'content' | 'distribution' | 'accounts' | 'guide' | 'settings';

function articlePublishPlatforms(articleId: string, distributions: any[], statuses = ['success', 'result_uncertain']): Set<string> {
  return new Set(distributions
    .filter((record) => record.payload?.articleId === articleId && record.payload?.mode === 'publish' && statuses.includes(record.status))
    .map((record) => record.platform));
}

function articleHasCompletedDistribution(article: any, distributions: any[]): boolean {
  if (article.status === 'published') return true;
  const records = distributions.filter((record) => record.payload?.articleId === article.id && record.payload?.mode === 'publish');
  const batches = new Map<string, any[]>();
  for (const record of records) {
    const taskId = String(record.payload?.taskId || record.id);
    batches.set(taskId, [...(batches.get(taskId) || []), record]);
  }
  return [...batches.values()].some((batch) => {
    const targets = Array.isArray(batch[0]?.payload?.targetPlatforms) ? batch[0].payload.targetPlatforms : batch.map((record) => record.platform);
    return targets.length > 0 && targets.every((platform: string) => batch.some((record) => record.platform === platform && record.status === 'success'));
  });
}

function App() {
  const [view, setView] = useState<View>('overview'); const [status, setStatus] = useState<any>({ platforms: [] }); const [projects, setProjects] = useState<any[]>([]); const [project, setProject] = useState<any>(null); const [items, setItems] = useState<any[]>([]); const [contentCounts, setContentCounts] = useState<Record<string, number>>({}); const [workBuddy, setWorkBuddy] = useState<any>({ prepared: false }); const [update, setUpdate] = useState<any>({ phase: 'idle' }); const [message, setMessage] = useState(''); const [error, setError] = useState(false); const [editing, setEditing] = useState<any>(null); const [selectingProject, setSelectingProject] = useState(false);
  const [contentTab, setContentTab] = useState<'overview' | 'material' | 'topic' | 'article'>('overview');
  const appliedRevision = useRef(-1);
  const pendingRevision = useRef(-1);
  const messageTimer = useRef<number | null>(null);
  const notify = useCallback((text: string, failed = false) => {
    if (messageTimer.current !== null) window.clearTimeout(messageTimer.current);
    setMessage(text);
    setError(failed);
    messageTimer.current = window.setTimeout(() => {
      setMessage('');
      messageTimer.current = null;
    }, failed ? 8_000 : 3_000);
  }, []);
  const applyWorkspaceSnapshot = useCallback((snapshot: Awaited<ReturnType<typeof window.geoPublisher.workspaceSnapshot>>) => {
    if (snapshot.revision < appliedRevision.current) return;
    appliedRevision.current = snapshot.revision;
    pendingRevision.current = Math.max(pendingRevision.current, snapshot.revision);
    setProjects(snapshot.projects);
    setProject(snapshot.currentProject);
    setItems(snapshot.items);
    setContentCounts(snapshot.contentCounts || {});
  }, []);
  const refreshWorkspace = useCallback(async () => applyWorkspaceSnapshot(await window.geoPublisher.workspaceSnapshot()), [applyWorkspaceSnapshot]);
  const refresh = useCallback(async () => {
    const [s, w, u, snapshot] = await Promise.all([window.geoPublisher.status(), window.geoPublisher.workBuddyStatus(), window.geoPublisher.updateStatus(), window.geoPublisher.workspaceSnapshot()]);
    setStatus(s); setWorkBuddy(w); setUpdate(u); applyWorkspaceSnapshot(snapshot);
  }, [applyWorkspaceSnapshot]);
  useEffect(() => { void refresh().catch((e) => notify(e.message, true)); }, [refresh, notify]);
  useEffect(() => () => { if (messageTimer.current !== null) window.clearTimeout(messageTimer.current); }, []);
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
  const busy = Boolean(status.busy); const articles = useMemo(() => items.filter((i) => i.kind === 'article'), [items]); const topics = useMemo(() => items.filter((i) => i.kind === 'topic'), [items]); const materials = useMemo(() => items.filter((i) => i.kind === 'material'), [items]); const distributions = useMemo(() => items.filter((i) => i.kind === 'distribution'), [items]);
  const openPlatform = async (id: string) => { if (busy) return notify(`正在执行${platformLabels[status.executingPlatform] || '平台'}任务，不能切换`, true); if (!project) return setEditing({ name: '', companyName: '', industry: '' }); try { await window.geoPublisher.openPlatform(id as any); setStatus(await window.geoPublisher.status()); notify(`${platformLabels[id]}已打开`); } catch (e) { notify((e as Error).message, true); } };
  const hidePlatform = async () => { try { setStatus(await window.geoPublisher.hidePlatform()); notify('已返回工作台，平台页面和登录状态已保留'); } catch (e) { notify((e as Error).message, true); } };
  const saveProject = async () => { try { if (editing.id) { const result = await window.geoPublisher.updateProject(editing.id, editing); setEditing(null); notify(`已保存客户资料：${result.project.name}`); } else { const result = await window.geoPublisher.createProject(editing); setEditing(null); notify(`已创建并切换到客户项目：${result.currentProject.name}`); } await refresh(); } catch (e) { notify(friendlyProjectSaveError(e), true); throw e; } };
  const switchProject = async (projectId: string) => { if (busy) return notify(`正在执行${platformLabels[status.executingPlatform] || '平台'}任务，不能切换客户项目`, true); if (projectId === project?.id) { setSelectingProject(false); return; } try { const result = await window.geoPublisher.selectProject(projectId); setSelectingProject(false); await refresh(); notify(`已切换到客户项目：${result.currentProject.name}`); } catch (e) { notify((e as Error).message, true); } };
  const connect = async () => { try { await window.geoPublisher.connectWorkBuddy(); setWorkBuddy({ prepared: true }); notify('连接指令已复制，请粘贴到 WorkBuddy'); } catch (e) { notify((e as Error).message, true); } };
  const openContent = (tab: 'overview' | 'material' | 'topic' | 'article' = 'overview') => { setContentTab(tab); setView('content'); };
  const nav = [['overview', '概览', LayoutDashboard], ['projects', '客户项目', UsersRound], ['content', '内容中心', FileText], ['distribution', '分发', Send], ['accounts', '平台账号', Globe2], ['guide', '使用指南', BookOpen], ['settings', '设置', Settings2]] as const;
  const title = nav.find(([id]) => id === view)?.[1];
  const pendingDistributionCount = articles.filter((article) => article.status === 'ready' && !articleHasCompletedDistribution(article, distributions)).length;
  return <div className="app-shell"><aside className="app-sidebar"><div className="app-brand"><img src="logo.png" alt="" /><div><strong>GEO Publisher</strong><small>内容与分发工作台</small></div></div><button id="project-switch" className="project-switcher" disabled={busy} onClick={() => setSelectingProject(true)} title={busy ? '任务执行中，暂时不能切换客户项目' : '切换客户项目'}><span className="project-avatar"><UserRound size={15} /></span><span><small>当前客户项目</small><strong>{project?.name || '尚未选择'}</strong></span><ChevronDown size={15} /></button><nav className="app-nav">{nav.map(([id, label, Icon]) => <button key={id} className={view === id ? 'nav-item active' : 'nav-item'} onClick={() => id === 'content' ? openContent() : setView(id)}><Icon size={17} /><span>{label}</span>{id === 'distribution' && pendingDistributionCount > 0 && <em>{pendingDistributionCount}</em>}</button>)}</nav><div className="sidebar-bottom"><button id="connect-workbuddy" className="nav-item" onClick={connect}><Link2 size={17} /><span>连接 WorkBuddy</span><Badge tone={workBuddy.prepared ? 'success' : 'warning'}><span id="workbuddy-state">{workBuddy.prepared ? '已连接' : '未连接'}</span></Badge></button><button id="check-update" className="nav-item" onClick={() => void window.geoPublisher.checkForUpdates().then(setUpdate)}><RefreshCw size={17} /><span>检查更新</span><small>{update.availableVersion ? `v${update.availableVersion}` : ''}</small></button></div></aside><main className="app-main"><header className={status.activePlatform ? 'app-header platform-toolbar' : 'app-header'}>{status.activePlatform ? <div className="platform-toolbar-title"><Button id="platform-back" variant="ghost" icon={ArrowLeft} disabled={busy} onClick={() => void hidePlatform()} title={busy ? '任务执行中，暂时不能返回工作台' : '返回工作台'}>返回工作台</Button><span className="platform-toolbar-divider"/><div><p>平台页面</p><h1>{platformLabels[status.activePlatform]}</h1></div>{busy && <Badge tone="warning">任务执行中</Badge>}</div> : <><div><p>GEO Publisher / {title}</p><h1>{title}</h1></div><div><Badge tone={busy ? 'warning' : status.attentionRequired ? 'danger' : 'success'}>{busy ? `${platformLabels[status.executingPlatform] || '平台'}执行中` : status.attentionRequired ? '需要人工处理' : '运行正常'}</Badge><small className="version-label">v{status.version || update.currentVersion}</small></div></>}</header><div className="content-area"><View view={view} project={project} projects={projects} status={status} items={items} articles={articles} topics={topics} materials={materials} distributions={distributions} contentCounts={contentCounts} busy={busy} setView={setView} openContent={openContent} contentTab={contentTab} openPlatform={openPlatform} edit={setEditing} switchProject={switchProject} refresh={refresh} workBuddy={workBuddy} setWorkBuddy={setWorkBuddy} update={update} setUpdate={setUpdate} connect={connect} notify={notify} /></div>{message && <footer id="action-message" className={error ? 'app-message error' : 'app-message'}>{error ? <AlertTriangle size={15} /> : <CheckCircle2 size={15} />}{message}</footer>}</main>{selectingProject && <ProjectSelector projects={projects} currentProject={project} busy={busy} close={() => setSelectingProject(false)} select={switchProject} edit={(target: any) => { setSelectingProject(false); setEditing(target); }} create={() => { setSelectingProject(false); setEditing({ name: '', companyName: '', industry: '' }); }} />}{editing && <ProjectDialog editing={editing} setEditing={setEditing} save={saveProject} />}<span id="connection" hidden>{message}</span><span id="version" hidden>{status.version}</span><button id="beta-access" hidden>B</button><button id="beta-disable" hidden>S</button><span id="update-state" hidden>{update.phase}</span></div>;
}
function View({ view, project, projects, status, items, articles, topics, materials, distributions, contentCounts, busy, setView, openContent, contentTab, openPlatform, edit, switchProject, refresh, workBuddy, setWorkBuddy, update, setUpdate, connect, notify }: any) {
  if (!project && view !== 'projects' && view !== 'guide' && view !== 'settings') return <Card className="welcome-card"><Sparkles size={28} /><p className="eyebrow">开始使用</p><h2>先创建一个客户项目</h2><p>公司资料、平台账号、素材和文章都会按客户项目独立保存。</p><Button icon={Plus} onClick={() => edit({ name: '', companyName: '', industry: '' })}>新建客户项目</Button></Card>;
  if (view === 'overview') return <><div className="hero-row"><div><p className="eyebrow">当前客户项目</p><h2 id="current-project-title">{project.name}</h2><p className="muted" id="current-project-company">{project.companyName || '未填写公司全称'} · {project.industry || '未填写行业'}</p></div><Button variant="outline" icon={Send} onClick={() => setView('distribution')}>进入分发</Button></div><div className="stat-grid"><Stat icon={FileText} label="文章" value={contentCounts.article ?? articles.length}/><Stat icon={ListChecks} label="选题" value={contentCounts.topic ?? topics.length}/><Stat icon={Boxes} label="素材" value={contentCounts.material ?? materials.length}/><Stat icon={Globe2} label="平台" value="6"/></div><Card><div className="card-head"><div><h3>平台账号</h3><p>每个客户项目分别保存平台登录状态。</p></div><Button variant="ghost" onClick={() => setView('accounts')}>查看全部</Button></div><div className="platform-grid">{platforms.map(([id,label]) => <button data-platform={id} key={id} onClick={() => openPlatform(id)} className="platform-tile"><span className="platform-dot"/><strong>{label}</strong><small>打开登录页</small></button>)}</div></Card></>;
  if (view === 'projects') return <Card><div className="card-head"><div><h3>客户项目</h3><p>每个项目都有独立的账号、资料和内容库。</p></div><Button icon={Plus} disabled={busy} onClick={() => edit({ name: '', companyName: '', industry: '' })}>新建项目</Button></div>{projects.length ? <div className="item-list">{projects.map((p:any) => <div className="item-row project-row" key={p.id}><span className="project-avatar"><UserRound size={15}/></span><span><strong>{p.name}</strong><small>{p.companyName || '未填写公司全称'}</small></span><div className="project-row-actions">{p.id === project?.id ? <Badge tone="success">当前项目</Badge> : <Button variant="outline" disabled={busy} onClick={() => void switchProject(p.id)}>切换</Button>}<Button variant="ghost" icon={Pencil} disabled={busy} onClick={() => edit(p)}>编辑</Button></div></div>)}</div> : <Empty icon={UsersRound} title="暂无客户项目" description="创建第一个客户项目后即可配置平台账号。"/>}</Card>;
  if (view === 'content') return <ContentCenter project={project} items={items} materials={materials} topics={topics} articles={articles} contentCounts={contentCounts} busy={busy} refresh={refresh} notify={notify} initialTab={contentTab}/>;
  if (view === 'distribution') return <DistributionView project={project} articles={articles} distributions={distributions} status={status} busy={busy} refresh={refresh} notify={notify}/>;
  if (view === 'accounts') return <Card><div className="card-head"><div><h3>平台账号</h3><p>请在对应平台页面完成登录；发布任务进行中暂时不能切换。</p></div><Badge tone={busy ? 'warning' : 'success'}>{busy ? '任务进行中' : '可以操作'}</Badge></div><div className="account-grid">{platforms.map(([id,label])=><section key={id}><span className="platform-dot"/><strong>{label}</strong><p>打开平台后可以查看登录状态</p><Button variant="outline" icon={LogIn} disabled={busy} onClick={() => openPlatform(id)}>打开平台</Button></section>)}</div></Card>;
  if (view === 'guide') return <GuideView project={project} workBuddy={workBuddy} setView={setView} openContent={openContent} connect={connect} notify={notify}/>;
  return <SettingsView status={status} workBuddy={workBuddy} setWorkBuddy={setWorkBuddy} update={update} setUpdate={setUpdate} connect={connect} notify={notify} />;
}

function GuideView({ project, workBuddy, setView, openContent, connect, notify }: any) {
  const features = [
    ['客户项目隔离', '每个客户都有独立的公司资料、平台登录状态、素材、选题、文章和分发记录。', UsersRound],
    ['内容中心', '图片素材、选题和文章分区管理。普通选题使用后保留，常青主题可以继续生成新的角度。', Boxes],
    ['平台适配分发', '六个平台使用各自的页面适配逻辑，支持只填充不发布，也支持逐个平台真实发布。', Send],
    ['过程可追踪', '每次任务都会显示当前平台、执行阶段和结果。结果不确定时先到管理页核对，不会立即重复点击。', ShieldCheck],
  ] as const;
  const faqs = [
    ['我只想发一个平台怎么办？', '在分发页面只勾选目标平台即可，不会强制操作其他平台。'],
    ['两个客户能同时发布吗？', '不建议同时运行。同一台电脑请错峰安排：单平台客户至少间隔 30 分钟，多平台客户至少间隔 90 分钟，避免平台页面和账号操作互相影响。'],
    ['为什么有时需要我处理？', '登录失效、验证码、平台风控、今日次数用完或页面变化需要人工确认。完成处理后回到桌面端重试即可。'],
    ['“仅填充”和“真实发布”有什么区别？', '仅填充只把内容写入平台页面，不点击发布；真实发布会继续点击发布，并在发布后查询管理页进行对账。'],
    ['切换客户会不会串账号？', '不会。切换项目会同时切换对应的平台登录状态和内容库；任务执行期间会锁定切换。'],
    ['关闭窗口后任务会怎样？', '桌面端可以驻留后台。正在执行任务时请不要强制退出；平台页面需要人工处理时，按提示打开对应平台即可。'],
  ] as const;
  const projectName = project?.name || '请填写客户项目名称';
  const projectId = project?.id || '当前项目 ID';
  const workBuddyPrompts = [
    {
      number: '1', title: '先登录各个平台', badge: '先完成', description: '进入“平台账号”，依次打开准备使用的平台并完成登录。遇到扫码、验证码或安全验证时，请先在平台页面处理完成。',
      action: 'accounts',
    },
    {
      number: '2', title: '配置公司资料', badge: '必须', description: '把已有的公司简介直接放在提示词最后。没有简介也可以，WorkBuddy 会用两轮以内的问题帮你补齐。',
      prompt: `请帮我配置 GEO Publisher 当前客户项目的公司资料。\n\n如果当前没有客户项目，请帮我新建一个；如果已经有项目，只更新当前项目，不要修改其他客户。请从我提供的简介中提取并适度润色公司名称、行业、产品或服务、核心优势、目标客户、案例、资质、服务地区、客户常问问题和禁用词。不要收集或写入官网、电话、邮箱、微信等联系方式。只追问最关键的缺失信息，最多两轮。整理完成后先给我看一份简洁摘要，必须等我明确回复“确认创建”或“确认写入”后再保存。不要编造公司事实。\n\n公司简介：\n【把公司简介粘贴到这里】`,
    },
    {
      number: '3', title: '上传并整理图片', badge: '有图片时', description: '先点击“前往上传图片”，在素材页面添加图片。上传完成后复制整理提示词，发给 WorkBuddy。每张图片只需整理一次。',
      prompt: '请整理 GEO Publisher 当前客户项目中所有待整理的图片素材。识别每张图片的主体、适用场景和可用方式，区分产品、设备、工厂、案例、资质、团队或品牌素材，并保存整理结果。不要重新识别已经整理过的图片。完成后告诉我整理了多少张、各有多少类。',
    },
    {
      number: '4', title: '生成选题和第一篇文章', badge: '内容准备', description: '把【平台名称】替换成百家号、头条号、知乎、企鹅号、搜狐号或网易号。',
      prompt: '请基于 GEO Publisher 当前客户项目的公司资料和已整理素材，生成未来 7 天的选题，每天 1 个，共 7 个。每条标题只保留一个核心问题，避免空泛、重复和同义改写，检查通过后保存到选题池。然后从第一个可用选题生成 1 篇适合【平台名称】的文章并保存到内容中心。先不要填充，也不要发布。完成后告诉我选题标题和文章标题。',
    },
    {
      number: '5', title: '先做一次填充检查', badge: '不会发布', description: '这一步只把文章写进平台页面，用来确认登录、正文格式、封面和声明是否正常。',
      prompt: '请读取 GEO Publisher 当前客户项目中最新一篇待分发文章，只填充到【平台名称】，不要点击发布。填充前先检查连接和登录状态；填充后核对标题、正文格式、封面和平台声明是否完成。任何步骤失败都要返回真实原因，不要继续发布。完成后提醒我打开平台页面人工检查。',
    },
    {
      number: '6', title: '完成一次真实发布', badge: '人工确认', description: '确认上一步页面内容正确后再使用。结果不明确时会先核对，不会连续点击发布。',
      prompt: '我已经人工检查过当前项目最新一篇文章的填充结果。请将这篇文章真实发布到【平台名称】。发布前重新校验当前客户项目、文章、登录状态和必填项；发布后查询管理页并核对标题与文章状态。遇到登录、验证码、风控或发文次数用完时立即停止并提醒我；如果结果不明确，先对账并通知我，禁止再次点击发布。',
    },
    {
      number: '7', title: '设置自动发布', badge: '最后开启', description: `先在 WorkBuddy 中新建自动化并设置运行时间，再把下面内容粘贴为任务说明。当前教程锁定客户项目“${projectName}”。`,
      prompt: `这是一个 GEO Publisher 自动发布任务，只允许操作客户项目【${projectName}】。每次运行时先检查桌面端连接，并在项目列表中查找名称完全一致且唯一的项目；如果不存在、重名或无法确认，立即停止并提醒我，禁止发布。\n\n每次运行按以下顺序执行：\n1. 检查六个平台登录状态和当天可用情况。\n2. 读取该项目的公司资料、已整理素材、历史选题和历史文章。\n3. 为【目标平台，例如：百家号、头条号、知乎】分别生成不重复的选题和文章；不同平台不要共用同一篇改写稿。\n4. 检查标题、正文结构、素材和平台要求，通过后保存文章。\n5. 按百家号、头条号、知乎、企鹅号、搜狐号、网易号的顺序，只处理我指定的平台，并且全程串行。\n6. 每个平台发布后查询管理页，核对标题和文章状态，再记录结果。\n\n安全规则：登录、验证码、风控、发文次数用完时停止对应平台并提醒我；某个平台失败不影响其他平台；同一文章不得重复发布；结果不明确时只提醒人工核对，禁止再次点击发布。任务结束后汇总每个平台的成功、失败和人工处理状态。`,
    },
  ];
  const copyPrompt = async (title: string, prompt: string) => {
    try { await window.geoPublisher.copyText(prompt); notify(`${title}提示词已复制`); }
    catch (error) { notify(`复制失败：${(error as Error).message}`, true); }
  };
  const multiCustomerPrompt = `请为客户项目“${projectName}”创建一条独立的 GEO Publisher 自动发布自动化任务。

固定客户项目：${projectName}
固定项目 ID：${projectId}
任务名称建议：${projectName}｜平台｜自动发布

创建前请先运行 geo-publisher project list，确认项目名称和项目 ID 完全匹配；然后运行 geo-publisher project select ${projectId}，再运行 project current 复核当前项目。每次任务触发时都必须重复这一步，不能使用其他任务缓存的客户项目。

这条任务只允许读取和修改上述项目的公司资料、图片素材、选题、文章和分发记录，只允许操作该项目对应的平台登录态。不要修改、读取或发布其他客户项目的内容和账号。

请根据我在 WorkBuddy 中设置的平台和时间运行自动发布：每个目标平台独立生成一篇文章，按平台串行执行；发布前先校验，发布后查询管理页并核对标题和状态。登录失效、验证码、风控、平台次数用完或项目上下文变化时，停止当前平台并说明原因。桌面端忙碌时不要抢占、等待或重复点击，直接报告 PUBLISHER_BUSY。结果不明确时只提醒人工核对，禁止再次点击发布。

我会为每个客户项目分别创建一条自动化任务，请不要把多个客户合并到同一条任务中。`;
  return <div className="guide-page">
    <section className="guide-hero"><div><p className="eyebrow">GEO Publisher 使用指南</p><h2>从客户资料到多平台分发，一步一步完成</h2><p>桌面端负责项目、素材和发布；WorkBuddy 负责理解需求、生成选题和文章。你只需要选择客户、检查内容，再决定是否发布。</p><div className="guide-hero-actions"><Button icon={UsersRound} onClick={() => setView('projects')}>管理客户项目</Button><Button variant="outline" icon={BookOpen} onClick={() => openContent('overview')}>查看内容中心</Button></div></div><div className="guide-status"><Badge tone={project ? 'success' : 'warning'}>{project ? '当前项目已就绪' : '请先创建项目'}</Badge><strong>{project?.name || '尚未选择客户项目'}</strong><small>{workBuddy.prepared ? 'WorkBuddy 连接指令已准备' : '还没有连接 WorkBuddy'}</small></div></section>
    <section className="guide-section"><div className="guide-section-heading"><p className="eyebrow">你可以用它做什么</p><h3>把重复的发布工作集中到一个地方</h3></div><div className="guide-feature-grid">{features.map(([title, description, Icon]) => <Card className="guide-feature" key={title}><Icon size={19}/><h4>{title}</h4><p>{description}</p></Card>)}</div></section>
    <section className="guide-section workbuddy-tutorial"><div className="guide-section-heading"><p className="eyebrow">首次使用</p><h3>搭配 WorkBuddy，从平台登录到自动发布</h3><p>第一次按顺序完成下面 7 步：先登录平台，再连接 WorkBuddy，之后配置资料、准备内容和发布。带【】的内容需要换成自己的平台或资料。</p></div><div className="workbuddy-connect-step"><span className="guide-step-icon"><Link2 size={17}/></span><div><strong>完成平台登录后连接 WorkBuddy</strong><p>{workBuddy.prepared ? '连接指令已经准备好；如果 WorkBuddy 无法读取当前项目，再重新连接一次。' : '请先完成第 1 步的平台登录，再点击按钮，将自动复制的连接指令粘贴到 WorkBuddy 并发送。'}</p></div><Button icon={Link2} onClick={() => void connect()}>{workBuddy.prepared ? '重新连接' : '连接 WorkBuddy'}</Button></div><div className="workbuddy-prompt-list">{workBuddyPrompts.map((item, index) => <article className={index === workBuddyPrompts.length - 1 ? 'workbuddy-prompt automation' : 'workbuddy-prompt'} key={item.number}><header><span className="guide-step-number">{item.number}</span><div><h4>{item.title}</h4><p>{item.description}</p></div><Badge tone={index === workBuddyPrompts.length - 1 ? 'warning' : item.badge === '不会发布' ? 'success' : 'neutral'}>{item.badge}</Badge>{item.action === 'accounts' && <Button variant="outline" icon={LogIn} onClick={() => setView('accounts')}>前往平台账号</Button>}{item.number === '3' && <Button variant="outline" icon={ImagePlus} onClick={() => openContent('material')}>前往上传图片</Button>}{item.prompt && <Button variant="outline" icon={Copy} onClick={() => void copyPrompt(item.title, item.prompt)}>{item.number === '3' ? '复制整理提示词' : '复制提示词'}</Button>}</header>{item.prompt && <details open={index === 1}><summary>查看提示词<span>+</span></summary><p>{item.prompt}</p></details>}</article>)}</div><div className="workbuddy-automation-note"><ShieldCheck size={18}/><div><strong>自动发布不要一开始就开启</strong><p>先完成平台登录、公司资料、一次仅填充和一次真实发布。确认账号与页面都正常后，再创建自动化任务。</p></div></div></section>
    <section id="multi-customer-guide" className="guide-section multi-customer-guide"><div className="guide-section-heading"><p className="eyebrow">多客户场景</p><h3>多客户发布管理</h3><p>一个客户对应一个客户项目和一条 WorkBuddy 自动化。每个项目独立保存资料、素材、选题、文章、分发记录和平台登录态，不同客户不要共用平台账号。</p></div><div className="multi-customer-rules"><Card className="multi-customer-rule"><CardHeader><BriefcaseBusiness size={18}/><CardTitle>先切换客户</CardTitle></CardHeader><CardContent><p>在左上角切换到目标客户项目，确认名称后，再登录该客户账号、准备内容或配置任务。</p></CardContent></Card><Card className="multi-customer-rule"><CardHeader><UsersRound size={18}/><CardTitle>为客户单独建任务</CardTitle></CardHeader><CardContent><p>参考上面的第 7 步，在 WorkBuddy 中为客户创建独立任务，名称建议使用“客户名｜平台｜自动发布”。</p></CardContent></Card><Card className="multi-customer-rule"><CardHeader><Clock3 size={18}/><CardTitle>错峰安排</CardTitle></CardHeader><CardContent><p>单平台客户至少错开 30 分钟，多平台客户至少错开 90 分钟，避免同一电脑同时操作多个客户账号。</p></CardContent></Card></div><Card className="multi-customer-prompt"><CardHeader><div><CardTitle>当前客户的任务配置提示词</CardTitle><CardDescription>{`复制后，在 WorkBuddy 中为“${projectName}”创建独立自动化。`}</CardDescription></div><Button variant="outline" icon={Copy} onClick={() => void copyPrompt('多客户任务配置', multiCustomerPrompt)}>复制任务提示词</Button></CardHeader><CardContent><pre>{multiCustomerPrompt}</pre></CardContent></Card></section>
    <section className="guide-section guide-two-column"><Card><CardHeader><div><CardTitle>状态怎么理解</CardTitle><CardDescription>看到这些提示时，按对应动作处理即可。</CardDescription></div><CircleAlert size={18}/></CardHeader><CardContent><div className="guide-status-list"><div><Badge tone="success">已填充</Badge><span>内容已经写入平台页面，还没有发布。</span></div><div><Badge tone="success">发布成功</Badge><span>已点击发布，并完成了管理页或文章状态核对。</span></div><div><Badge tone="warning">需要人工处理</Badge><span>需要你完成登录、验证码或风控操作。</span></div><div><Badge tone="warning">结果待确认</Badge><span>不要立即再次点击，先到平台管理页确认是否已经发布。</span></div><div><Badge tone="danger">次数用完</Badge><span>今天不能继续发布该平台，换其他平台或明天再试。</span></div></div></CardContent></Card><Card><CardHeader><div><CardTitle>使用时记住这几件事</CardTitle><CardDescription>这些规则可以避免重复文章和误发布。</CardDescription></div><ShieldCheck size={18}/></CardHeader><CardContent><ul className="guide-bullets"><li>发布任务执行中不要切换客户项目。</li><li>先用“仅填充”检查页面，再执行真实发布。</li><li>真实发布前确认文章标题、封面和目标平台。</li><li>结果不明确时先对账，不要连续点击发布。</li><li>不同客户请分别建立项目，不要共用登录账号。</li></ul></CardContent></Card></section>
    <section className="guide-section"><div className="guide-section-heading"><p className="eyebrow">常见问题</p><h3>遇到问题先看这里</h3></div><div className="guide-faqs">{faqs.map(([question, answer]) => <details key={question}><summary>{question}<span>+</span></summary><p>{answer}</p></details>)}</div></section>
  </div>;
}

const distributionStatusLabels: Record<string, string> = { running: '执行中', filled: '已填充', success: '发布成功', failed: '失败', action_required: '需人工处理', result_uncertain: '结果待确认' };
const distributionStatusTones: Record<string, 'neutral' | 'success' | 'warning' | 'danger'> = { running: 'warning', filled: 'success', success: 'success', failed: 'danger', action_required: 'warning', result_uncertain: 'warning' };
const coverRequiredPlatforms = new Set(['baijia', 'toutiao', 'netease']);

function DistributionView({ project, articles, distributions, status, busy, refresh, notify }: any) {
  const [draft, setDraft] = useState<any>(null);
  const eligibleArticles = articles.filter((article: any) => (article.status === 'ready' || article.status === 'published') && article.payload?.document && article.payload?.quality?.passed !== false);
  const readyArticles = eligibleArticles.filter((article: any) => !articleHasCompletedDistribution(article, distributions));
  const completedArticles = eligibleArticles.filter((article: any) => articleHasCompletedDistribution(article, distributions));
  const history = [...distributions].sort((left: any, right: any) => String(right.updatedAt).localeCompare(String(left.updatedAt))).slice(0, 12);
  const openDraft = (article: any) => {
    const finalizedPlatforms = articlePublishPlatforms(article.id, distributions);
    const availablePlatforms = platforms.map(([id]) => id).filter((id) => !finalizedPlatforms.has(id));
    const preferredPlatform = availablePlatforms.includes(article.platform) ? article.platform : availablePlatforms[0];
    setDraft({
      article,
      platforms: preferredPlatform ? [preferredPlatform] : [],
      finalizedPlatforms: [...finalizedPlatforms],
      mode: 'fill',
      coverPath: String(article.payload?.coverPath || ''),
      confirmPublish: false,
      running: false,
      records: [],
    });
  };
  const run = async () => {
    if (!draft || draft.running) return;
    const request = {
      projectId: project.id,
      articleId: draft.article.id,
      platforms: [...draft.platforms],
      mode: draft.mode,
      coverPath: draft.coverPath,
      confirmPublish: draft.confirmPublish,
    };
    setDraft(null);
    try {
      const result = await window.geoPublisher.runDistribution(request);
      const failed = result.records.filter((record: any) => record.status === 'failed');
      const attention = result.records.filter((record: any) => record.status === 'action_required' || record.status === 'result_uncertain');
      if (failed.length > 0) notify(`${failed.length} 个平台执行失败，请查看分发记录中的具体原因`, true);
      else if (attention.length > 0) notify(`${attention.length} 个平台需要人工核对，暂未重复操作`, true);
      else notify(request.mode === 'publish' ? '分发任务已完成，请核对每个平台结果' : '文章填充已完成，请检查平台草稿');
      await refresh();
    } catch (error) {
      notify((error as Error).message, true);
      await refresh();
    }
  };
  return <div className="distribution-layout">
    <Card><div className="card-head"><div><h3>待首次发布</h3><p>本次选择的平台全部成功后，文章会进入下方已完成区域。</p></div><Badge tone={busy ? 'warning' : 'neutral'}>{busy ? '任务执行中' : `${readyArticles.length} 篇`}</Badge></div>{readyArticles.length ? <div className="item-list">{readyArticles.map((article: any) => <div className="item-row distribution-article-row" key={article.id}><FileText size={16}/><span><strong>{article.title || '未命名文章'}</strong><small>尚未发布 · {article.payload?.document?.blocks?.length || 0} 段内容</small></span><Button variant="outline" disabled={busy} icon={Send} onClick={() => openDraft(article)}>配置分发</Button></div>)}</div> : <Empty icon={Send} title="没有待首次发布的文章" description="发布成功的文章会移入下方，仍可继续分发到其他平台。"/>}
      {completedArticles.length > 0 && <section className="completed-distributions"><div className="section-head"><div><strong>已完成</strong><p>客户本次只发布一个平台也算完成，之后仍可继续分发。</p></div><Badge tone="success">{completedArticles.length} 篇</Badge></div><div className="item-list">{completedArticles.map((article: any) => { const published = articlePublishPlatforms(article.id, distributions, ['success']); const unavailable = articlePublishPlatforms(article.id, distributions); return <div className="item-row distribution-article-row" key={article.id}><CheckCircle2 size={16}/><span><strong>{article.title || '未命名文章'}</strong><small>已发布至 {[...published].map((id) => platformLabels[id] || id).join('、')} · 还有 {Math.max(0, platforms.length - unavailable.size)} 个平台可选</small></span><Button variant="outline" disabled={busy || unavailable.size >= platforms.length} icon={Send} onClick={() => openDraft(article)}>{unavailable.size >= platforms.length ? '全部完成' : '继续分发'}</Button></div>; })}</div></section>}
    </Card>
    <Card><div className="card-head"><div><h3>最近分发记录</h3><p>每个平台独立留存结果，失败不会覆盖其他平台。</p></div>{history.length > 0 && <Badge>{history.length} 条</Badge>}</div>{busy ? <div className="running"><Spinner/><strong>{platformLabels[status.executingPlatform] || '平台'}正在执行</strong><p>任务会按选择顺序逐个平台处理。</p></div> : history.length ? <div className="distribution-history">{history.map((record: any) => <div className="distribution-history-row" key={record.id}><span className="distribution-history-icon">{record.status === 'failed' ? <CircleAlert size={15}/> : record.status === 'running' ? <Clock3 size={15}/> : <CheckCircle2 size={15}/>}</span><div><strong>{platformLabels[record.platform] || record.platform} · {record.title}</strong><p>{record.payload?.mode === 'publish' ? '真实发布' : '仅填充'} · {new Date(record.updatedAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</p>{record.payload?.error?.message && <small>{record.payload.error.message}</small>}</div><Badge tone={distributionStatusTones[record.status] || 'neutral'}>{distributionStatusLabels[record.status] || record.status}</Badge></div>)}</div> : <Empty icon={Clock3} title="还没有分发记录" description="完成一次填充或发布后，这里会显示各平台结果。"/>}</Card>
    {draft && <DistributionDialog draft={draft} setDraft={setDraft} busy={busy} status={status} run={run} onClose={() => !draft.running && setDraft(null)}/>}
  </div>;
}

function DistributionDialog({ draft, setDraft, busy, status, run, onClose }: any) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const finalizedPlatforms = new Set<string>(draft.finalizedPlatforms || []);
  const requiresCover = draft.platforms.some((platform: string) => coverRequiredPlatforms.has(platform));
  const titleTooLong = draft.platforms.includes('toutiao') && [...String(draft.article.payload?.document?.title || draft.article.title)].length > 30;
  const canRun = draft.platforms.length > 0 && (!requiresCover || draft.coverPath) && !titleTooLong && (draft.mode !== 'publish' || draft.confirmPublish) && !draft.running && !busy;
  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
    return () => { if (dialog?.open) dialog.close(); };
  }, []);
  const togglePlatform = (platform: string) => {
    if (finalizedPlatforms.has(platform)) return;
    const selected = new Set(draft.platforms);
    if (selected.has(platform)) selected.delete(platform); else selected.add(platform);
    setDraft({ ...draft, platforms: platforms.map(([id]) => id).filter((id) => selected.has(id)) });
  };
  const chooseCover = async () => {
    const result = await window.geoPublisher.chooseDistributionCover();
    if (!result.canceled) setDraft({ ...draft, coverPath: result.filePath });
  };
  return <dialog ref={dialogRef} className="distribution-dialog" aria-labelledby="distribution-dialog-title" onCancel={(event) => { event.preventDefault(); onClose(); }}>
    <div className="distribution-dialog-layout">
      <header className="distribution-dialog-head"><div><p className="eyebrow">配置分发</p><h2 id="distribution-dialog-title">{draft.article.title}</h2><p>平台将按下方顺序串行执行，单个平台失败不会重复点击发布。</p></div><Button type="button" variant="ghost" icon={X} disabled={draft.running} onClick={onClose} aria-label="关闭分发配置"/></header>
      <div className="distribution-dialog-body">
        <section className="distribution-section"><div><strong>选择平台</strong><p>本次选中的平台就是本次分发目标；已发布或结果待确认的平台不可重复选择。</p></div><div className="distribution-platforms">{platforms.map(([id, label]) => { const finalized = finalizedPlatforms.has(id); return <label key={id} className={finalized ? 'finalized' : draft.platforms.includes(id) ? 'selected' : ''}><input type="checkbox" checked={draft.platforms.includes(id)} disabled={draft.running || finalized} onChange={() => togglePlatform(id)}/><span className="platform-dot"/><strong>{label}</strong>{finalized && <small>已处理</small>}</label>; })}</div></section>
        <section className="distribution-section"><div><strong>执行方式</strong><p>建议先填充检查；真实发布会点击平台发布按钮。</p></div><div className="distribution-modes"><label className={draft.mode === 'fill' ? 'selected' : ''}><input type="radio" name="distribution-mode" value="fill" checked={draft.mode === 'fill'} disabled={draft.running} onChange={() => setDraft({ ...draft, mode: 'fill', confirmPublish: false })}/><span><strong>仅填充</strong><small>写入标题、正文、封面和声明，不点击发布</small></span></label><label className={draft.mode === 'publish' ? 'selected' : ''}><input type="radio" name="distribution-mode" value="publish" checked={draft.mode === 'publish'} disabled={draft.running} onChange={() => setDraft({ ...draft, mode: 'publish' })}/><span><strong>真实发布</strong><small>填充完成后点击发布，并核对结果</small></span></label></div></section>
        <section className="distribution-section"><div><strong>文章封面</strong><p>{requiresCover ? '所选平台中包含必须上传封面的平台。' : '当前所选平台不强制要求封面。'}</p></div><div className="distribution-cover"><Button type="button" variant="outline" icon={ImagePlus} disabled={draft.running} onClick={() => void chooseCover()}>{draft.coverPath ? '更换封面' : '选择封面'}</Button><span>{draft.coverPath ? String(draft.coverPath).split(/[\\/]/).pop() : '尚未选择'}</span></div>{requiresCover && !draft.coverPath && <p className="distribution-error"><CircleAlert size={15}/>百家号、头条号和网易号必须选择封面。</p>}{titleTooLong && <p className="distribution-error"><CircleAlert size={15}/>当前标题超过头条号 30 字限制，请先修改文章标题。</p>}</section>
        {draft.mode === 'publish' && <label className="publish-confirm"><input type="checkbox" checked={draft.confirmPublish} disabled={draft.running} onChange={(event) => setDraft({ ...draft, confirmPublish: event.target.checked })}/><span><strong>我确认执行真实发布</strong><small>发布成功或结果待确认后，系统会阻止同一内容再次发布到该平台。</small></span></label>}
        {draft.running && <div className="distribution-progress"><Spinner/><div><strong>{platformLabels[status.executingPlatform] || '平台'}正在处理</strong><p>请不要切换客户项目或关闭应用。</p></div></div>}
        {draft.records.length > 0 && <div className="distribution-results">{draft.records.map((record: any) => <div key={record.id}><span>{platformLabels[record.platform] || record.platform}</span><Badge tone={distributionStatusTones[record.status] || 'neutral'}>{distributionStatusLabels[record.status] || record.status}</Badge>{record.payload?.error?.message && <p>{record.payload.error.message}</p>}</div>)}</div>}
      </div>
      <footer className="distribution-dialog-foot"><p>{draft.mode === 'publish' ? '真实发布不会自动重试结果不明确的任务。' : '填充完成后可在平台页面人工检查。'}</p><div><Button type="button" variant="outline" disabled={draft.running} onClick={onClose}>取消</Button><Button id="distribution-run" type="button" icon={draft.mode === 'publish' ? Rocket : Send} disabled={!canRun} onClick={() => { dialogRef.current?.close(); void run(); }}>{draft.running ? '执行中' : draft.mode === 'publish' ? '确认发布' : '开始填充'}</Button></div></footer>
    </div>
  </dialog>;
}

function ContentCenter({ project, items, materials, topics, articles, contentCounts = {}, busy, refresh, notify, initialTab = 'overview' }: any) {
  const [tab, setTab] = useState<'overview' | 'material' | 'topic' | 'article'>(initialTab);
  const [query, setQuery] = useState(''); const [status, setStatus] = useState('all'); const [category, setCategory] = useState('all');
  const [previewArticle, setPreviewArticle] = useState<any>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [extraItems, setExtraItems] = useState<any[]>([]);
  useEffect(() => setExtraItems([]), [project?.id, tab]);
  const visibleItems = useMemo(() => [...items, ...extraItems].filter((item, index, all) => all.findIndex((candidate) => candidate.id === item.id) === index), [items, extraItems]);
  const filtered = useMemo(() => visibleItems.filter((item: any) => {
    if (item.kind === 'distribution') return false;
    if (tab !== 'overview' && item.kind !== tab) return false;
    if (status !== 'all' && item.status !== status) return false;
    if (category !== 'all' && item.category !== category) return false;
    if (query && !`${item.title} ${JSON.stringify(item.payload)}`.toLowerCase().includes(query.toLowerCase())) return false;
    return true;
  }), [visibleItems, tab, status, category, query]);
  const counts = { material: Number(contentCounts.material ?? materials.length), topic: Number(contentCounts.topic ?? topics.length), article: Number(contentCounts.article ?? articles.length) };
  const pendingImageMaterials = materials.filter((item: any) => item.payload?.mediaType === 'image' && item.payload?.analysisStatus !== 'analyzed');
  const categories = [...new Set(filtered.map((item: any) => item.category).filter(Boolean))];
  const tabKind = tab === 'overview' ? null : tab;
  const loadedCount = tabKind ? visibleItems.filter((item: any) => item.kind === tabKind).length : visibleItems.filter((item: any) => item.kind !== 'distribution').length;
  const totalCount = tabKind ? Number(contentCounts[tabKind] || loadedCount) : Number(contentCounts.article || 0) + Number(contentCounts.topic || 0) + Number(contentCounts.material || 0);
  const loadMore = async () => {
    if (!project || !tabKind || loadedCount >= totalCount || loadingMore) return;
    const current = visibleItems.filter((item: any) => item.kind === tabKind).sort((a: any, b: any) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    const last = current.at(-1);
    setLoadingMore(true);
    try {
      const result = await window.geoPublisher.contentList(project.id, tabKind, { limit: 30, ...(last ? { beforeUpdatedAt: last.updatedAt, beforeId: last.id } : {}) });
      setExtraItems((previous) => [...previous, ...result.items]);
    } catch (error) { notify((error as Error).message, true); } finally { setLoadingMore(false); }
  };
  const importMaterial = () => { if (!project) return; void window.geoPublisher.contentChooseMaterial(project.id).then((result) => { if (!result.canceled) { notify(`已添加 ${result.items.length} 份素材，等待分类确认`); return refresh(); } }).catch((error) => notify(error.message, true)); };
  const organizeMaterials = () => { void window.geoPublisher.organizeMaterialsWithWorkBuddy().then(() => notify('整理指令已复制，请在 WorkBuddy 中粘贴执行')).catch((error) => notify(error.message, true)); };
  const updateTopic = async (topic: any, changes: any, message: string) => { try { await window.geoPublisher.contentSave(project.id, { id: topic.id, kind: 'topic', ...changes }); notify(message); await refresh(); } catch (error) { notify((error as Error).message, true); } };
  const renderItem = (item: any) => {
    const payload = item.payload || {}; const typeLabel = item.kind === 'topic' ? (articleTypeLabels[payload.articleType] || '待确定类型') : item.kind === 'article' ? (articleTypeLabels[payload.articleType] || '文章') : (materialCategoryLabels[item.category] || '待确认');
    const openPreview = () => { if (item.kind === 'article') setPreviewArticle(item); };
    return <div className={item.kind === 'article' ? 'content-item article-preview-trigger' : 'content-item'} key={item.id} role={item.kind === 'article' ? 'button' : undefined} tabIndex={item.kind === 'article' ? 0 : undefined} onClick={openPreview} onKeyDown={(event) => { if (item.kind === 'article' && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); openPreview(); } }}><div className="content-item-icon">{item.kind === 'material' ? <Tag size={17}/> : <FileText size={17}/>}</div><div className="content-item-main"><strong>{item.title || '未命名内容'}</strong><div className="content-item-meta"><Badge tone={item.status === 'used' ? 'neutral' : item.status === 'approved' || item.status === 'ready' ? 'success' : item.status === 'paused' ? 'warning' : 'neutral'}>{contentStatusLabels[item.status] || '处理中'}</Badge><span>{typeLabel}</span>{item.kind === 'topic' && <span>使用 {item.usageCount || 0} 次</span>}{item.platform && <span>{platformLabels[item.platform] || '目标平台'}</span>}</div>{item.kind === 'material' && payload.summary && <p>{payload.summary}</p>}{item.kind === 'topic' && payload.scenario && <p>{payload.scenario}</p>}{item.kind === 'article' && payload.topicId && <p>来源选题：{topics.find((topic: any) => topic.id === payload.topicId)?.title || '已归档选题'}</p>}</div>{item.kind === 'article' && <div className="content-item-actions"><Button variant="outline" icon={Eye} onClick={(event) => { event.stopPropagation(); setPreviewArticle(item); }}>预览</Button></div>}{item.kind === 'topic' && <div className="content-item-actions"><Button variant="ghost" disabled={busy} onClick={() => void updateTopic(item, { reusePolicy: 'evergreen' }, '已设为常青主题，后续将生成新的角度变体')}>{item.reusePolicy === 'evergreen' ? '常青主题' : '继续做这个主题'}</Button><Button variant="ghost" disabled={busy} onClick={() => void updateTopic(item, { status: 'paused' }, '选题已暂停')}>暂停</Button></div>}</div>;
  };
  const renderMaterial = (item: any) => { const payload = item.payload || {}; const pending = payload.mediaType === 'image' && payload.analysisStatus !== 'analyzed'; return <article className="material-card" key={item.id}><MaterialThumbnail projectId={project.id} item={item}/><div className="material-card-body"><div className="material-card-title"><strong>{item.title || '未命名图片'}</strong><Badge tone={pending ? 'warning' : 'success'}>{pending ? '待整理' : '已整理'}</Badge></div><p>{payload.description || payload.summary || '等待整理图片信息'}</p><div className="content-item-meta"><span>{materialCategoryLabels[item.category] || '图片'}</span>{Array.isArray(payload.uses) && payload.uses.map((use: string) => <span key={use}>{use === 'cover' ? '可做封面' : use === 'body' ? '正文配图' : use === 'brand' ? '品牌展示' : '证明素材'}</span>)}</div></div></article>; };
  return <div className="content-center">
    <div className="content-center-head"><div><p className="eyebrow">当前客户 · {project?.name}</p><h2>内容中心</h2><p className="muted">素材、选题和文章分开管理，WorkBuddy 会从这里读取和保存内容。</p></div><div className="content-head-actions">{tab === 'material' && <><Button variant="outline" icon={Sparkles} disabled={pendingImageMaterials.length === 0} onClick={organizeMaterials}>让 WorkBuddy 整理{pendingImageMaterials.length > 0 ? ` (${pendingImageMaterials.length})` : ''}</Button><Button icon={Plus} onClick={importMaterial}>添加图片</Button></>}<Button variant="outline" icon={RefreshCw} onClick={() => void refresh()}>刷新</Button></div></div>
    <div className="content-tabs">{[['overview', '总览'], ['material', `素材 ${counts.material}`], ['topic', `选题 ${counts.topic}`], ['article', `文章 ${counts.article}`]].map(([id, label]) => <button key={id} className={tab === id ? 'active' : ''} onClick={() => { setTab(id as any); setStatus('all'); setCategory('all'); }}>{label}</button>)}</div>
    <div className="content-toolbar"><div className="content-search"><Search size={16}/><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索标题、场景或素材描述" /></div><select aria-label="按状态筛选" value={status} onChange={(event) => setStatus(event.target.value)}><option value="all">全部状态</option><option value="pending_analysis">待整理</option><option value="active">已整理</option><option value="approved">待使用</option><option value="used">已使用</option><option value="ready">待分发</option><option value="pending_review">待确认</option><option value="paused">已暂停</option></select>{categories.length > 0 && <select aria-label="按分类筛选" value={category} onChange={(event) => setCategory(event.target.value)}><option value="all">全部分类</option>{categories.map((value) => <option key={value} value={value}>{materialCategoryLabels[String(value)] || '其他'}</option>)}</select>}</div>
    {tab === 'overview' && <div className="content-overview-grid"><div><strong>{topics.filter((item: any) => item.status === 'approved').length}</strong><span>待使用选题</span></div><div><strong>{topics.filter((item: any) => item.reusePolicy === 'evergreen').length}</strong><span>常青主题</span></div><div><strong>{pendingImageMaterials.length}</strong><span>待整理图片</span></div><div><strong>{articles.filter((item: any) => item.status === 'ready').length}</strong><span>待分发文章</span></div></div>}
    {filtered.length
      ? <div className={tab === 'material' ? 'material-grid' : 'content-items'}>{filtered.map(tab === 'material' ? renderMaterial : renderItem)}</div>
      : <Empty
          icon={PackageOpen}
          title={tab === 'material' ? '还没有图片素材' : tab === 'topic' ? '还没有选题' : tab === 'article' ? '还没有文章' : '内容库为空'}
          description={tab === 'material' ? '批量添加产品、设备、工厂、案例或资质图片，WorkBuddy 只需识别一次。' : '让 WorkBuddy 在当前客户项目中生成内容，保存后会自动出现在这里。'}
        />}
    {tabKind && loadedCount < totalCount && <div className="content-load-more"><Button variant="outline" disabled={loadingMore} onClick={() => void loadMore()}>{loadingMore ? '正在加载…' : `加载更多（还剩 ${totalCount - loadedCount} 条）`}</Button></div>}
    {previewArticle && <ArticlePreview article={previewArticle} topicTitle={topics.find((topic: any) => topic.id === previewArticle.payload?.topicId)?.title} onClose={() => setPreviewArticle(null)} />}
  </div>;
}

function MaterialThumbnail({ projectId, item }: { projectId: string; item: any }) {
  const [thumbnail, setThumbnail] = useState<{ dataUrl: string; width: number; height: number } | null>(null);
  useEffect(() => {
    let active = true;
    if (item.payload?.mediaType === 'image') void window.geoPublisher.materialThumbnail(projectId, item.id).then((value) => { if (active) setThumbnail(value); }).catch(() => undefined);
    return () => { active = false; };
  }, [projectId, item.id, item.payload?.mediaType]);
  return <div className="material-thumbnail">{thumbnail ? <img src={thumbnail.dataUrl} alt=""/> : <ImagePlus size={24}/>} {thumbnail && thumbnail.width > 0 && <span>{thumbnail.width} × {thumbnail.height}</span>}</div>;
}

function ArticlePreview({ article, topicTitle, onClose }: { article: any; topicTitle?: string; onClose: () => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const payload = article.payload || {};
  const document = payload.document || {};
  const blocks = Array.isArray(document.blocks) ? document.blocks : [];
  const statusLabel = contentStatusLabels[article.status] || '草稿';
  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
    return () => { if (dialog?.open) dialog.close(); };
  }, []);
  const renderBlock = (block: any, index: number) => {
    if (block?.type === 'heading') return block.level === 3 ? <h3 key={index}>{block.text}</h3> : <h2 key={index}>{block.text}</h2>;
    if (block?.type === 'paragraph') return <p key={index}>{block.text}</p>;
    if (block?.type === 'quote') return <blockquote key={index}>{block.text}</blockquote>;
    if (block?.type === 'divider') return <hr key={index}/>;
    if (block?.type === 'list' && Array.isArray(block.items)) {
      const items = block.items.map((item: string, itemIndex: number) => <li key={itemIndex}>{item}</li>);
      return block.ordered ? <ol key={index}>{items}</ol> : <ul key={index}>{items}</ul>;
    }
    if (block?.type === 'image' && block.src) return <figure key={index}><img src={block.src} alt={block.alt || ''} loading="lazy" referrerPolicy="no-referrer"/>{block.alt && <figcaption>{block.alt}</figcaption>}</figure>;
    return null;
  };
  return <dialog ref={dialogRef} className="article-preview-sheet" aria-labelledby="article-preview-title" onCancel={(event) => { event.preventDefault(); onClose(); }}>
    <div className="article-preview-layout">
      <header className="article-preview-head"><div><p className="eyebrow">文章预览</p><h2 id="article-preview-title">{document.title || article.title || '未命名文章'}</h2><div className="article-preview-meta"><Badge tone={article.status === 'ready' ? 'success' : 'neutral'}>{statusLabel}</Badge>{payload.articleType && <span>{articleTypeLabels[payload.articleType] || '文章'}</span>}{article.platform && <span>{platformLabels[article.platform] || '目标平台'}</span>}</div></div><Button type="button" variant="ghost" icon={X} onClick={onClose} aria-label="关闭文章预览" /></header>
      <div className="article-preview-scroll">{topicTitle && <p className="article-preview-source">来源选题：{topicTitle}</p>}{document.summary && <div className="article-preview-summary"><strong>文章摘要</strong><p>{document.summary}</p></div>}<article className="article-preview-body">{blocks.length ? blocks.map(renderBlock) : <Empty icon={FileText} title="正文尚未保存" description="当前文章只有标题，等待 WorkBuddy 保存完整正文。"/>}</article>{Array.isArray(document.tags) && document.tags.length > 0 && <footer className="article-preview-tags">{document.tags.map((tag: string) => <Badge key={tag}>{tag}</Badge>)}</footer>}</div>
    </div>
  </dialog>;
}

function friendlyUpdateStatus(update: any): { title: string; description: string; failed?: boolean } {
  if (update.phase === 'disabled') return { title: '自动更新暂不可用', description: '当前安装方式暂不支持自动更新，安装正式版本后即可使用。' };
  if (update.phase === 'checking') return { title: '正在检查更新', description: '请稍候，检查完成后会自动显示结果。' };
  if (update.phase === 'current') return { title: '当前已是最新版本', description: '后续发现新版本时会自动下载。' };
  if (update.phase === 'available' || update.phase === 'downloading') return { title: `正在下载 v${update.availableVersion || '新版本'}`, description: '可以继续使用应用，下载不会打断当前工作。' };
  if (update.phase === 'downloaded') return { title: `v${update.availableVersion || '新版本'} 已准备好`, description: update.canRestart ? '空闲时点击“重启并安装”即可完成更新。' : '当前任务完成后即可重启安装。' };
  if (update.phase === 'error') return { title: '暂时无法检查更新', description: '请检查网络后稍后再试。', failed: true };
  return { title: '自动更新已开启', description: '发现新版本后会自动下载，任务执行期间不会重启。' };
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
      const friendly = friendlyUpdateStatus(next);
      notify(friendly.title, friendly.failed);
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
    if (!betaCode.trim()) return notify('请输入灰度测试邀请码', true);
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
      notify('排障信息已复制');
    } catch (error) {
      notify((error as Error).message, true);
    }
  };
  const openDataDirectory = async () => {
    const result = await window.geoPublisher.openDataDirectory();
    notify(result.opened ? '已打开本地数据目录' : `无法打开数据目录：${result.error || '未知错误'}`, !result.opened);
  };
  const updateCopy = friendlyUpdateStatus(update);

  return <div className="settings-grid">
    <div className="settings-column">
      <Card className="settings-card">
        <CardHeader><div><CardTitle>连接 WorkBuddy</CardTitle><CardDescription>连接后，WorkBuddy 可以使用当前客户资料、内容和发布功能。</CardDescription></div><Badge tone={workBuddy.prepared ? 'success' : 'warning'}>{workBuddy.prepared ? '已连接' : '未连接'}</Badge></CardHeader>
        <CardContent><div className="setting-row"><div><strong>{workBuddy.prepared ? '连接已准备好' : '尚未完成连接'}</strong><p>{workBuddy.prepared ? '如果 WorkBuddy 无法读取当前项目，可以点击下方按钮重新连接。' : '点击下方按钮，然后把复制的连接指令粘贴到 WorkBuddy。'}</p></div></div></CardContent>
        <CardFooter><Button id="settings-connect-workbuddy" icon={Link2} onClick={() => void connect()}>{workBuddy.prepared ? '重新连接' : '立即连接'}</Button></CardFooter>
      </Card>

    </div>

    <div className="settings-column">
      <Card className="settings-card">
        <CardHeader><div><CardTitle>应用更新</CardTitle><CardDescription>当前版本 v{update.currentVersion || status.version}，正在使用{update.channel === 'beta' ? '灰度测试版' : '正式版'}。</CardDescription></div><Badge tone={update.channel === 'beta' ? 'warning' : 'success'}>{update.channel === 'beta' ? '灰度版' : '正式版'}</Badge></CardHeader>
        <CardContent>
          <div className="setting-row"><div><strong>{updateCopy.title}</strong><p>{updateCopy.description}</p></div>{update.progress != null && <span className="setting-value">{update.progress}%</span>}</div>
          {update.progress != null && <Progress value={update.progress} />}
          {update.channel === 'beta' ? <div className="beta-panel"><div><strong>正在参与灰度测试</strong><p>退出后会重新检查正式版更新，不会立即降低当前版本。</p></div><Button variant="outline" disabled={working === 'beta'} onClick={() => void deactivateBeta()}>退出灰度测试</Button></div> : <Field label="灰度测试邀请码" description="只有收到邀请并参与新功能测试时才需要填写。" htmlFor="beta-invite-code"><div className="input-action"><KeyRound size={16}/><input id="beta-invite-code" value={betaCode} onChange={(event) => setBetaCode(event.target.value)} placeholder="请输入邀请码" autoComplete="off"/><Button variant="outline" disabled={working === 'beta'} onClick={() => void activateBeta()}>加入测试</Button></div></Field>}
        </CardContent>
        <CardFooter><Button variant="outline" icon={RefreshCw} disabled={working === 'update'} onClick={() => void checkUpdate()}>检查更新</Button>{update.canRestart && <Button icon={Download} disabled={status.busy} onClick={() => void installUpdate()}>重启并安装</Button>}</CardFooter>
      </Card>

      <Card className="settings-card">
        <CardHeader><div><CardTitle>启动与后台运行</CardTitle><CardDescription>开机后启动桌面端并保持待机，不会自动发布文章。</CardDescription></div><Power size={18}/></CardHeader>
        <CardContent><div className="setting-row"><div><strong>开机启动</strong><p>{launchAtLogin.available ? '开启后，WorkBuddy 随时可以连接桌面端。' : '当前安装方式暂不支持修改，安装正式版本后即可设置。'}</p></div><Switch label="开机启动" checked={launchAtLogin.enabled} disabled={!launchAtLogin.available || working === 'launch'} onCheckedChange={(enabled) => void toggleLaunchAtLogin(enabled)} /></div></CardContent>
      </Card>

      <Card className="settings-card">
        <CardHeader><div><CardTitle>排障与本地数据</CardTitle><CardDescription>遇到问题时可以复制排障信息给客服，不会包含客户资料或账号信息。</CardDescription></div><Badge>保存在本机</Badge></CardHeader>
        <CardContent><div className="setting-row"><div><strong>排障信息</strong><p>只包含应用版本、电脑系统和运行状态。</p></div></div><div className="setting-row"><div><strong>本地数据</strong><p>每个客户的资料、内容和平台登录状态分别保存在本机。</p></div></div></CardContent>
        <CardFooter><Button variant="outline" icon={Copy} onClick={() => void copyDiagnostics()}>复制排障信息</Button><Button variant="outline" icon={FolderOpen} onClick={() => void openDataDirectory()}>打开保存位置</Button></CardFooter>
      </Card>
    </div>
  </div>;
}
function Stat({icon:Icon,label,value}:any){return <Card className="stat"><Icon size={18}/><span>{label}</span><strong>{value}</strong></Card>}
function ProjectSelector({ projects, currentProject, busy, close, select, edit, create }: any) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
    return () => { if (dialog?.open) dialog.close(); };
  }, []);
  return <dialog ref={dialogRef} id="project-selector" className="project-selector" aria-labelledby="project-selector-title" onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }} onCancel={(event) => { event.preventDefault(); close(); }}>
    <section className="project-selector-layout">
      <header className="project-selector-head"><div><p className="eyebrow">客户项目</p><h2 id="project-selector-title">切换当前客户</h2><p>内容、平台账号和登录状态会随客户项目一起切换。</p></div><Button variant="ghost" icon={X} onClick={close} aria-label="关闭项目选择器" /></header>
      <div className="project-selector-list">{projects.length ? projects.map((target: any) => <div className={target.id === currentProject?.id ? 'project-selector-row current' : 'project-selector-row'} key={target.id}>
        <span className="project-avatar"><UserRound size={15}/></span><span><strong>{target.name}</strong><small>{target.companyName || target.industry || '未填写公司资料'}</small></span>
        <div className="project-selector-actions">{target.id === currentProject?.id ? <Badge tone="success">当前项目</Badge> : <Button disabled={busy} onClick={() => void select(target.id)}>切换</Button>}<Button variant="ghost" icon={Pencil} disabled={busy} onClick={() => edit(target)}>编辑</Button></div>
      </div>) : <Empty icon={UsersRound} title="暂无客户项目" description="新建客户项目后即可独立管理资料、账号和内容。"/>}</div>
      <footer className="project-selector-foot"><p>{busy ? '任务执行中，暂时不能切换客户项目。' : `共 ${projects.length} 个客户项目`}</p><Button icon={Plus} disabled={busy} onClick={create}>新建客户项目</Button></footer>
    </section>
  </dialog>;
}
function ProjectDialog({ editing, setEditing, save }: any) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [saving, setSaving] = useState(false);
  const [submitIssue, setSubmitIssue] = useState<ProjectProfileIssue | null>(null);
  const profileFields = ['name', 'companyName', 'industry', 'products', 'strengths', 'valueAndAudience', 'operatingYears', 'cases', 'credentials', 'serviceArea', 'customerQuestions', 'allowedSources', 'forbiddenPhrases'];
  const completed = profileFields.filter((field) => String(editing[field] || '').trim()).length;
  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
    return () => { if (dialog?.open) dialog.close(); };
  }, []);
  const fieldIds: Record<ProjectProfileField, string> = {
    name: 'project-input-name', companyName: 'project-company-name', industry: 'project-industry', products: 'project-products', strengths: 'project-strengths', valueAndAudience: 'project-audience', operatingYears: 'project-years', cases: 'project-cases', credentials: 'project-credentials', serviceArea: 'project-service-area', customerQuestions: 'project-questions', allowedSources: 'project-sources', forbiddenPhrases: 'project-forbidden',
  };
  const focusIssue = (issue: ProjectProfileIssue) => {
    if (!issue.field) return;
    window.requestAnimationFrame(() => {
      const control = document.getElementById(fieldIds[issue.field!]);
      const details = control?.closest('details');
      if (details) details.open = true;
      control?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      control?.focus({ preventScroll: true });
    });
  };
  const update = (field: ProjectProfileField, value: string) => {
    setEditing({ ...editing, [field]: value });
    if (submitIssue?.field === field) setSubmitIssue(null);
  };
  const controlProps = (field: ProjectProfileField) => ({
    maxLength: projectProfileFields[field].maxLength,
    'aria-invalid': submitIssue?.field === field || undefined,
  });
  const submit = async () => {
    if (saving) return;
    const issue = validateProjectProfile(editing);
    if (issue) {
      setSubmitIssue(issue);
      focusIssue(issue);
      return;
    }
    setSubmitIssue(null);
    setSaving(true);
    try {
      await save();
    } catch (error) {
      setSubmitIssue({ field: null, message: friendlyProjectSaveError(error) });
    } finally {
      setSaving(false);
    }
  };
  return <dialog ref={dialogRef} id="project-dialog" className="project-sheet" aria-labelledby="project-dialog-title" onCancel={(event) => { event.preventDefault(); setEditing(null); }}>
    <form className="project-sheet-form" noValidate onSubmit={(event) => { event.preventDefault(); void submit(); }}>
      <header className="project-sheet-head">
        <div className="project-sheet-identity"><span className="project-sheet-avatar"><Building2 size={20} /></span><div><p className="eyebrow">{editing.id ? '客户项目资料' : '创建客户项目'}</p><h2 id="project-dialog-title">{editing.id ? (editing.name || '编辑客户项目') : '建立客户资料'}</h2><p>{editing.id ? '资料会用于选题、文章生成和平台分发。' : '先填写必要信息，其余资料可以以后继续完善。'}</p></div></div>
        <div className="project-sheet-actions"><Badge tone={completed >= 10 ? 'success' : 'neutral'}>已完善 {completed}/{profileFields.length}</Badge><Button type="button" variant="ghost" icon={X} onClick={() => setEditing(null)} aria-label="关闭客户资料" /></div>
      </header>
      <div className="project-sheet-body">
        <section className="project-form-section">
          <div className="project-section-head"><span><Building2 size={17} /></span><div><h3>基础信息</h3><p>项目名称仅用于区分客户，不会出现在发布的文章中。</p></div></div>
          <FieldGroup>
            <Field label="项目名称" description="建议使用客户简称，方便快速切换。" htmlFor="project-input-name"><input id="project-input-name" autoFocus {...controlProps('name')} value={editing.name || ''} onChange={(event) => update('name', event.target.value)} placeholder="例如：沧州华晨压瓦机械" /></Field>
            <Field label="公司或品牌全称" htmlFor="project-company-name"><input id="project-company-name" {...controlProps('companyName')} value={editing.companyName || ''} onChange={(event) => update('companyName', event.target.value)} placeholder="文章中需要使用的正式名称" /></Field>
            <Field label="行业与核心业务" htmlFor="project-industry"><textarea id="project-industry" {...controlProps('industry')} value={editing.industry || ''} onChange={(event) => update('industry', event.target.value)} placeholder="公司属于什么行业，主要解决什么问题" /></Field>
          </FieldGroup>
        </section>

        <section className="project-form-section">
          <div className="project-section-head"><span><BriefcaseBusiness size={17} /></span><div><h3>业务内容</h3><p>这些信息会直接影响选题是否具体、文章是否像这个行业的人写的。</p></div></div>
          <FieldGroup>
            <Field label="核心产品或服务" htmlFor="project-products"><textarea id="project-products" {...controlProps('products')} value={editing.products || ''} onChange={(event) => update('products', event.target.value)} placeholder="列出主要产品、服务或解决方案" /></Field>
            <Field label="核心优势" htmlFor="project-strengths"><textarea id="project-strengths" {...controlProps('strengths')} value={editing.strengths || ''} onChange={(event) => update('strengths', event.target.value)} placeholder="填写1-3个最有区分度、可以公开表达的优势" /></Field>
            <Field label="目标客户与产品/服务价值" htmlFor="project-audience"><textarea id="project-audience" {...controlProps('valueAndAudience')} value={editing.valueAndAudience || ''} onChange={(event) => update('valueAndAudience', event.target.value)} placeholder="客户是谁、通常关心什么，产品或服务能为他们带来什么价值" /></Field>
          </FieldGroup>
        </section>

        <details className="project-form-more">
          <summary><span className="project-more-icon"><ShieldCheck size={17} /></span><span><strong>案例与信任资料</strong><small>经营年限、真实案例和资质认证</small></span><ChevronDown size={17} /></summary>
          <FieldGroup>
            <Field label="经营年限或成立时间" htmlFor="project-years"><input id="project-years" {...controlProps('operatingYears')} value={editing.operatingYears || ''} onChange={(event) => update('operatingYears', event.target.value)} placeholder="例如：成立于2012年" /></Field>
            <Field label="代表案例" htmlFor="project-cases"><textarea id="project-cases" {...controlProps('cases')} value={editing.cases || ''} onChange={(event) => update('cases', event.target.value)} placeholder="只填写允许公开的真实客户、项目、动作和结果" /></Field>
            <Field label="资质与权威背书" htmlFor="project-credentials"><textarea id="project-credentials" {...controlProps('credentials')} value={editing.credentials || ''} onChange={(event) => update('credentials', event.target.value)} placeholder="认证、专利、奖项、许可证或行业标准" /></Field>
          </FieldGroup>
        </details>

        <details className="project-form-more">
          <summary><span className="project-more-icon"><Globe2 size={17} /></span><span><strong>服务范围</strong><small>服务地区或常见应用场景，可暂时不填</small></span><ChevronDown size={17} /></summary>
          <FieldGroup>
            <Field label="服务地区或应用场景" htmlFor="project-service-area"><input id="project-service-area" {...controlProps('serviceArea')} value={editing.serviceArea || ''} onChange={(event) => update('serviceArea', event.target.value)} placeholder="例如：全国服务、海外市场、工业园区" /></Field>
          </FieldGroup>
        </details>

        <details className="project-form-more">
          <summary><span className="project-more-icon"><MessageSquareText size={17} /></span><span><strong>内容偏好与边界</strong><small>帮助 WorkBuddy 选题并避免不合适的表达</small></span><ChevronDown size={17} /></summary>
          <FieldGroup>
            <Field label="客户经常问的问题" htmlFor="project-questions"><textarea id="project-questions" {...controlProps('customerQuestions')} value={editing.customerQuestions || ''} onChange={(event) => update('customerQuestions', event.target.value)} placeholder="销售沟通、搜索或咨询中经常出现的问题" /></Field>
            <Field label="允许引用的来源" htmlFor="project-sources"><textarea id="project-sources" {...controlProps('allowedSources')} value={editing.allowedSources || ''} onChange={(event) => update('allowedSources', event.target.value)} placeholder="公众号、资料文件或指定行业来源；不要填写联系方式" /></Field>
            <Field label="禁用词与敏感内容" htmlFor="project-forbidden"><textarea id="project-forbidden" {...controlProps('forbiddenPhrases')} value={editing.forbiddenPhrases || ''} onChange={(event) => update('forbiddenPhrases', event.target.value)} placeholder="不希望出现的承诺、竞品、敏感词或话题" /></Field>
          </FieldGroup>
        </details>
      </div>
      <footer className="project-sheet-foot"><div className="project-sheet-feedback"><p>{editing.id ? '保存后，WorkBuddy 下次生成内容时会使用最新资料。' : '创建后会自动切换到这个客户项目。'}</p>{submitIssue && <p id="project-submit-error" className="project-submit-error" role="alert"><CircleAlert size={15}/>{submitIssue.message}</p>}</div><div><Button type="button" variant="outline" disabled={saving} onClick={() => setEditing(null)}>取消</Button><Button id="project-save" type="submit" disabled={saving} icon={saving ? undefined : editing.id ? CheckCircle2 : Plus}>{saving && <Spinner/>}{saving ? (editing.id ? '正在保存' : '正在创建') : editing.id ? '保存修改' : '创建项目'}</Button></div></footer>
    </form>
  </dialog>;
}
createRoot(document.getElementById('root')!).render(<App/>);
