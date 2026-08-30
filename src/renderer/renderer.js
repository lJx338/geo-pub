const connection = document.querySelector('#connection');
const actionMessage = document.querySelector('#action-message');
const workBuddyState = document.querySelector('#workbuddy-state');
const updateState = document.querySelector('#update-state');
const installUpdateButton = document.querySelector('#install-update');
const showWorkerButton = document.querySelector('#show-worker');
const platformProgress = document.querySelector('#platform-progress');
const historySection = document.querySelector('#history-section');
const historyList = document.querySelector('#history-list');
const taskTitle = document.querySelector('#task-title');
const taskSummary = document.querySelector('#task-summary');
const taskProgress = document.querySelector('#task-progress');
const clearHistoryButton = document.querySelector('#clear-history');
const publishingView = document.querySelector('#publishing-view');
const tutorialView = document.querySelector('#tutorial-view');
const dashboardNav = document.querySelector('#nav-dashboard');
const tutorialNav = document.querySelector('#nav-tutorial');
const tutorialOpenPlatforms = document.querySelector('#tutorial-open-platforms');
const tutorialConnectWorkBuddy = document.querySelector('#tutorial-connect-workbuddy');
const tutorialShowWorker = document.querySelector('#tutorial-show-worker');
const tutorialWorkBuddyState = document.querySelector('#tutorial-workbuddy-state');
const tutorialWorkBuddyDot = document.querySelector('#tutorial-workbuddy-dot');

const platformLabels = {
  baijia: '百家号', toutiao: '头条号', zhihu: '知乎', penguin: '企鹅号', sohu: '搜狐号', netease: '网易号',
};
const phaseLabels = {
  opening: '正在打开', filling: '正在填写', pre_publish: '准备发布', dispatching: '正在发布', dispatched: '正在确认结果', reconciling: '正在确认结果',
};
const statusLabels = {
  running: '进行中',
  success: '已处理',
  failed: '失败',
  action_required: '需要处理',
  result_uncertain: '等待确认',
};

function taskStatusLabel(task) {
  if (!task) return '未开始';
  if (task.status === 'success') return task.action === 'publish' ? '已发布' : '已填充';
  if (task.status === 'failed') return task.action === 'publish' ? '发布失败' : '填充失败';
  if (task.status === 'running') {
    if (task.action === 'publish') return phaseLabels[task.phase] || '正在发布';
    if (task.action === 'fill') return phaseLabels[task.phase] || '正在填写';
  }
  if (task.status === 'result_uncertain') return '发布待确认';
  if (task.status === 'action_required') return task.action === 'publish' ? '发布需处理' : '填充需处理';
  return statusLabels[task.status] || task.status;
}

function latestTasksByPlatform(tasks) {
  return new Map((tasks || []).reduce((items, task) => {
    if (!items.has(task.platform)) items.set(task.platform, task);
    return items;
  }, new Map()));
}

function textElement(tag, className, text) {
  const element = document.createElement(tag);
  element.className = className;
  element.textContent = text;
  return element;
}

