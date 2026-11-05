import type { WebContents } from 'electron';
import { normalizeArticleTags } from '../shared/article-document.js';
import { chooseZhihuTopic, zhihuTopicSearchQueries } from './zhihu-topic-matching.js';

export interface ZhihuTopicSelection {
  requested: string;
  selected: string;
  match: 'exact' | 'related';
  query: string;
  reason: string;
}

export interface ZhihuTopicFailure {
  requested: string;
  code: 'FIELD_NOT_FOUND' | 'ADD_UNAVAILABLE' | 'INPUT_UNAVAILABLE' | 'INPUT_FOCUS_FAILED'
    | 'INPUT_WRITE_FAILED' | 'SEARCH_RESET_FAILED' | 'CANDIDATE_UNAVAILABLE'
    | 'SELECTION_UNVERIFIED' | 'NO_MATCH' | 'OPERATION_FAILED' | 'NOT_ATTEMPTED';
  message: string;
}

export interface ZhihuTopicsResult {
  topicFailures: ZhihuTopicFailure[];
  topicSelections: ZhihuTopicSelection[];
  topicsRequested: string[];
  topicsApplied: string[];
  topicsUnmatched: string[];
  topicsVerified: boolean;
  topicWarnings: string[];
}

// Runs in the page. Use the native field and its removable selected values,
// never the #tags in the editor or the text of a search suggestion as evidence.
function inspectTopics(action: 'read' | 'add' | 'focus' | 'match' | 'cancel' | 'blur' | 'remove', topic = '', candidateName = '') {
  const normalize = (value: string) => value.replace(/[\u200b-\u200d\ufeff]/g, '').replace(/\s+/g, ' ').trim();
  const text = (element: Element) => normalize(element.textContent || '');
  const visible = (element: Element) => {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
  };
  const controls = 'button,[role="button"]';
  const searchSelector = 'input[placeholder*="搜索话题"],input[aria-label="搜索话题"]';
  const labels = [...document.querySelectorAll('body *')].filter(element => visible(element)
    && normalize([...element.childNodes].filter(node => node.nodeType === Node.TEXT_NODE)
      .map(node => node.textContent || '').join('')) === '文章话题');
  const isAdd = (element: Element) => /^\+?\s*添加话题$/.test(text(element));
  const buttons = [...document.querySelectorAll(controls)];
  const search = [...document.querySelectorAll<HTMLInputElement>(searchSelector)].find(visible);
  const add = buttons.find(element => visible(element) && isAdd(element));
  const safeScope = (element: Element) => element !== document.body
    && !element.querySelector('[contenteditable="true"],textarea')
    && !/创作声明|定时发布|内容来源/.test(text(element));
  const selectedControlsIn = (scope: Element) => {
    const values: Array<{ name: string; remove: Element }> = [];
    for (const remove of scope.querySelectorAll(controls)) {
      if (!visible(remove) || text(remove) || remove.getAttribute('aria-label') === '文章话题') continue;
      let wrapper = remove.parentElement;
      for (let depth = 0; wrapper && wrapper !== scope && depth < 4; depth++, wrapper = wrapper.parentElement) {
        if (wrapper.querySelector('input')) break;
        const value = text(wrapper);
        if (value && !/添加话题|文章话题/.test(value) && wrapper.querySelectorAll(controls).length === 1) {
          values.push({ name: value, remove }); break;
        }
      }
    }
    return values;
  };
  const selectedIn = (scope: Element) => [...new Set(selectedControlsIn(scope).map(value => value.name))];
  // The last free slot replaces (rather than accompanies) “添加话题”. Start
  // from the live search input, and widen to include its sibling selected chips.
  // Never widen into other publishing fields or the article editor.
  let row: Element | null = null;
  const anchor = search || add || buttons.find(isAdd);
  if (anchor) {
    for (let parent = anchor.parentElement, depth = 0; parent && depth < 12; parent = parent.parentElement, depth++) {
      if (!safeScope(parent)) break;
      row = parent;
      if (labels.some(label => parent.contains(label))) break;
    }
  }
  // With every slot selected there may be neither an input nor an add button.
  // Support both a wrapped field and a label/control pair in a flat settings grid.
  if (!row) {
    for (const label of labels) {
      for (let parent: Element | null = label, depth = 0; parent && depth < 8; parent = parent.parentElement, depth++) {
        const sibling = parent.nextElementSibling;
        if (sibling && safeScope(sibling) && selectedIn(sibling).length) { row = sibling; break; }
        if (!safeScope(parent)) break;
        if (selectedIn(parent).length) { row = parent; break; }
      }
      if (row) break;
    }
  }
  const empty = { found: false, selected: [] as string[], candidates: [] as string[], input: false,
    inputValue: null as string | null, focused: false, addVisible: false, addDisabled: false,
    blockingPanelPoint: null as { x: number; y: number } | null,
    point: null as { x: number; y: number } | null };
  if (!row) return empty;
  const input = [...row.querySelectorAll<HTMLInputElement>(searchSelector)]
    .find(element => visible(element) && !element.disabled && !element.readOnly);
  const selected = selectedIn(row);
  const addControl = [...row.querySelectorAll(controls)].find(element => visible(element) && isAdd(element));
  const result = { ...empty, found: true, selected, input: Boolean(input), inputValue: input?.value ?? null,
    addVisible: Boolean(addControl), addDisabled: Boolean(addControl?.matches(':disabled,[aria-disabled="true"]')) };
  const pointFor = (element?: Element) => {
    if (!(element instanceof HTMLElement) || element.matches(':disabled,[aria-disabled="true"]')) return null;
    element.scrollIntoView({ behavior: 'instant', block: 'center', inline: 'nearest' });
    const rect = element.getBoundingClientRect();
    const point = { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
    const hit = document.elementFromPoint(point.x, point.y);
    if (hit && element.contains(hit)) return point;
    // The fixed creation assistant can cover the last slot's close button.
    // Return its actual close control for a native click; never click through
    // an overlay or remove a selected chip as a substitute for closing search.
    const close = [...document.querySelectorAll('button[aria-label="关闭创作助手"]')].find(visible);
    if (hit && close) {
      for (let panel = close.parentElement, depth = 0; panel && depth < 8; panel = panel.parentElement, depth++) {
        if (panel.contains(element)) break;
        if (!panel.contains(hit)) continue;
        const bounds = close.getBoundingClientRect();
        const closePoint = { x: Math.round(bounds.left + bounds.width / 2), y: Math.round(bounds.top + bounds.height / 2) };
        const closeHit = document.elementFromPoint(closePoint.x, closePoint.y);
        if (closeHit && close.contains(closeHit)) result.blockingPanelPoint = closePoint;
        break;
      }
    }
    return null;
  };
  if (action === 'add') result.point = pointFor(addControl);
  if (action === 'remove') {
    const targets = selectedControlsIn(row).filter(value => value.name === topic);
    if (targets.length === 1) result.point = pointFor(targets[0]!.remove);
  }
  if (action === 'focus' && input) {
    input.scrollIntoView({ behavior: 'instant', block: 'center', inline: 'nearest' });
    input.focus(); input.select();
    result.focused = document.activeElement === input;
  }
  if (action === 'blur' && input) input.blur();
  if (action === 'cancel' && input) {
    let wrapper = input.parentElement;
    for (let depth = 0; wrapper && wrapper !== row && depth < 4; depth++, wrapper = wrapper.parentElement) {
      const remove = [...wrapper.querySelectorAll(controls)].find(element => visible(element) && !text(element));
      if (remove) { result.point = pointFor(remove); break; }
    }
  }
  if (input && input.value === topic) {
    const inputRect = input.getBoundingClientRect();
    const matches = [...document.querySelectorAll('button,[role="button"],[role="option"]')].filter(element => {
      if (!visible(element) || !text(element) || row!.contains(element)) return false;
      const rect = element.getBoundingClientRect();
      return rect.right > inputRect.left && rect.left < inputRect.right &&
        rect.top >= inputRect.bottom - 2 && rect.top < inputRect.bottom + 650;
    });
    // Some layouts render the popup inside the row instead of a portal.
    const inline = [...row.querySelectorAll('button,[role="button"],[role="option"]')].filter(element => {
      const rect = element.getBoundingClientRect();
      return visible(element) && text(element) && !element.parentElement?.querySelector(searchSelector)
        && rect.right > inputRect.left && rect.left < inputRect.right
        && rect.top >= inputRect.bottom - 2 && rect.top < inputRect.bottom + 650;
    });
    const candidates = [...matches, ...inline].filter(element => !selected.includes(text(element)));
    result.candidates = [...new Set(candidates.map(text))];
    const target = candidates.filter(element => text(element) === candidateName);
    if (action === 'match' && target.length === 1) result.point = pointFor(target[0]);
  }
  return result;
}

export async function fillZhihuTopics(webContents: WebContents, tags: readonly string[], articleText = ''): Promise<ZhihuTopicsResult> {
  const topicsRequested = normalizeArticleTags(tags, 9);
  const topicWarnings: string[] = [];
  const topicFailures: ZhihuTopicFailure[] = [];
  const selections: ZhihuTopicSelection[] = [];
  const read = (action: Parameters<typeof inspectTopics>[0], topic = '', candidateName = '') =>
    webContents.executeJavaScript(`(${inspectTopics.toString()})(${JSON.stringify(action)},${JSON.stringify(topic)},${JSON.stringify(candidateName)})`) as Promise<ReturnType<typeof inspectTopics>>;
  const pause = () => new Promise(resolve => setTimeout(resolve, 250));
  const click = async (point: { x: number; y: number } | null) => {
    if (!point) return false;
    const debuggerApi = webContents.debugger;
    const attachedHere = !debuggerApi.isAttached();
    if (attachedHere) debuggerApi.attach('1.3');
    try {
      for (const type of ['mousePressed', 'mouseReleased']) {
        await debuggerApi.sendCommand('Input.dispatchMouseEvent', { type, ...point, button: 'left', clickCount: 1 });
      }
    } finally { if (attachedHere && debuggerApi.isAttached()) debuggerApi.detach(); }
    return true;
  };
  const inspect = async (action: Parameters<typeof inspectTopics>[0], topic = '', candidateName = '') => {
    let state = await read(action, topic, candidateName);
    if (state.blockingPanelPoint && await click(state.blockingPanelPoint)) {
      for (let attempt = 0; attempt < 8; attempt++) {
        await pause(); state = await read(action, topic, candidateName);
        if (state.point) break;
      }
    }
    return state;
  };
  if (!topicsRequested.length) return { topicsRequested, topicsApplied: [], topicsUnmatched: [], topicsVerified: true, topicWarnings, topicFailures, topicSelections: [] };
  const record = (requested: string, selected: string, query: string, reason: string) => selections.push({
    requested, selected, query, reason,
    match: reason === '同名匹配' ? 'exact' : 'related',
  });
  const fail = (requested: string, code: ZhihuTopicFailure['code'], message: string) => {
    if (topicFailures.some(failure => failure.requested === requested)) return;
    topicFailures.push({ requested, code, message });
    topicWarnings.push(`“${requested}”：${message}`);
  };
  const cancelSearch = async () => {
    const state = await inspect('cancel');
    if (!state.input) return true;
    if (!await click(state.point)) return false;
    for (let attempt = 0; attempt < 12; attempt++) {
      await pause();
      if (!(await inspect('read')).input) return true;
    }
    return false;
  };
  // A fill replaces the article, so its native topics must also be replaced.
  // Do not reuse a previous article's selected/recommended topics, even when
  // the editor URL is unchanged. Only native remove clicks count as cleanup.
  const clearOldTopics = async () => {
    const stop = (message: string, remaining: string[] = []): never => {
      throw Object.assign(new Error(`ZHIHU_TOPICS_CLEAR_FAILED: ${message}；已停止填写和发布`), {
        details: { topicsRequested, topicsRemaining: remaining },
      });
    };
    if (!await cancelSearch()) stop('未能关闭旧话题搜索框');
    let state = await inspect('read');
    if (!state.found) stop('未识别到文章话题区域，无法确认旧话题已清空');
    // Bounded even if the platform unexpectedly keeps re-adding suggestions.
    for (let removed = 0; removed < 12 && state.selected.length; removed++) {
      const oldTopic = state.selected[0]!;
      if (!await click((await inspect('remove', oldTopic)).point)) {
        stop(`无法点击旧话题“${oldTopic}”的删除按钮`, state.selected);
      }
      let stable = 0;
      for (let attempt = 0; attempt < 16; attempt++) {
        await pause(); state = await inspect('read');
        stable = state.found && !state.selected.includes(oldTopic) ? stable + 1 : 0;
        if (stable >= 3) break;
      }
      if (stable < 3) stop(`删除后仍未确认旧话题“${oldTopic}”已移除`, state.selected);
    }
    if (!state.found || state.selected.length) stop('旧话题未清空', state.selected);
  };
  await clearOldTopics();
  const fillOne = async (topic: string) => {
    let state = await inspect('read');
    if (!state.found) { fail(topic, 'FIELD_NOT_FOUND', '未识别到文章话题区域，尚未搜索'); return; }
    const existing = chooseZhihuTopic(topic, state.selected, '');
    if (existing?.reason === '同名匹配') { record(topic, existing.selected, topic, existing.reason); return; }
    const queries = zhihuTopicSearchQueries(topic);
    for (const [index, query] of queries.entries()) {
      // A retry gets a fresh slot so a previous query's late suggestions cannot
      // become evidence. An already open input is usable even without an add button.
      if (index && !await cancelSearch()) {
        fail(topic, 'SEARCH_RESET_FAILED', '未能关闭上一次话题搜索框，已停止切换关键词'); return;
      }
      state = await inspect('read');
      if (!state.input) {
        const entry = await inspect('add');
        if (!await click(entry.point)) {
          const related = chooseZhihuTopic(topic, state.selected, articleText);
          if (related) record(topic, related.selected, query, related.reason);
          else if (!entry.found) fail(topic, 'FIELD_NOT_FOUND', '未识别到文章话题区域，搜索未完成');
          else fail(topic, 'ADD_UNAVAILABLE', entry.addVisible
            ? `添加话题按钮${entry.addDisabled ? '已禁用' : '无法点击，可能被遮挡'}（当前已选 ${state.selected.length} 个），搜索未完成`
            : `页面未提供添加话题入口（当前已选 ${state.selected.length} 个），无法继续添加；未确认是否达到数量上限`);
          return;
        }
        for (let attempt = 0; attempt < 12; attempt++) {
          await pause(); state = await inspect('read'); if (state.input) break;
        }
      }
      state = await inspect('focus');
      if (!state.input) { fail(topic, 'INPUT_UNAVAILABLE', '点击添加话题后未识别到可用搜索框，尚未输入关键词'); return; }
      if (!state.focused) { fail(topic, 'INPUT_FOCUS_FAILED', '已找到话题搜索框，但未能获得输入焦点，尚未输入关键词'); return; }
      await webContents.insertText(query);
      for (let attempt = 0; attempt < 4; attempt++) {
        await pause(); state = await inspect('read', query); if (state.inputValue === query) break;
      }
      if (state.inputValue !== query) { fail(topic, 'INPUT_WRITE_FAILED', '未确认关键词已写入话题搜索框，搜索未完成'); return; }
      let previous = '', stable = 0;
      for (let attempt = 0; attempt < 24; attempt++) {
        await pause(); state = await inspect('read', query);
        const signature = JSON.stringify(state.candidates);
        stable = signature === previous ? stable + 1 : 0; previous = signature;
        const exact = chooseZhihuTopic(topic, state.candidates, '');
        if (exact?.reason === '同名匹配') break;
        if (attempt >= 7 && stable >= 3 && state.candidates.length) break;
      }
      if (!state.input || state.inputValue !== query) {
        fail(topic, 'INPUT_UNAVAILABLE', '搜索过程中输入框消失或关键词发生变化，搜索未完成'); return;
      }
      const choice = chooseZhihuTopic(topic, [...state.candidates, ...state.selected], articleText);
      if (!choice) continue;
      if (!state.selected.includes(choice.selected)) {
        if (!await click((await inspect('match', query, choice.selected)).point)) {
          fail(topic, 'CANDIDATE_UNAVAILABLE', `找到候选“${choice.selected}”，但无法点击，未确认选中`); return;
        }
        await inspect('blur');
        for (let attempt = 0; attempt < 12; attempt++) {
          await pause(); state = await inspect('read'); if (state.selected.includes(choice.selected)) break;
        }
      }
      if (state.selected.includes(choice.selected)) {
        record(topic, choice.selected, query, choice.reason); return;
      }
      // Do not try another candidate after an unverified click: a late response
      // could otherwise add two topics for one requested tag.
      fail(topic, 'SELECTION_UNVERIFIED', `点击“${choice.selected}”后未确认选中`); return;
    }
    fail(topic, 'NO_MATCH', `已搜索“${queries.join('”“')}”，等待后未获得可确认的同名或相关候选`);
  };
  for (const [index, topic] of topicsRequested.entries()) {
    try {
      await fillOne(topic);
      await cancelSearch();
    } catch (error) {
      fail(topic, 'OPERATION_FAILED', `话题操作异常：${error instanceof Error ? error.message : String(error)}`);
      for (const remaining of topicsRequested.slice(index + 1)) fail(remaining, 'NOT_ATTEMPTED', '前一步话题操作异常，尚未尝试填写');
      break;
    }
  }
  let selected: string[] = [];
  try { selected = (await inspect('read')).selected; }
  catch { /* Final readback failures must not be reported as verified selections. */ }
  const topicSelections = selections.filter(selection => selected.includes(selection.selected));
  for (const selection of selections) {
    if (!selected.includes(selection.selected)) fail(selection.requested, 'SELECTION_UNVERIFIED', `最终核对时未确认“${selection.selected}”仍为已选话题`);
  }
  const topicsApplied = [...new Set(topicSelections.map(selection => selection.selected))];
  const topicsUnmatched = topicsRequested.filter(topic => !topicSelections.some(selection => selection.requested === topic));
  return { topicsRequested, topicsApplied, topicsUnmatched, topicsVerified: topicsUnmatched.length === 0, topicWarnings, topicFailures, topicSelections };
}
