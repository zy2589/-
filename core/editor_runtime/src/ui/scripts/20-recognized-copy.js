      $('renameCurrentProject').onclick = async () => {
        const id=state.projectId;
        if (!id) return;
        const input=await openRenameProjectDialog(state.projectName || '未命名工程');
        if (input===null) return;
        const name=input.trim().slice(0,80);
        if (!name) { toast('工程名称不能为空'); return; }
        const button=$('renameCurrentProject'); button.disabled=true;
        try {
          await flushAutoSave();
          if (state.projectId!==id) return;
          const result=await nativeCall('renameProject',{projectId:id,name});
          if (state.projectId===id) {
            state.projectName=result.name;
            $('projectName').textContent=result.name;
            $('projectName').title=result.name;
            queueAutosave();
          }
          window.__projectItems=(window.__projectItems || []).map(item=>item.id===id?{...item,name:result.name}:item);
          toast('工程名称已修改');
        } catch(error) {toast(error.message);}
        finally {button.disabled=false;}
      };
      renderRecognizedCopy();
      async function copyRecognizedText(id) {
        const field=$(id), text=String(field?.value || '');
        if (!text.trim()) { toast('暂无可复制的文案'); return; }
        try {
          if (!navigator.clipboard?.writeText) throw new Error('clipboard unavailable');
          await navigator.clipboard.writeText(text);
        } catch {
          const active=document.activeElement;
          field.focus(); field.select();
          let copied=false;
          try { copied=document.execCommand('copy'); } catch {}
          active?.focus?.();
          if (!copied) { toast('复制失败，请选中文案后按 Ctrl+C'); return; }
        }
        toast('已复制全文');
      }
      function clearRecognizedText() {
        state.recognizedText='';
        state.recognizedTextCleared=true;
        renderRecognizedCopy();
        queueAutosave();
        toast('已清空识别文案，字幕保持不变');
      }
      document.querySelectorAll('[data-copy-recognized]').forEach(button => {
        button.onclick=()=>copyRecognizedText(button.dataset.copyRecognized);
      });
      document.querySelectorAll('[data-clear-recognized]').forEach(button => {
        button.onclick=clearRecognizedText;
      });