function renderTaskStatus(status) {
  const active = status.activeTask;
  const publishingTask = active && (active.action === 'fill' || active.action === 'publish') ? active : null;
  const title = publishingTask?.title || (status.recentTasks || []).find((task) => task.title)?.title;
  const currentTasks = title
    ? (status.recentTasks || []).filter((task) => task.title === title)
    : [];
  const latest = latestTasksByPlatform(currentTasks);
  taskTitle.textContent = title || '发布中心';
  if (publishingTask) {
    taskSummary.textContent = `${platformLabels[active.platform]}${phaseLabels[active.phase] || '正在处理'}，请保持电脑开机。`;
    const done = currentTasks.filter((task) => task.status === 'success').length;
    taskProgress.textContent = `${Math.min(6, done + 1)} / 6`;
  } else if (active) {
    taskTitle.textContent = '发布中心';
    taskSummary.textContent = `${platformLabels[active.platform]}页面正在打开。`;
    taskProgress.textContent = '打开页面';
  } else {
    const published = currentTasks.filter((task) => task.status === 'success' && task.action === 'publish').length;
    const filled = currentTasks.filter((task) => task.status === 'success' && task.action === 'fill').length;
    taskSummary.textContent = published
      ? `最近已发布 ${published} 个平台${filled ? `，已填充 ${filled} 个平台` : ''}。`
      : filled
        ? `最近已填充 ${filled} 个平台。`
        : '准备好后，文章会自动显示在这里。';
    taskProgress.textContent = published || filled ? `${published || filled} 个平台已处理` : '等待开始';
  }
  platformProgress.replaceChildren(...Object.entries(platformLabels).map(([platform, label]) => {
    const item = document.createElement('article');
    const task = latest.get(platform);
    const activePlatform = active?.platform === platform;
    const state = activePlatform ? 'running' : (task?.status || 'idle');
    item.className = `progress-item state-${state}`;
    const statusText = activePlatform ? (phaseLabels[active.phase] || '处理中') : taskStatusLabel(task);
    item.append(
      textElement('div', 'progress-icon', ''),
      (() => {
        const copy = textElement('div', 'progress-copy', '');
        copy.append(textElement('strong', '', label), textElement('span', '', statusText));
        if (task?.message && state !== 'success') copy.append(textElement('small', '', task.message));
        return copy;
      })(),
    );
    const pageButton = textElement('button', 'page-button', '打开页面');
    pageButton.type = 'button';
    item.append(pageButton);
    if (task?.evidencePath) {
      const evidenceButton = textElement('button', 'evidence-button', '查看问题');
      evidenceButton.type = 'button';
      item.append(evidenceButton);
      evidenceButton.addEventListener('click', async () => {
        const result = await window.geoPublisher.openEvidence(task.evidencePath);
        showMessage(result.opened ? '问题画面已打开' : (result.message || '问题画面打开失败'), !result.opened);
      });
    }
    pageButton.addEventListener('click', async () => {
      pageButton.disabled = true;
      try {
        await window.geoPublisher.openPlatform(platform);
        showMessage(`${label}页面已打开`);
      } catch (error) {
        showMessage(`${label}页面打开失败：${error.message}`, true);
      } finally {
        pageButton.disabled = false;
      }
    });
    return item;
  }));
  const history = (status.recentTasks || []).filter((task) => task.status !== 'running').slice(0, 12);
  historySection.hidden = history.length === 0;
  historyList.replaceChildren(...history.map((task) => {
    const row = document.createElement('div');
    row.className = 'history-row';
    row.append(
      textElement('span', '', platformLabels[task.platform] || task.platform),
      textElement('span', '', task.title || '未命名文章'),
      textElement('span', `history-status state-${task.status}`, taskStatusLabel(task)),
      textElement('time', '', new Date(task.finishedAt || task.startedAt).toLocaleString()),
    );
    return row;
  }));
}

dashboardNav.addEventListener('click', () => {
  dashboardNav.classList.add('active');
  tutorialNav.classList.remove('active');
  publishingView.hidden = false;
  tutorialView.hidden = true;
  document.querySelector('#dashboard').scrollTo({ top: 0, behavior: 'smooth' });
});

tutorialNav.addEventListener('click', () => {
  tutorialNav.classList.add('active');
  dashboardNav.classList.remove('active');
  publishingView.hidden = true;
  tutorialView.hidden = false;
  document.querySelector('#dashboard').scrollTo({ top: 0, behavior: 'smooth' });
});

tutorialOpenPlatforms.addEventListener('click', () => dashboardNav.click());
tutorialConnectWorkBuddy.addEventListener('click', () => document.querySelector('#connect-workbuddy').click());
tutorialShowWorker.addEventListener('click', () => showWorkerButton.click());

