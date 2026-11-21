      let homeSearchTimer;
      function resetHomeFilter() {
        homeSelected.clear(); homeOffset = 0;
        $('homeBefore').hidden = $('homePeriod').value !== 'custom';
        refreshHome();
      }
      $('homeSearch').oninput = () => { clearTimeout(homeSearchTimer); homeSelected.clear(); updateHomeSelection(); ++homeRequest; homeSearchTimer = setTimeout(resetHomeFilter,250); };
      $('homePeriod').onchange = resetHomeFilter;
      $('homeBefore').onchange = resetHomeFilter;
      $('homePrevious').onclick = () => { homeOffset = Math.max(0,homeOffset-40); refreshHome(); };
      $('homeNext').onclick = () => { homeOffset += 40; refreshHome(); };
      $('homeBatchDelete').onclick = () => { homeSelectionMode = true; resetHomeFilter(); };
      $('homeCancelSelection').onclick = () => { homeSelectionMode = false; resetHomeFilter(); };
      $('homeSelectNone').onclick = () => { homeSelected.clear(); updateHomeSelection(); };
      $('homeSelectAll').onclick = async () => {
        const revision = homeRequest;
        try {
          const result = await nativeCall('queryProjects',{...homeQuery(),idsOnly:true});
          if (revision !== homeRequest || !homeSelectionMode) return;
          homeSelected.clear();
          for (const item of result.selection) if (Number.isFinite(Date.parse(item.updatedAt)) && Date.parse(item.updatedAt)<=Date.now()) homeSelected.set(item.id,item.updatedAt);
          updateHomeSelection();
        } catch(error) { toast(error.message); }
      };
      const singleHomeClick = $('homeProjectGrid').onclick;
      $('homeProjectGrid').onclick = event => {
        if (homeBusy) return;
        if (!homeSelectionMode) return singleHomeClick(event);
        const card=event.target.closest('[data-project-id]');
        if (!card) return;
        const item=(window.__projectItems||[]).find(item=>item.id===card.dataset.projectId);
        if (!item || !Number.isFinite(Date.parse(item.updatedAt)) || Date.parse(item.updatedAt)>Date.now()) { toast('工程时间异常，请先检查工程'); updateHomeSelection(); return; }
        if (homeSelected.has(item.id)) homeSelected.delete(item.id); else homeSelected.set(item.id,item.updatedAt);
        updateHomeSelection();
      };
      $('homeDeleteSelected').onclick = () => {
        if (homeBusy || !homeSelected.size) return;
        const chosen = [...homeSelected].map(([id,updatedAt])=>({id,updatedAt}));
        askConfirm(`确定永久删除选中的 ${chosen.length} 个工程吗？工程文件、媒体副本、自动保存历史和工程专属缓存都会删除，无法恢复。`,async () => {
          homeBusy = true; updateHomeSelection();
          let succeeded=0, cleanupFailures=0, cleanupPending=0; const failed=[];
          try {
            for (const item of chosen) {
              try {
                if (state.editorActive && state.projectId === item.id) throw Error('工程正在打开');
                const result = await nativeCall('deleteSelectedProject',{...item,permanent:true});
                if (!result) throw Error('工程不存在或已删除');
                cleanupFailures += Number(result.cacheCleanupFailures || 0);
                cleanupPending += Number(result.cleanupPending === true);
                window.removeOpenProjectTab?.(item.id);
                succeeded++; homeSelected.delete(item.id);
              } catch(error) { failed.push(error.message); }
              $('homeSelectedCount').textContent = '正在删除 '+(succeeded+failed.length)+' / '+chosen.length;
            }
          } finally { homeBusy=false; updateHomeSelection(); await refreshHome(); }
          toast('已从列表移除 '+succeeded+' 个工程，后台清理 '+cleanupPending+' 个；缓存未清理 '+cleanupFailures+' 个；失败 '+failed.length+' 个'+(failed.length?'：'+[...new Set(failed)].join('；'):''));
        },'永久删除工程');
      };
      let homeCacheTicket = null;
      function updateCacheButton(label = '清理缓存') {
        $('homeCleanCache').textContent = label;
        $('homeCleanCache').disabled = homeBusy || homeCacheBusy;
      }
      function cleanupSize(bytes) {
        const value=Number(bytes)||0;
        return value>=1024*1024*1024?(value/1024/1024/1024).toFixed(2)+' GB':(value/1024/1024).toFixed(2)+' MB';
      }
      function closeHomeCleanupModal() {
        $('homeCleanupModal').classList.remove('on');
        homeCacheTicket=null;
        homeCacheBusy=false;
        updateCacheButton();
      }
      $('homeCleanupCancel').onclick = closeHomeCleanupModal;
      $('homeCleanupConfirm').onclick = () => {
        const ticket=homeCacheTicket;
        if (!ticket) return;
        const categories=[];
        if ($('homeCleanupCaches').checked) categories.push('caches');
        if ($('homeCleanupPackages').checked) categories.push('packages');
        const includeProjects=$('homeCleanupProjects').checked;
        if (!categories.length&&!includeProjects) { toast('请先选择要清理的内容'); return; }
        const projectItems=includeProjects?ticket.projects:[];
        const selectedLines=[];
        if (categories.includes('caches')) selectedLines.push('可再生缓存 '+ticket.categories.caches.count+' 个文件（'+cleanupSize(ticket.categories.caches.bytes)+'）');
        if (categories.includes('packages')) selectedLines.push('旧版本包和打包暂存 '+ticket.categories.packages.count+' 个文件（'+cleanupSize(ticket.categories.packages.bytes)+'）');
        if (includeProjects) selectedLines.push('永久删除 '+projectItems.length+' 个工程及其媒体副本和自动保存历史');
        closeHomeCleanupModal();
        askConfirm('将执行以下清理：\n\n'+selectedLines.join('\n')+'\n\n当前安装版、当前发布目录、登录资料、设置、凭据和源素材会保留。'+(includeProjects?'\n\n工程删除后无法恢复。':''),async () => {
          homeCacheBusy=true;
          if (includeProjects) homeBusy=true;
          updateCacheButton('清理中…');
          let cacheResult=null,projectDeleted=0,projectFailed=0,projectPending=0;
          const failures=[];
          try {
            if (categories.length) {
              try { cacheResult=await nativeCall('cleanSafeCache',{token:ticket.token,categories}); }
              catch(error) { failures.push('缓存/旧包：'+error.message); }
            }
            if (includeProjects) {
              if (state.editorActive) {
                projectFailed=projectItems.length;
                failures.push('请先关闭当前工程再删除工程数据');
              } else {
                for (const item of projectItems) {
                  try {
                    const result=await nativeCall('deleteSelectedProject',{id:item.id,updatedAt:item.updatedAt,permanent:true});
                    if (!result) throw Error('工程不存在或已更新');
                    projectDeleted++;
                    projectPending+=Number(result.cleanupPending===true);
                  } catch(error) { projectFailed++; failures.push(error.message); }
                }
              }
            }
            const parts=[];
            if (cacheResult) parts.push('释放 '+cleanupSize(cacheResult.bytes)+'，移除缓存 '+cacheResult.cacheRemoved+' 个、旧包/暂存 '+cacheResult.packageRemoved+' 个');
            if (includeProjects) parts.push('永久删除工程 '+projectDeleted+' 个，后台清理 '+projectPending+' 个，失败 '+projectFailed+' 个');
            if (cacheResult?.skipped) parts.push('另有 '+cacheResult.skipped+' 个文件因正在使用或发生变化而跳过');
            if (cacheResult?.unreadableProjects) parts.push('有 '+cacheResult.unreadableProjects+' 个工程文件无法校验，相关预览缓存已跳过');
            if (failures.length) parts.push('问题：'+[...new Set(failures)].join('；'));
            toast(parts.join('；')||'没有清理任何项目');
          } finally {
            if (includeProjects) homeBusy=false;
            homeCacheBusy=false;
            updateCacheButton();
            if (includeProjects) await refreshHome();
          }
        },includeProjects?'永久删除工程并清理':'清理所选内容');
      };
      $('homeCleanCache').onclick = async () => {
        if (homeCacheBusy || homeBusy) return;
        homeCacheBusy=true; updateCacheButton('统计中…');
        toast('正在后台统计缓存、旧版本包和工程数据');
        try {
          const [result,projectResult]=await Promise.all([
            nativeCall('scanSafeCache'),
            nativeCall('queryProjects',{period:'all',idsOnly:true}),
          ]);
          const categories=result.categories||{caches:{bytes:result.bytes||0,count:result.count||0},packages:{bytes:0,count:0}};
          const projects=Array.isArray(projectResult.selection)?projectResult.selection:[];
          if (!categories.caches.count&&!categories.packages.count&&!projects.length) {
            toast(result.unreadableProjects
              ? '发现 '+result.unreadableProjects+' 个无法校验的工程文件，已跳过相关预览缓存；没有其他可安全清理的内容。'
              : '没有可清理的旧包、过期缓存或工程');
            return;
          }
          homeCacheTicket={...result,categories,projects};
          const cacheChoice=$('homeCleanupCaches');
          cacheChoice.checked=categories.caches.count>0;
          cacheChoice.disabled=categories.caches.count===0;
          $('homeCleanupCachesDetail').textContent=categories.caches.count
            ? categories.caches.count+' 个文件 · '+cleanupSize(categories.caches.bytes)+'（预览、转写、临时、WebView 和 Python 字节码缓存）'
            : '没有可清理的过期缓存';
          const packageChoice=$('homeCleanupPackages');
          packageChoice.checked=categories.packages.count>0;
          packageChoice.disabled=categories.packages.count===0;
          $('homeCleanupPackagesDetail').textContent=categories.packages.count
            ? categories.packages.count+' 个文件 · '+cleanupSize(categories.packages.bytes)+'（过期发布包和打包/诊断暂存；保留最新发布包与当前发布目录）'
            : '没有发现旧发布包或打包暂存';
          const projectChoice=$('homeCleanupProjects');
          projectChoice.checked=false;
          projectChoice.disabled=projects.length===0;
          $('homeCleanupProjectsDetail').textContent=projects.length
            ? '永久删除全部 '+projects.length+' 个工程及其媒体副本、自动保存历史，无法恢复。'
            : '没有可删除的工程；删除工程不会删除 Downloads 中的源视频。';
          $('homeCleanupModal').classList.add('on');
        } catch(error) { toast(error.message); }
        finally {
          if ($('homeCleanupModal').classList.contains('on')) updateCacheButton('已统计');
          else { homeCacheBusy=false; updateCacheButton(); }
        }
      };
      // The project home is the initial screen in the integrated shell. It
      // used to wait for Back or New Project before querying the local store,
      // which left the first launch looking like an empty/blank editor page.
      window.__refreshProjectHome = refreshHome;
      requestAnimationFrame(() => refreshHome());
