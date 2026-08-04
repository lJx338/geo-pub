const buttons = [...document.querySelectorAll('[data-platform]')];

for (const button of buttons) {
  button.addEventListener('click', async () => {
    buttons.forEach((candidate) => candidate.classList.remove('active'));
    button.classList.add('active');
    document.querySelector('#empty').style.display = 'none';
    document.querySelector('#connection').textContent = '正在打开平台…';
    try {
      await window.geoPublisher.openPlatform(button.dataset.platform);
      document.querySelector('#connection').textContent = '平台已连接';
    } catch (error) {
      document.querySelector('#connection').textContent = `打开失败：${error.message}`;
    }
  });
}

void window.geoPublisher.status().then((status) => {
  document.querySelector('#connection').textContent = `桌面端 ${status.version} 已启动`;
});