function showMessage(message, error = false) {
  actionMessage.textContent = message;
  actionMessage.title = message;
  actionMessage.classList.toggle('error', error);
}

function renderUpdate(status) {
  const labels = {
    disabled: '不可用',
    idle: '检查',
    checking: '检查中',
    current: '已是最新',
    available: '有新版本',
    downloading: status.progress === null ? '下载中' : `${status.progress}%`,
    downloaded: '可安装',
    error: '重试',
  };
  updateState.textContent = labels[status.phase] || '检查';
  updateState.title = status.message;
  installUpdateButton.hidden = !status.canRestart;
  if (!['idle', 'disabled'].includes(status.phase)) showMessage(status.message, status.phase === 'error');
}

function setConnection(message, state = 'ready') {
  connection.textContent = message;
  connection.dataset.state = state;
}

showWorkerButton.addEventListener('click', async () => {
  showWorkerButton.disabled = true;
  try {
    await window.geoPublisher.showWorker();
    showMessage('发布窗口已打开');
  } catch (error) {
    showMessage(`发布窗口打开失败：${error.message}`, true);
  } finally {
    showWorkerButton.disabled = false;
  }
});

document.querySelector('#connect-workbuddy').addEventListener('click', async () => {
  const button = document.querySelector('#connect-workbuddy');
  button.disabled = true;
  workBuddyState.textContent = '连接中';
  try {
    await window.geoPublisher.connectWorkBuddy();
    workBuddyState.textContent = '指令已复制';
    tutorialWorkBuddyState.textContent = '已连接';
    tutorialWorkBuddyDot.classList.add('ready');
    showMessage('WorkBuddy 已打开，Skill 和 CLI 已安装，请粘贴刚刚复制的连接指令');
  } catch (error) {
    workBuddyState.textContent = '重试';
    showMessage(`连接准备失败：${error.message}`, true);
  } finally {
    button.disabled = false;
  }
});

document.querySelector('#check-update').addEventListener('click', async () => {
  const button = document.querySelector('#check-update');
  button.disabled = true;
  updateState.textContent = '检查中';
  try {
    renderUpdate(await window.geoPublisher.checkForUpdates());
  } finally {
    button.disabled = false;
  }
});

installUpdateButton.addEventListener('click', async () => {
  const result = await window.geoPublisher.installUpdate();
  showMessage(result.message, !result.accepted);
});

clearHistoryButton.addEventListener('click', async () => {
  if (!window.confirm('清除最近记录和关联的失败画面？登录状态和防重复发布保护不会受影响。')) return;
  clearHistoryButton.disabled = true;
  try {
    renderTaskStatus(await window.geoPublisher.clearTaskHistory());
    showMessage('最近记录已清除');
  } finally {
    clearHistoryButton.disabled = false;
  }
});

window.geoPublisher.onUpdateStatus(renderUpdate);

void Promise.all([
  window.geoPublisher.status(),
  window.geoPublisher.workBuddyStatus(),
  window.geoPublisher.updateStatus(),
]).then(([status, workBuddy, update]) => {
  setConnection(status.busy ? '发布任务运行中' : '桌面端已就绪', status.busy ? 'busy' : 'ready');
  document.querySelector('#version').textContent = `v${status.version}`;
  workBuddyState.textContent = workBuddy.prepared ? '已准备' : '未连接';
  tutorialWorkBuddyState.textContent = workBuddy.prepared ? '已连接' : '未连接';
  tutorialWorkBuddyDot.classList.toggle('ready', workBuddy.prepared);
  renderUpdate(update);
  renderTaskStatus(status);
});

setInterval(() => {
  void window.geoPublisher.status().then((status) => {
    setConnection(status.busy ? '发布任务运行中' : '桌面端已就绪', status.busy ? 'busy' : 'ready');
    renderTaskStatus(status);
  }).catch(() => undefined);
}, 1000);
