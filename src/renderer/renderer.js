const platformButtons = [...document.querySelectorAll('[data-platform]')];
const connection = document.querySelector('#connection');
const actionMessage = document.querySelector('#action-message');
const workBuddyState = document.querySelector('#workbuddy-state');
const updateState = document.querySelector('#update-state');
const installUpdateButton = document.querySelector('#install-update');
const launchAtLogin = document.querySelector('#launch-at-login');
const betaAccess = document.querySelector('#beta-access');
const betaDisable = document.querySelector('#beta-disable');
const betaDialog = document.querySelector('#beta-dialog');
const betaCode = document.querySelector('#beta-code');
const betaSubmit = document.querySelector('#beta-submit');
const projectSwitch = document.querySelector('#project-switch');
const projectName = document.querySelector('#project-name');
const projectDialog = document.querySelector('#project-dialog');
const projectSelect = document.querySelector('#project-select');
const projectInputName = document.querySelector('#project-input-name');
const projectCompanyName = document.querySelector('#project-company-name');
const projectIndustry = document.querySelector('#project-industry');
const projectProducts = document.querySelector('#project-products');
const projectValue = document.querySelector('#project-value');
const projectSave = document.querySelector('#project-save');
let taskBusy = false;
let currentProject = null;
let availableProjects = [];

function populateProjectForm(project) {
  projectInputName.value = project?.name || '';
  projectCompanyName.value = project?.companyName || '';
  projectIndustry.value = project?.industry || '';
  projectProducts.value = project?.products || '';
  projectValue.value = project?.valueAndAudience || '';
}

function renderProjects(payload) {
  availableProjects = payload.projects || [];
  currentProject = payload.currentProject || null;
  projectName.textContent = currentProject?.name || '新建客户项目';
  const newOption = document.createElement('option');
  newOption.value = '';
  newOption.textContent = '+ 新建客户项目';
  newOption.selected = !currentProject;
  projectSelect.replaceChildren(newOption, ...availableProjects.map((project) => {
    const option = document.createElement('option');
    option.value = project.id;
    option.textContent = project.name;
    option.selected = project.id === currentProject?.id;
    return option;
  }));
  populateProjectForm(currentProject);
}

function renderTaskStatus(status) {
  taskBusy = Boolean(status.busy);
  const platformLabels = { baijia: '百家号', toutiao: '头条号', zhihu: '知乎', penguin: '企鹅号', sohu: '搜狐号', netease: '网易号' };
  const executingName = platformLabels[status.executingPlatform] || '平台';
  for (const button of platformButtons) {
    button.classList.toggle('task-locked', taskBusy);
    button.setAttribute('aria-disabled', String(taskBusy));
  }
  if (taskBusy) {
    setConnection(`${executingName}任务运行中`, 'busy');
    showMessage(`正在执行${executingName}任务，完成前不能切换平台`);
  } else if (!status.attentionRequired) {
    setConnection('桌面端已就绪', 'ready');
    showMessage('桌面端已就绪');
  }
}

function showMessage(message, error = false) {
  actionMessage.textContent = message;
  actionMessage.title = message;
  actionMessage.classList.toggle('error', error);
}

function renderUpdate(status) {
  const targetVersion = status.availableVersion ? `v${status.availableVersion}` : '';
  const labels = {
    disabled: '不可用',
    idle: '检查',
    checking: '检查中',
    current: '已是最新',
    available: targetVersion ? `更新至 ${targetVersion}` : '有新版本',
    downloading: targetVersion
      ? (status.progress === null ? `下载 ${targetVersion}` : `${targetVersion} ${status.progress}%`)
      : (status.progress === null ? '下载中' : `${status.progress}%`),
    downloaded: targetVersion ? `可安装 ${targetVersion}` : '可安装',
    error: '重试',
  };
  updateState.textContent = labels[status.phase] || '检查';
  updateState.title = status.message;
  installUpdateButton.hidden = !status.canRestart;
  installUpdateButton.textContent = targetVersion ? `重启并安装 ${targetVersion}` : '重启并安装更新';
  betaAccess.hidden = status.channel === 'beta';
  betaDisable.hidden = status.channel !== 'beta';
  if (!['idle', 'disabled'].includes(status.phase)) showMessage(status.message, status.phase === 'error');
}

function setConnection(message, state = 'ready') {
  connection.textContent = message;
  connection.dataset.state = state;
}

for (const button of platformButtons) {
  button.addEventListener('click', async () => {
    if (taskBusy) {
      showMessage('发布任务正在执行，完成前不能切换平台', true);
      return;
    }
    if (!currentProject) {
      showMessage('请先新建并选择客户项目', true);
      return;
    }
    if (button.disabled) return;
    platformButtons.forEach((candidate) => candidate.classList.remove('active'));
    button.classList.add('active');
    document.querySelector('#empty').style.display = 'none';
    platformButtons.forEach((candidate) => {
      if (candidate !== button) candidate.querySelector('.platform-state').textContent = '打开';
    });
    const platformName = button.querySelector('span').textContent;
    button.disabled = true;
    button.querySelector('.platform-state').textContent = '打开中';
    setConnection(`正在打开${platformName}`, 'busy');
    try {
      await window.geoPublisher.openPlatform(button.dataset.platform);
      setConnection(`${platformName}已打开`);
      button.querySelector('.platform-state').textContent = '当前';
    } catch (error) {
      setConnection(`${platformName}打开失败`, 'error');
      button.querySelector('.platform-state').textContent = '重试';
      showMessage(`${platformName}打开失败：${error.message}`, true);
    } finally {
      button.disabled = false;
    }
  });
}

