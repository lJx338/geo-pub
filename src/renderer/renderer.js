const platformButtons = [...document.querySelectorAll('[data-platform]')];
const connection = document.querySelector('#connection');
const actionMessage = document.querySelector('#action-message');
const workBuddyState = document.querySelector('#workbuddy-state');
const updateState = document.querySelector('#update-state');
const installUpdateButton = document.querySelector('#install-update');

function showMessage(message, error = false) {
  actionMessage.textContent = message;
  actionMessage.classList.toggle('error', error);
}

function renderUpdate(status) {
  updateState.textContent = status.phase === 'downloaded' ? '可安装' : status.message;
  installUpdateButton.hidden = !status.canRestart;
  showMessage(status.message, status.phase === 'error');
}

for (const button of platformButtons) {
  button.addEventListener('click', async () => {
    platformButtons.forEach((candidate) => candidate.classList.remove('active'));
    button.classList.add('active');
    document.querySelector('#empty').style.display = 'none';
    connection.textContent = `正在打开${button.querySelector('span').textContent}…`;
    try {
      await window.geoPublisher.openPlatform(button.dataset.platform);
      connection.textContent = '平台已连接';
      button.querySelector('.platform-state').textContent = '已打开';
    } catch (error) {
      connection.textContent = '平台打开失败';
      button.querySelector('.platform-state').textContent = '重试';
    }
  });
}

document.querySelector('#connect-workbuddy').addEventListener('click', async () => {
  workBuddyState.textContent = '连接中';
  try {
    await window.geoPublisher.connectWorkBuddy();
    workBuddyState.textContent = '指令已复制';
    showMessage('WorkBuddy 已打开，请粘贴刚刚复制的连接指令');
  } catch (error) {
    workBuddyState.textContent = '重试';
    showMessage(`连接准备失败：${error.message}`, true);
  }
});

document.querySelector('#check-update').addEventListener('click', async () => {
  updateState.textContent = '检查中';
  renderUpdate(await window.geoPublisher.checkForUpdates());
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
  connection.textContent = status.busy ? '发布任务运行中' : '桌面端已就绪';
  document.querySelector('#version').textContent = `v${status.version}`;
  workBuddyState.textContent = workBuddy.prepared ? '已准备' : '未连接';
  renderUpdate(update);
});
