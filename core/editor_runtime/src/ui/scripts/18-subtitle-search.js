      function findSubtitleMatches(captions, query) {
        const needle = String(query || "").trim().toLowerCase();
        return needle ? captions.filter(caption => String(caption.text || "").toLowerCase().includes(needle))
          .sort((a, b) => Number(a.start) - Number(b.start)) : [];
      }
      function openSubtitleSearch() {
        let dialog = $("subtitleSearchDialog");
        if (!dialog) {
          dialog = document.createElement("dialog");
          dialog.id = "subtitleSearchDialog";
          dialog.setAttribute("aria-label", "搜索字幕");
          dialog.innerHTML = `<form method="dialog"><strong>搜索字幕 · Shift+F</strong><button aria-label="关闭搜索">关闭</button></form>
            <input class="input" type="search" id="subtitleSearchInput" aria-label="字幕关键词" placeholder="输入字幕关键词" />
            <p id="subtitleSearchStatus" role="status"></p>
            <div class="subtitle-search-nav"><button type="button" id="subtitleSearchPrevious">上一条</button><button type="button" id="subtitleSearchNext">下一条</button><span>Enter 下一条 · Shift+Enter 上一条 · Esc 关闭</span></div>
            <div id="subtitleSearchResults"></div>`;
          document.body.appendChild(dialog);
          let matches = [], index = -1;
          const refresh = () => {
            matches = findSubtitleMatches(state.captions, $("subtitleSearchInput").value);
            index = -1;
            $("subtitleSearchStatus").textContent = !$("subtitleSearchInput").value.trim() ? "请输入关键词" : matches.length ? `找到 ${matches.length} 条字幕` : "没有匹配的字幕";
            $("subtitleSearchPrevious").disabled = $("subtitleSearchNext").disabled = !matches.length;
            $("subtitleSearchResults").replaceChildren(...matches.map((caption, position) => {
              const button = document.createElement("button");
              button.type = "button";
              button.textContent = `${formatTime(caption.start, false)}　${caption.text}`;
              button.onclick = () => jump(position);
              return button;
            }));
          };
          const jump = position => {
            if (!matches.length) return;
            index = (position + matches.length) % matches.length;
            const caption = state.captions.find(item => item.id === matches[index].id);
            if (!caption) { refresh(); return; }
            state.selected = { type: "caption", id: caption.id };
            state.selectedItems = [state.selected];
            seekTimeline(Number(caption.start));
            renderTimeline();
            updateInspector();
            renderCaptionInspector(true);
            $("subtitleSearchStatus").textContent = `第 ${index + 1} / ${matches.length} 条字幕`;
            Array.from($("subtitleSearchResults").children).forEach((button, i) => {
              button.classList.toggle("active", i === index);
              if (i === index) button.scrollIntoView({ block: "nearest" });
            });
          };
          $("subtitleSearchInput").oninput = refresh;
          $("subtitleSearchPrevious").onclick = () => jump(index < 0 ? matches.length - 1 : index - 1);
          $("subtitleSearchNext").onclick = () => jump(index + 1);
          dialog.addEventListener("keydown", event => {
            if (event.isComposing) return;
            if (event.key === "Enter" && event.target === $("subtitleSearchInput")) {
              event.preventDefault();
              jump(event.shiftKey ? (index < 0 ? matches.length - 1 : index - 1) : index + 1);
            }
          });
          dialog.refreshSearch = refresh;
        }
        dialog.refreshSearch();
        if (!dialog.open) dialog.showModal();
        $("subtitleSearchInput").focus();
        $("subtitleSearchInput").select();
      }

