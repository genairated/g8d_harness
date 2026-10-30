    // Render file lists in Sidebar (Worktable core + manifest-driven sections)
    function renderSidebarLists() {
      const worktableTreeContainer = document.getElementById('worktable-tree');
      if (worktableTreeContainer) {
        worktableTreeContainer.innerHTML = '';
        const filteredWorktable = (statusData.worktable || []).filter(item => {
          if (item.type === 'file' && (item.name === 'DASHBOARD.md' || item.name === 'TASK.md' || item.name === 'README.md')) return false;
          return true;
        });
        renderTree(filteredWorktable, worktableTreeContainer, 0);
      }

      const dyn = document.getElementById('dynamic-sections');
      if (dyn) {
        dyn.innerHTML = '';
        (statusData.sections || []).forEach((sec, i) => {
          const secId = 'sec-dyn-' + i;
          const block = document.createElement('div');
          block.className = 'space-y-1';
          block.innerHTML = `
            <button onclick="toggleSection('${secId}')" title="${dgEsc(sec.label)}" class="w-full flex items-center justify-between px-3 py-2 text-[13px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider hover:text-slate-900 dark:hover:text-white hover:bg-slate-200/30 dark:hover:bg-slate-800/30 rounded-lg transition-all group">
              <span class="flex items-center space-x-2.5 min-w-0">
                <i data-lucide="${dgEsc(sec.icon || 'folder')}" class="h-4 w-4 text-slate-400 group-hover:text-cyan-600 dark:group-hover:text-cyan-400 flex-shrink-0"></i>
                <span class="tracking-wide sb-collapse-hide truncate">${dgEsc(sec.label)}</span>
              </span>
              <i data-lucide="chevron-down" id="arrow-${secId}" class="h-4 w-4 transform transition-transform -rotate-90 text-slate-400 group-hover:text-slate-600 dark:group-hover:text-white sb-collapse-hide"></i>
            </button>
            <div id="${secId}" class="mt-1 hidden sb-collapse-hide"><div class="dyn-tree nested-menu-container"></div></div>`;
          dyn.appendChild(block);
          renderTree(sec.tree || [], block.querySelector('.dyn-tree'), 0);
        });

        // P2 (SPEC-plugin-contract.md §3): workspace-contributed nav items, appended into the same
        // dynamic-sections area as the folder-tree sections above but rendered as single nav buttons
        // (a plugin contributes one view, not a browsable tree). Disabled (untrusted) plugins still
        // render so the reason is visible, per §6.
        // WSX2 (SPEC-workspace-settings.md §8.4): manifest.plugins.hidden entries still arrive here
        // flagged `hidden:true` (settings.js needs the full list) — the sidebar is the one place
        // that actually skips them.
        (statusData.plugins || []).forEach((pl, i) => {
          if (pl.hidden) return;
          const disabled = !pl.enabled;
          const btn = document.createElement('button');
          btn.className = 'w-full flex items-center space-x-2.5 px-3 py-2 text-[13px] font-semibold rounded-lg transition-all '
            + (disabled ? 'opacity-40 cursor-not-allowed text-slate-400' : 'text-slate-700 dark:text-slate-300 hover:text-slate-950 dark:hover:text-white hover:bg-slate-200/40 dark:hover:bg-slate-800/40');
          btn.title = disabled ? (pl.disabledReason || '未信任') : (pl.title || pl.name);
          btn.disabled = disabled;
          // WSXW (SPEC-workspace-settings.md §25/§29): the two-dimension model — openIn
          // (embed|tab) × target (internal|external), 2x2 crossed. Server (/api/status,
          // applyPluginManifestOrder) already migrates any legacy openMode-only harness.json into
          // openIn/target, so this file only ever reads the new fields.
          const openIn = pl.openIn === 'tab' ? 'tab' : 'embed';
          const target = pl.target === 'external' ? 'external' : 'internal';
          // WSXU2 (SPEC-workspace-settings.md §22): routes are computed server-side by /api/status
          // (single source of truth, D20/D24 slug-vs-name resolution) — read pl.routes.* instead of
          // concatenating '/x/' + pl.name ourselves. Fall back to the old string-building when
          // routes is missing (stale cached /api/status payload, older server not yet deployed) so
          // this never white-screens.
          const embedRoute = (pl.routes && pl.routes.embed) || ('/app/x/' + pl.name);
          const standaloneRoute = (pl.routes && pl.routes.standalone) || ('/x/' + pl.name);
          const embedExternalRoute = (pl.routes && pl.routes.embedExternal) || ('/app/xurl/' + pl.name);
          const isExternalIcon = target === 'external';
          if (!disabled) btn.addEventListener('click', () => {
            if (target === 'external') {
              if (!pl.externalUrl) {
                if (typeof window.showToast === 'function') window.showToast('尚未設定外部網址', 'error');
                return;
              }
              // §25: embed+external -> in-page iframe route; tab+external -> a real new tab, no
              // ?workspace= (D29 note: the external site doesn't understand our workspace param).
              if (openIn === 'embed') { window.router && window.router.navigate(embedExternalRoute); return; }
              window.open(pl.externalUrl, '_blank');
              return;
            }
            if (openIn === 'embed') { window.router && window.router.navigate(embedRoute); return; }
            const ws = sessionStorage.getItem('current_workspace') || '';
            window.open(standaloneRoute + '?workspace=' + encodeURIComponent(ws), '_blank');
          });
          btn.innerHTML = `
            <i data-lucide="${dgEsc(pl.icon || 'puzzle')}" class="h-4 w-4 flex-shrink-0"></i>
            <span class="tracking-wide sb-collapse-hide truncate">${dgEsc(pl.title || pl.name)}</span>
            ${(openIn !== 'embed' || isExternalIcon) ? '<i data-lucide="external-link" class="h-3.5 w-3.5 flex-shrink-0 opacity-60"></i>' : ''}`;
          dyn.appendChild(btn);
        });
      }

      lucide.createIcons();
    }

    // Sidebar collapse (icon rail) with persistence
    function applySidebarCollapse(collapsed) {
      const sb = document.getElementById('sidebar');
      const icon = document.getElementById('sidebar-collapse-icon');
      const btn = document.getElementById('sidebar-collapse-btn');
      if (!sb) return;
      sb.classList.toggle('sidebar-collapsed', collapsed);
      if (icon) icon.setAttribute('data-lucide', collapsed ? 'panel-left-open' : 'panel-left-close');
      if (btn) btn.setAttribute('title', collapsed ? '展開側邊欄' : '收合側邊欄');
      if (typeof lucide !== 'undefined') lucide.createIcons();
    }
    function toggleSidebarCollapse() {
      const collapsed = !document.getElementById('sidebar').classList.contains('sidebar-collapsed');
      localStorage.setItem('hana_sidebar_collapsed', collapsed ? '1' : '0');
      applySidebarCollapse(collapsed);
    }
    (function initSidebarCollapse() {
      const run = () => applySidebarCollapse(localStorage.getItem('hana_sidebar_collapsed') === '1');
      if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', run); else run();
    })();

    // Recursive directory tree renderer
    function renderTree(items, containerElement, level = 0) {
      items.forEach(item => {
        if (item.type === 'directory') {
          const folderId = `folder-${item.path.replace(/\//g, '-')}`;
          const groupEl = document.createElement('div');
          groupEl.className = 'space-y-0.5 mt-0.5';

          const folderBtn = document.createElement('button');
          folderBtn.className = level === 0
            ? `w-full text-left px-2.5 py-1.5 rounded-lg text-[13px] font-semibold text-slate-700 dark:text-slate-300 hover:text-slate-950 dark:hover:text-white hover:bg-slate-200/40 dark:hover:bg-slate-800/40 flex items-center justify-between transition-all group`
            : `w-full text-left px-2.5 py-1.5 rounded-md text-[12px] font-medium text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white hover:bg-slate-200/25 dark:hover:bg-slate-800/25 flex items-center justify-between transition-all group`;
          folderBtn.style.paddingLeft = level === 0 ? '8px' : '4px';

          folderBtn.innerHTML = `
            <div class="flex items-center space-x-2 truncate">
              <i data-lucide="folder" class="h-4 w-4 text-slate-400 dark:text-slate-500 flex-shrink-0"></i>
              <span class="truncate">${item.name}</span>
            </div>
            <i data-lucide="chevron-down" class="h-3.5 w-3.5 transform transition-transform -rotate-90 text-slate-400 group-hover:text-slate-600 dark:group-hover:text-white" id="arrow-${folderId}"></i>
          `;

          const childrenContainer = document.createElement('div');
          childrenContainer.id = folderId;
          childrenContainer.className = 'space-y-0.5 hidden mt-0.5 nested-menu-container';

          folderBtn.onclick = () => {
            const isHidden = childrenContainer.classList.toggle('hidden');
            document.getElementById(`arrow-${folderId}`).style.transform = isHidden ? 'rotate(-90deg)' : 'rotate(0deg)';
          };

          renderTree(item.children, childrenContainer, level + 1);

          groupEl.appendChild(folderBtn);
          groupEl.appendChild(childrenContainer);
          containerElement.appendChild(groupEl);
        } else {
          // File button
          const fileId = `menu-${item.path.replace(/\//g, '-')}`;
          const btn = document.createElement('button');
          btn.id = fileId;
          const isPres = item.path.toLowerCase().includes('presentations/') || item.path.toLowerCase().endsWith('.html') || item.path.toLowerCase().endsWith('.htm');
          // Presentations + any .html open in the IN-PANEL live preview (renderHtmlPreview via
          // loadFile), which carries the toolbar — 全螢幕播放 / 匯出 pptx / 錄製影片 / 新分頁開啟.
          // (Previously these window.open'd a new tab, so the export/record buttons were never seen.)
          btn.onclick = () => loadFile(item.path);
          btn.className = level === 0
            ? `w-full text-left px-2.5 py-1.5 rounded-lg text-[13px] text-slate-700 dark:text-slate-300 hover:bg-slate-200/40 dark:hover:bg-slate-800/50 hover:text-slate-950 dark:hover:text-white transition-all truncate block font-medium flex items-center space-x-2`
            : `w-full text-left px-2.5 py-1.5 rounded-md text-[12px] text-slate-500 dark:text-slate-400 hover:bg-slate-200/25 dark:hover:bg-slate-800/25 hover:text-slate-900 dark:hover:text-white transition-all truncate block font-normal flex items-center space-x-2`;
          btn.style.paddingLeft = level === 0 ? '8px' : '4px';

          // Determine custom icon
          let icon = 'file-text';
          if (item.path.includes('gap_analysis')) icon = 'alert-circle';
          if (item.path.includes('history')) icon = 'archive';
          if (item.path.includes('governance/00_foundation')) icon = 'book-open';
          if (item.path.includes('governance/01_acts')) icon = 'scale';
          if (item.path.toLowerCase().includes('presentations/') || item.path.toLowerCase().endsWith('.html') || item.path.toLowerCase().endsWith('.htm')) icon = 'presentation';

          const displayName = presentationTitles[item.name] || item.name.replace(/\.(md|html)$/, '');

          btn.innerHTML = `<i data-lucide="${icon}" class="h-4 w-4 flex-shrink-0 text-slate-400 dark:text-slate-500"></i><span class="truncate">${displayName}</span>`;
          containerElement.appendChild(btn);
        }
      });
    }

    // Toggle main accordion sections
    // Skills sidebar — the three tiers (出貨/全域/專案) from /api/commands. Click opens the skill's .md.
    const SKILL_TIERS = [
      { src: 'ship',    label: '出貨 · portal/commands',            dir: 'portal/commands' },
      { src: 'global',  label: '全域 · global-knowledge/commands',  dir: 'global-knowledge/commands' },
      { src: 'project', label: '專案 · .harness/commands',          dir: '.harness/commands' },
    ];
    async function renderSkillsTree() {
      const box = document.getElementById('skills-tree');
      if (!box) return;
      let cmds = [];
      try { cmds = (await (await fetch('/api/commands')).json()).commands || []; }
      catch (e) { box.innerHTML = '<div class="px-3 py-2 text-xs text-slate-400">技能載入失敗</div>'; return; }
      box.innerHTML = SKILL_TIERS.map(t => {
        const items = cmds.filter(c => c.source === t.src);
        const rows = items.length
          ? items.map(c => `
            <button onclick="loadFile('${t.dir}/${c.name}.md')" title="${(c.description || '').replace(/"/g, '&quot;')}" class="w-full flex items-center gap-2 pl-7 pr-3 py-1.5 rounded-lg text-[13px] font-medium text-slate-600 dark:text-slate-300 hover:bg-slate-200/40 dark:hover:bg-slate-800/50 hover:text-slate-950 dark:hover:text-white transition-all group">
              <i data-lucide="${c.icon || 'terminal'}" class="h-4 w-4 text-slate-400 dark:text-slate-500 group-hover:text-cyan-600 dark:group-hover:text-cyan-400 flex-shrink-0"></i>
              <span class="truncate">/${c.name}</span>
              <span class="ml-auto text-[10px] px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-800 text-slate-400 dark:text-slate-500 flex-shrink-0">${c.type || 'prompt'}</span>
            </button>`).join('')
          : '<div class="pl-7 pr-3 py-1.5 text-[11px] text-slate-400 dark:text-slate-600 italic">（尚無）</div>';
        return `
          <div class="px-3 pt-1.5 pb-0.5 flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-slate-400 dark:text-slate-500">
            <i data-lucide="folder" class="h-3 w-3 flex-shrink-0"></i><span class="truncate">${t.label}</span>
          </div>${rows}`;
      }).join('');
      if (typeof lucide !== 'undefined') lucide.createIcons();
    }
    function toggleSection(sectionId) {
      const el = document.getElementById(sectionId);
      const arrow = document.getElementById(`arrow-${sectionId}`);
      const isHidden = el.classList.toggle('hidden');
      arrow.style.transform = isHidden ? 'rotate(-90deg)' : 'rotate(0deg)';
    }

    // Search Filtering
    function handleSearch(query) {
      const cleanQuery = query.trim().toLowerCase();
      const accordion = document.getElementById('accordion-sections');
      const searchSec = document.getElementById('search-results-section');
      const searchRes = document.getElementById('search-results');
      const clearBtn = document.getElementById('btn-search-clear');

      if (!cleanQuery) {
        accordion.classList.remove('hidden');
        searchSec.classList.add('hidden');
        clearBtn.classList.add('hidden');
        searchRes.innerHTML = '';
        return;
      }

      accordion.classList.add('hidden');
      searchSec.classList.remove('hidden');
      clearBtn.classList.remove('hidden');
      searchRes.innerHTML = '';

      // Filter files across the worktable + all manifest sections
      const allFound = [
        ...filterFiles(statusData.worktable || [], cleanQuery),
        ...(statusData.sections || []).flatMap(s => filterFiles(s.tree || [], cleanQuery))
      ];

      if (allFound.length === 0) {
        searchRes.innerHTML = '<div class="px-3 py-4 text-[13px] text-slate-400 dark:text-slate-500 text-center font-medium">沒有找到匹配的 Markdown 檔案</div>';
        return;
      }

      allFound.forEach(item => {
        const btn = document.createElement('button');
        const isPres = item.path.toLowerCase().includes('presentations/') || item.path.toLowerCase().endsWith('.html') || item.path.toLowerCase().endsWith('.htm');
        // Open decks in the in-panel preview (toolbar: 全螢幕播放 / 匯出 pptx / 錄製影片 / 新分頁開啟).
        btn.onclick = () => loadFile(item.path);
        btn.className = `w-full text-left px-3 py-2 rounded text-[13px] text-slate-600 dark:text-slate-400 hover:bg-slate-200/50 dark:hover:bg-slate-800/40 hover:text-slate-950 dark:hover:text-white transition-all truncate block font-medium flex flex-col space-y-0.5 border border-transparent hover:border-slate-300/30 dark:hover:border-slate-800/40`;
        const isPresIcon = item.path.toLowerCase().includes('presentations/') || item.path.toLowerCase().endsWith('.html') || item.path.toLowerCase().endsWith('.htm');
        const iconName = isPresIcon ? 'presentation' : 'file-code';
        btn.innerHTML = `
          <div class="flex items-center space-x-2 font-semibold text-slate-800 dark:text-slate-300">
            <i data-lucide="${iconName}" class="h-4 w-4 text-slate-400 dark:text-slate-500"></i>
            <span class="truncate">${item.name}</span>
          </div>
          <span class="text-[10px] text-slate-400 dark:text-slate-500 font-mono truncate pl-6">${item.path}</span>
        `;
        searchRes.appendChild(btn);
      });
      lucide.createIcons();
    }

    function filterFiles(tree, query) {
      let results = [];
      function recurse(items) {
        items.forEach(item => {
          if (item.type === 'file') {
            const cleanName = item.name.toLowerCase();
            const cleanPath = item.path.toLowerCase();
            if (cleanName.includes(query) || cleanPath.includes(query)) {
              results.push(item);
            }
          } else if (item.type === 'directory') {
            recurse(item.children);
          }
        });
      }
      recurse(tree);
      return results;
    }

    function clearSearch() {
      document.getElementById('search-input').value = '';
      handleSearch('');
    }
