const platforms = [
  ['baijia', '百家号'],
  ['toutiao', '头条号'],
  ['zhihu', '知乎'],
  ['penguin', '企鹅号'],
  ['sohu', '搜狐号'],
  ['netease', '网易号'],
];

const tabList = document.getElementById('tab-list');
const newTabSelect = document.getElementById('new-tab-select');
const workerState = document.getElementById('worker-state');
let latestStatus = null;
let requestedPlatform = null;
let switchingPlatform = null;
let switchingLoop = null;

function labelFor(platform) {
  return platforms.find(([key]) => key === platform)?.[1] || platform;
}

function requestPlatform(platform) {
  requestedPlatform = platform;
  if (switchingLoop) return;
  switchingLoop = (async () => {
    while (requestedPlatform) {
      const nextPlatform = requestedPlatform;
      requestedPlatform = null;
      switchingPlatform = nextPlatform;
      render(latestStatus);
      try {
        latestStatus = await window.workerTabs.selectPlatform(nextPlatform);
      } catch (error) {
        workerState.textContent = `切换失败：${error.message || '页面未打开'}`;
      }
      switchingPlatform = null;
      render(latestStatus);
    }
  })().finally(() => { switchingLoop = null; });
}

function render(status) {
  if (status) latestStatus = status;
  const active = status?.activePlatform || null;
  const states = new Map((status?.platforms || []).map((item) => [item.platform, item]));
  const tabs = platforms.map(([platform, label]) => {
    const button = document.createElement('button');
    const state = states.get(platform);
    button.type = 'button';
    button.className = `tab${state?.created ? ' loaded' : ''}${active === platform ? ' active' : ''}${switchingPlatform === platform ? ' switching' : ''}`;
    button.textContent = label;
    button.title = state?.url || `打开${label}`;
    button.disabled = Boolean(status?.busy && !switchingPlatform);
    button.addEventListener('click', () => requestPlatform(platform));
    return button;
  });
  tabList.replaceChildren(...tabs);
  const available = platforms.filter(([platform]) => !states.get(platform)?.created);
  newTabSelect.replaceChildren(new Option('选择平台', ''), ...available.map(([platform, label]) => new Option(label, platform)));
  newTabSelect.disabled = available.length === 0;
  workerState.textContent = switchingPlatform
    ? `正在切换到${labelFor(switchingPlatform)}`
    : status?.busy ? `正在执行 ${active || ''}` : 'Worker 就绪';
}

newTabSelect.addEventListener('change', () => {
  const platform = newTabSelect.value;
  newTabSelect.value = '';
  if (platform) requestPlatform(platform);
});

window.workerTabs.onStatus(render);
window.workerTabs.requestStatus().then(render).catch(() => undefined);
