let openProjectTabs = [];
let projectTabSwitchBusy = false;

function renderOpenProjectTabs() {
  const bar = $('openProjectTabs');
  const strip = $('projectTabStrip');
  if (!bar || !strip) return;
  bar.replaceChildren();
  bar.hidden = !openProjectTabs.length;
  strip.hidden = !openProjectTabs.length;
  for (const project of openProjectTabs) {
    const active = state.editorActive && state.projectId === project.id;
    const wrapper = document.createElement('div');
    wrapper.className = `project-tab${active ? ' active' : ''}`;
    wrapper.setAttribute('role', 'presentation');
    const select = document.createElement('button');
    select.className = 'project-tab-select';
    select.type = 'button';
    select.setAttribute('role', 'tab');
    select.setAttribute('aria-selected', String(active));
    select.title = project.name;
    select.disabled = projectTabSwitchBusy;
    const name = document.createElement('span');
    name.className = 'project-tab-name';
    name.textContent = project.name || '未命名工程';
    select.append(name);
    select.onclick = () => { void activateOpenProjectTab(project.id); };
    const close = document.createElement('button');
    close.className = 'project-tab-close';
    close.type = 'button';
    close.textContent = '×';
    close.title = '关闭标签（不会删除工程）';
    close.setAttribute('aria-label', `关闭工程标签：${project.name || '未命名工程'}`);
    close.disabled = projectTabSwitchBusy;
    close.onclick = event => {
      event.preventDefault();
      event.stopPropagation();
      void closeOpenProjectTab(project.id);
    };
    wrapper.append(select, close);
    bar.append(wrapper);
  }
  updateProjectTabScrollControls();
  const reveal = bar.querySelector('.project-tab.active') || bar.lastElementChild;
  if (reveal) requestAnimationFrame(() => {
    if (!bar.clientWidth || !reveal.isConnected) return;
    const barRect = bar.getBoundingClientRect();
    const tabRect = reveal.getBoundingClientRect();
    if (tabRect.left < barRect.left) bar.scrollBy({ left: tabRect.left - barRect.left - 8, behavior: 'smooth' });
    else if (tabRect.right > barRect.right) bar.scrollBy({ left: tabRect.right - barRect.right + 8, behavior: 'smooth' });
    updateProjectTabScrollControls();
  });
}

function updateProjectTabScrollControls() {
  const bar = $('openProjectTabs');
  const previous = $('projectTabsPrev');
  const next = $('projectTabsNext');
  if (!bar || !previous || !next) return;
  const canScroll = bar.scrollWidth > bar.clientWidth + 1;
  previous.hidden = !canScroll || bar.scrollLeft <= 1;
  next.hidden = !canScroll || bar.scrollLeft + bar.clientWidth >= bar.scrollWidth - 1;
}

const openProjectTabScroller = $('openProjectTabs');
openProjectTabScroller?.addEventListener('scroll', updateProjectTabScrollControls, { passive: true });
window.addEventListener('resize', updateProjectTabScrollControls);
$('projectTabsPrev')?.addEventListener('click', () => {
  const bar = $('openProjectTabs');
  if (bar) bar.scrollBy({ left: -Math.max(200, Math.round(bar.clientWidth * 0.72)), behavior: 'smooth' });
});
$('projectTabsNext')?.addEventListener('click', () => {
  const bar = $('openProjectTabs');
  if (bar) bar.scrollBy({ left: Math.max(200, Math.round(bar.clientWidth * 0.72)), behavior: 'smooth' });
});
openProjectTabScroller?.addEventListener('wheel', event => {
  if (Math.abs(event.deltaY) > Math.abs(event.deltaX) && openProjectTabScroller.scrollWidth > openProjectTabScroller.clientWidth) {
    openProjectTabScroller.scrollLeft += event.deltaY;
    event.preventDefault();
  }
}, { passive: false });

function syncOpenProjectTab(id, name) {
  if (!id) return;
  const existing = openProjectTabs.find(project => project.id === id);
  if (existing) existing.name = name || existing.name || '未命名工程';
  else openProjectTabs.push({ id, name: name || '未命名工程' });
  renderOpenProjectTabs();
}

async function activateOpenProjectTab(id) {
  if (!id || id === state.projectId || projectTabSwitchBusy) return;
  if (!openProjectTabs.some(project => project.id === id)) return;
  if (window.mediaOperationBusy) {
    toast('请先完成当前素材处理，再切换工程');
    return;
  }
  projectTabSwitchBusy = true;
  renderOpenProjectTabs();
  try {
    if (state.playing && typeof togglePlay === 'function') await togglePlay();
    await flushAutoSave();
    const record = await nativeCall('loadProject', id);
    await enterProject(record);
  } catch (error) {
    toast(`切换工程失败：${error.message || error}`);
  } finally {
    projectTabSwitchBusy = false;
    renderOpenProjectTabs();
  }
}

async function closeOpenProjectTab(id) {
  if (projectTabSwitchBusy) return;
  const index = openProjectTabs.findIndex(project => project.id === id);
  if (index < 0) return;
  const isActive = state.editorActive && state.projectId === id;
  if (state.exportJobId && state.exportProjectId === id) {
    toast('该工程正在后台导出，导出完成前不能关闭它');
    return;
  }
  if (isActive) {
    if (window.mediaOperationBusy) {
      toast('请先完成当前素材处理，再关闭工程标签');
      return;
    }
    const next = openProjectTabs[index + 1] || openProjectTabs[index - 1];
    try {
      if (next) {
        await activateOpenProjectTab(next.id);
        if (state.projectId === id) return;
      } else {
        await backToHome();
      }
    } catch (error) {
      toast(`关闭工程标签失败：${error.message || error}`);
      return;
    }
  }
  openProjectTabs = openProjectTabs.filter(project => project.id !== id);
  renderOpenProjectTabs();
}

function removeOpenProjectTab(id) {
  if (state.editorActive && state.projectId === id) return;
  openProjectTabs = openProjectTabs.filter(project => project.id !== id);
  renderOpenProjectTabs();
}

window.syncOpenProjectTab = syncOpenProjectTab;
window.removeOpenProjectTab = removeOpenProjectTab;
