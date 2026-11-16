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
      $('homeCleanCache').onclick = async () => {
        if (homeCacheBusy || homeBusy) return;
        if (homeCacheTicket) {
          const ticket = homeCacheTicket;
          askConfirm('当前可清理缓存：'+(ticket.bytes/1048576).toFixed(2)+' MB。清理缓存不会删除工程文件，是否继续？',async () => {
            homeCacheTicket=null; homeCacheBusy=true; updateCacheButton('清理中…');
            try {
              const cleaned=await nativeCall('cleanSafeCache',ticket.token);
              const warning=cleaned.unreadableProjects?'；发现 '+cleaned.unreadableProjects+' 个无法校验的工程文件，已跳过媒体预览缓存以保护关联素材':'';
              toast('已释放 '+(cleaned.bytes/1048576).toFixed(2)+' MB；跳过 '+cleaned.skipped+' 个正在使用、已更新或受保护文件'+warning);
            } catch(error) { toast(error.message); }
            finally { homeCacheBusy=false; updateCacheButton(); }
          },'清理缓存');
          return;
        }
        homeCacheBusy=true; updateCacheButton('统计中…');
        toast('正在后台统计缓存，可以继续新建和编辑工程');
        try {
          const result=await nativeCall('scanSafeCache');
          if (!result.count) {
            toast(result.unreadableProjects
              ? '发现 '+result.unreadableProjects+' 个无法校验的工程文件。为保护工程关联素材，已跳过媒体预览缓存；没有其他可安全清理的过期缓存。'
              : '没有可安全清理的缓存');
            return;
          }
          homeCacheTicket=result;
          const warning=result.unreadableProjects
            ? '；另发现 '+result.unreadableProjects+' 个无法校验的工程文件，本次会跳过媒体预览缓存'
            : '';
          toast('缓存统计完成：'+(result.bytes/1048576).toFixed(2)+' MB。可在首页点击“确认清理”继续。'+warning);
        } catch(error) { toast(error.message); }
        finally { homeCacheBusy=false; updateCacheButton(homeCacheTicket?'确认清理':'清理缓存'); }
      };
      // The project home is the initial screen in the integrated shell. It
      // used to wait for Back or New Project before querying the local store,
      // which left the first launch looking like an empty/blank editor page.
      window.__refreshProjectHome = refreshHome;
      requestAnimationFrame(() => refreshHome());
