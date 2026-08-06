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

betaAccess.addEventListener('click', () => {
  betaCode.value = '';
  betaDialog.showModal();
  betaCode.focus();
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

void Promise.all([
  window.geoPublisher.status(),
  window.geoPublisher.workBuddyStatus(),
  window.geoPublisher.updateStatus(),
  window.geoPublisher.launchAtLoginStatus(),
]).then(([status, workBuddy, update, launchStatus]) => {
  if (status.attentionRequired) {
    setConnection('需要人工处理', 'error');
    showMessage(`${status.attentionRequired.platform}需要人工处理：${status.attentionRequired.message}`, true);
  } else {
    setConnection(status.busy ? '发布任务运行中' : '桌面端已就绪', status.busy ? 'busy' : 'ready');
  }
  document.querySelector('#version').textContent = `v${status.version}`;
  workBuddyState.textContent = workBuddy.prepared ? '已准备' : '未连接';
  launchAtLogin.disabled = !launchStatus.available;
  launchAtLogin.checked = launchStatus.enabled;
  launchAtLogin.title = launchStatus.available ? '' : '安装后的正式版支持开机自动启动';
  renderUpdate(update);
});