projectSwitch.addEventListener('click', async () => {
  if (taskBusy) return showMessage('发布任务正在执行，完成前不能切换客户项目', true);
  const payload = await window.geoPublisher.projects();
  renderProjects(payload);
  await window.geoPublisher.setUiOverlayOpen(true);
  projectDialog.showModal();
});

projectDialog.addEventListener('close', () => { void window.geoPublisher.setUiOverlayOpen(false); });

projectSelect.addEventListener('change', () => {
  const project = availableProjects.find((item) => item.id === projectSelect.value) || null;
  populateProjectForm(project);
});

projectSave.addEventListener('click', async (event) => {
  event.preventDefault();
  projectSave.disabled = true;
  try {
    const input = {
      name: projectInputName.value.trim(), companyName: projectCompanyName.value.trim(),
      industry: projectIndustry.value.trim(), products: projectProducts.value.trim(),
      valueAndAudience: projectValue.value.trim(),
    };
    let result;
    const selected = availableProjects.find((item) => item.id === projectSelect.value);
    if (selected) {
      await window.geoPublisher.updateProject(selected.id, input);
      result = await window.geoPublisher.selectProject(selected.id);
    } else {
      result = await window.geoPublisher.createProject(input);
    }
    renderProjects(await window.geoPublisher.projects());
    projectDialog.close();
    showMessage(`已切换到客户项目：${result.currentProject.name}`);
  } catch (error) {
    showMessage(`保存客户项目失败：${error.message}`, true);
  } finally {
    projectSave.disabled = false;
  }
});

document.querySelector('#connect-workbuddy').addEventListener('click', async () => {
  const button = document.querySelector('#connect-workbuddy');
  button.disabled = true;
  workBuddyState.textContent = '连接中';
  try {
    await window.geoPublisher.connectWorkBuddy();
    workBuddyState.textContent = '指令已复制';
    showMessage('WorkBuddy 已打开，请粘贴刚刚复制的连接指令');
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

betaAccess.addEventListener('click', async () => {
  betaCode.value = '';
  await window.geoPublisher.setUiOverlayOpen(true);
  try {
    betaDialog.showModal();
    betaCode.focus();
  } catch (error) {
    await window.geoPublisher.setUiOverlayOpen(false);
    showMessage(`无法打开灰度设置：${error.message}`, true);
  }
});

betaDialog.addEventListener('close', () => {
  void window.geoPublisher.setUiOverlayOpen(false);
});

betaSubmit.addEventListener('click', async (event) => {
  event.preventDefault();
  betaSubmit.disabled = true;
  try {
    const result = await window.geoPublisher.activateBeta(betaCode.value);
    showMessage(result.message, !result.accepted);
    renderUpdate(result.update);
    betaDisable.hidden = !result.enabled;
    if (result.accepted) betaDialog.close();
  } finally {
    betaSubmit.disabled = false;
  }
});

betaDisable.addEventListener('click', async () => {
  betaDisable.disabled = true;
  try {
    const result = await window.geoPublisher.deactivateBeta();
    showMessage(result.message, !result.accepted);
    renderUpdate(result.update);
    betaDisable.hidden = true;
  } finally {
    betaDisable.disabled = false;
  }
});

launchAtLogin.addEventListener('change', async () => {
  launchAtLogin.disabled = true;
  try {
    const result = await window.geoPublisher.setLaunchAtLogin(launchAtLogin.checked);
    launchAtLogin.checked = result.enabled;
    showMessage(result.enabled ? '已开启开机自动启动' : '已关闭开机自动启动');
  } catch (error) {
    launchAtLogin.checked = !launchAtLogin.checked;
    showMessage(`设置开机启动失败：${error.message}`, true);
  } finally {
    launchAtLogin.disabled = false;
  }
});

window.geoPublisher.onUpdateStatus(renderUpdate);
window.geoPublisher.onAttentionRequired((attention) => {
  if (!attention) return;
  setConnection('需要人工处理', 'error');
  showMessage(`${attention.platform}需要人工处理：${attention.message}`, true);
});
window.geoPublisher.onStatusChanged(renderTaskStatus);

void Promise.all([
  window.geoPublisher.status(),
  window.geoPublisher.projects(),
  window.geoPublisher.workBuddyStatus(),
  window.geoPublisher.updateStatus(),
  window.geoPublisher.launchAtLoginStatus(),
]).then(([status, projects, workBuddy, update, launchStatus]) => {
  renderProjects(projects);
  if (status.attentionRequired) {
    setConnection('需要人工处理', 'error');
    showMessage(`${status.attentionRequired.platform}需要人工处理：${status.attentionRequired.message}`, true);
  } else {
    renderTaskStatus(status);
  }
  document.querySelector('#version').textContent = `v${status.version}`;
  workBuddyState.textContent = workBuddy.prepared ? '已准备' : '未连接';
  launchAtLogin.disabled = !launchStatus.available;
  launchAtLogin.checked = launchStatus.enabled;
  launchAtLogin.title = launchStatus.available ? '' : '安装后的正式版支持开机自动启动';
  renderUpdate(update);
});
