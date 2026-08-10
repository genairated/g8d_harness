    // Toggle Dark/Light Theme
    function toggleTheme() {
      const isDark = document.documentElement.classList.toggle('dark');
      localStorage.setItem('theme', isDark ? 'dark' : 'light');
      updateThemeUI(isDark);

      // Re-render current file to apply syntax changes if code blocks are open
      if (currentFileData) {
        renderMarkdown(currentFileData.content);
      }
      // PM Gantt paints with an explicit light/dark palette → repaint on theme flip so it stays readable.
      if (typeof pmState !== 'undefined' && pmState.view === 'gantt' && pmState.selectedProjectId) pmRenderGantt();
      if (typeof pmMulti !== 'undefined' && pmMulti.active) pmMultiRender();
    }

    // Update Theme Switcher Icon and Stylesheets
    function updateThemeUI(isDark) {
      const icon = document.getElementById('theme-icon');
      if (isDark) {
        icon.setAttribute('data-lucide', 'sun');
        document.getElementById('prism-theme').href = '/vendor/prism-tomorrow.min.css';
      } else {
        icon.setAttribute('data-lucide', 'moon');
        document.getElementById('prism-theme').href = '/vendor/prism.min.css';
      }
      lucide.createIcons();
    }
