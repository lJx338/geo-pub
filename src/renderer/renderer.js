const platformButtons = [...document.querySelectorAll('[data-platform]')];
const connection = document.querySelector('#connection');
const actionMessage = document.querySelector('#action-message');
const workBuddyState = document.querySelector('#workbuddy-state');
const updateState = document.querySelector('#update-state');
const installUpdateButton = document.querySelector('#install-update');

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

window.geoPublisher.onUpdateStatus(renderUpdate);

void Promise.all([
  window.geoPublisher.status(),
  window.geoPublisher.workBuddyStatus(),
  window.geoPublisher.updateStatus(),
]).then(([status, workBuddy, update]) => {
  setConnection(status.busy ? '发布任务运行中' : '桌面端已就绪', status.busy ? 'busy' : 'ready');
  document.querySelector('#version').textContent = `v${status.version}`;
  workBuddyState.textContent = workBuddy.prepared ? '已准备' : '未连接';
  renderUpdate(update);
});
