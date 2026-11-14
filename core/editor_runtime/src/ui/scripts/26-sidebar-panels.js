      (async function restoreSidebarPanels() {
        const panels = [...document.querySelectorAll('.persistent-sidebar-panel')];
        const touched = new Set();
        let queue = Promise.resolve();
        for (const panel of panels) {
          panel.addEventListener('toggle', () => {
            if (panel.open === (panel.dataset.savedOpen === 'true')) return;
            touched.add(panel.id);
            panel.dataset.savedOpen = String(panel.open);
            const change = { [panel.id]: panel.open };
            queue = queue.then(() => nativeCall('saveSidebarPanels', change)).catch(error => {
              console.error('保存面板状态失败', error);
              toast('面板状态保存失败，请重新展开或收起再试');
            });
          });
          panel.dataset.savedOpen = String(panel.open);
        }
        try {
          const saved = await nativeCall('loadSidebarPanels');
          if(!localStorage.getItem('caption-settings-folded-2.12.72-v2')){
            saved.speechEnginePanel=false;
            await nativeCall('saveSidebarPanels',{speechEnginePanel:false});
            localStorage.setItem('caption-settings-folded-2.12.72-v2','1');
          }
          for (const panel of panels) {
            if (touched.has(panel.id)) continue;
            const open=typeof saved[panel.id]==='boolean'?saved[panel.id]:panel.open;
            panel.dataset.savedOpen = String(open);
            panel.open = open;
          }
        } catch (error) { console.error('读取面板状态失败', error); }
      })();
