    // ── Hana Avatar & TTS Voice Logic ──────────────────────────────────────────────────
    let voices = [];
    let selectedVoice = null;
    let currentUtterance = null;
    let currentSpeakerBtn = null;

    function setAvatarState(state) {
      const container = document.getElementById('hana-avatar-container');
      if (!container) return;
      container.className = container.className.replace(/\bstate-\S+/g, '');
      container.classList.add('state-' + state);

      const label = document.getElementById('hana-avatar-status-label');
      if (label) {
        if (state.startsWith('thinking')) {
          const messages = [
            '哈娜正在腦力激盪中...',
            '哈娜在尋找解決方案...',
            '哈娜正在閱讀您的專案代碼...',
            '哈娜陷入了沉思...',
            '哈娜正在構思最佳實踐...',
            '哈娜正在全力編碼中...',
            '哈娜正在檢查每一個細節...',
            '哈娜正在為您調用強大 AI...'
          ];
          const idx = parseInt(state.split('-')[2]) - 1 || 0;
          label.textContent = messages[idx] || '哈娜正在思考中...';
        } else if (state === 'success') {
          label.textContent = '思考成功！';
        } else if (state === 'speaking') {
          label.textContent = '哈娜正在語音朗讀中...';
        } else {
          label.textContent = '哈娜已準備就緒';
        }
      }
    }

    function selectRandomThinkingState() {
      const randIdx = Math.floor(Math.random() * 8) + 1;
      setAvatarState('thinking-' + randIdx);
    }

    function getBrowserKey() {
      const ua = navigator.userAgent;
      if (ua.includes('Edg/')) return 'edge';
      if (ua.includes('Chrome/')) return 'chrome';
      if (ua.includes('Safari/') && !ua.includes('Chrome/')) return 'safari';
      if (ua.includes('Firefox/')) return 'firefox';
      return 'default';
    }

    let ttsVoiceConfig = { voice: '', speed: 1.2, browsers: {} };

    async function loadVoiceConfig() {
      try {
        const res = await fetch('/api/voice-config');
        if (res.ok) {
          const config = await res.json();
          if (config) {
            ttsVoiceConfig.voice = config.voice || '';
            ttsVoiceConfig.speed = typeof config.speed === 'number' ? config.speed : 1.2;
            ttsVoiceConfig.browsers = config.browsers || {};

            const browserKey = getBrowserKey();
            const browserConfig = ttsVoiceConfig.browsers[browserKey];
            if (browserConfig) {
              if (typeof browserConfig === 'object') {
                ttsVoiceConfig.voice = browserConfig.voice || '';
                ttsVoiceConfig.speed = typeof browserConfig.speed === 'number' ? browserConfig.speed : ttsVoiceConfig.speed;
              } else if (typeof browserConfig === 'string') {
                ttsVoiceConfig.voice = browserConfig;
              }
            }
          }
        }
      } catch (e) {
        console.error('[Harness] Failed to load voice config:', e);
      }
      localStorage.setItem('hana_tts_voice', ttsVoiceConfig.voice);
      localStorage.setItem('hana_tts_speed', ttsVoiceConfig.speed);
    }

    async function saveVoiceConfig(voice, speed) {
      const browserKey = getBrowserKey();
      ttsVoiceConfig.browsers = ttsVoiceConfig.browsers || {};
      ttsVoiceConfig.browsers[browserKey] = { voice, speed };
      ttsVoiceConfig.voice = voice;
      ttsVoiceConfig.speed = speed;
      localStorage.setItem('hana_tts_voice', voice);
      localStorage.setItem('hana_tts_speed', speed);
      try {
        const res = await fetch('/api/voice-config', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            browser: browserKey,
            voice: voice,
            speed: speed
          })
        });
        if (res.ok) {
          const resData = await res.json();
          if (resData && resData.config) {
            ttsVoiceConfig.browsers = resData.config.browsers || {};
          }
        }
      } catch (e) {
        console.error('[Harness] Failed to save voice config:', e);
      }

      // Notify embedded preview iframe if present
      const frame = document.getElementById('html-preview-frame');
      if (frame && frame.contentWindow) {
        frame.contentWindow.postMessage({
          type: 'HANA_PORTAL_VOICE_CONFIG_CHANGED',
          config: ttsVoiceConfig
        }, window.location.origin);
      }
    }

    window.addEventListener('message', (event) => {
      if (event.origin !== window.location.origin) return;
      if (event.data && event.data.type === 'HANA_VOICE_CONFIG_CHANGED') {
        const config = event.data.config;
        ttsVoiceConfig.voice = config.voice || '';
        ttsVoiceConfig.speed = typeof config.speed === 'number' ? config.speed : 1.2;
        ttsVoiceConfig.browsers = config.browsers || {};

        const browserKey = getBrowserKey();
        const browserConfig = ttsVoiceConfig.browsers[browserKey];
        if (browserConfig) {
          if (typeof browserConfig === 'object') {
            ttsVoiceConfig.voice = browserConfig.voice || '';
            ttsVoiceConfig.speed = typeof browserConfig.speed === 'number' ? browserConfig.speed : ttsVoiceConfig.speed;
          } else if (typeof browserConfig === 'string') {
            ttsVoiceConfig.voice = browserConfig;
          }
        }

        localStorage.setItem('hana_tts_voice', ttsVoiceConfig.voice);
        localStorage.setItem('hana_tts_speed', ttsVoiceConfig.speed);

        document.querySelectorAll('.hana-voice-select-input').forEach(sel => {
          sel.value = ttsVoiceConfig.voice;
        });
        document.querySelectorAll('.hana-tts-speed-val-display').forEach(span => {
          span.textContent = ttsVoiceConfig.speed;
        });
        document.querySelectorAll('.hana-tts-speed-slider-input').forEach(slider => {
          slider.value = ttsVoiceConfig.speed;
        });

        if (voices.length) {
          const match = voices.find(v => v.name === ttsVoiceConfig.voice);
          if (match) {
            selectedVoice = match;
            window.selectedVoice = selectedVoice;
          }
        }
      } else if (event.data && event.data.type === 'HANA_PORTAL_AVATAR_VISIBLE_CHANGED') {
        const visible = event.data.visible;
        const widget = document.getElementById('hana-float-widget');
        if (widget) {
          widget.classList.toggle('avatar-hidden', !visible);
        }
      }
    });

    function changeHanaVoice(voiceName) {
      saveVoiceConfig(voiceName, parseFloat(localStorage.getItem('hana_tts_speed') || '1.2'));
      document.querySelectorAll('.hana-voice-select-input').forEach(sel => {
        sel.value = voiceName;
      });
      if (voices.length) {
        selectedVoice = voices.find(v => v.name === voiceName) || selectedVoice;
        window.selectedVoice = selectedVoice;
      }
      stopSpeech();
      setTimeout(testHanaVoice, 100);
    }

    function testHanaVoice() {
      const synth = window.speechSynthesis;
      if (!synth) {
        showToast('您的瀏覽器不支援語音播放', 'error');
        return;
      }
      if (typeof stopSpeech === 'function') stopSpeech();
      const u = new SpeechSynthesisUtterance("你好，我是哈娜 Hana");
      const activeVoice = window.selectedVoice || selectedVoice;
      if (activeVoice) {
        u.voice = activeVoice;
        u.lang = activeVoice.lang;
      } else {
        u.lang = 'zh-TW';
      }
      u.rate = parseFloat(localStorage.getItem('hana_tts_speed') || '1.2');
      u.onstart = () => { if (typeof setAvatarState === 'function') setAvatarState('speaking'); };
      u.onend   = () => { if (typeof setAvatarState === 'function') setAvatarState('idle'); };
      u.onerror = (e) => { if (e.error !== 'interrupted' && e.error !== 'canceled' && typeof setAvatarState === 'function') setAvatarState('idle'); };
      synth.speak(u);
    }
    window.testHanaVoice = testHanaVoice;

    function changeHanaSpeed(val) {
      saveVoiceConfig(localStorage.getItem('hana_tts_voice') || '', parseFloat(val));
      document.querySelectorAll('.hana-tts-speed-val-display').forEach(span => {
        span.textContent = val;
      });
      document.querySelectorAll('.hana-tts-speed-slider-input').forEach(slider => {
        slider.value = val;
      });
    }

    function resetHanaSpeed() {
      document.querySelectorAll('.hana-tts-speed-slider-input').forEach(slider => {
        slider.value = 1.2;
      });
      changeHanaSpeed(1.2);
    }

    function populateHanaVoiceList() {
      const selectElements = document.querySelectorAll('.hana-voice-select-input');
      if (!selectElements.length) return;
      const synth = window.speechSynthesis;
      if (!synth) return;
      voices = synth.getVoices();

      let foundVoice = null;
      const savedVoiceName = localStorage.getItem('hana_tts_voice');
      if (savedVoiceName) {
        foundVoice = voices.find(v => v.name === savedVoiceName);
      }

      if (foundVoice) {
        selectedVoice = foundVoice;
        window.selectedVoice = selectedVoice;
      } else {
        // Detect browser and choose default voice
        const ua = navigator.userAgent;
        const isEdge = /Edg\//i.test(ua);
        const isChrome = /Chrome\//i.test(ua) && !isEdge;
        const isSafari = /Safari\//i.test(ua) && !isChrome && !isEdge;
        const isFirefox = /Firefox\//i.test(ua);

        if (isEdge) {
          selectedVoice = voices.find(v => /Microsoft Xiaoxiao/i.test(v.name)) ||
                          voices.find(v => /Microsoft Hanhan/i.test(v.name)) ||
                          voices.find(v => /Microsoft Yating/i.test(v.name)) ||
                          voices.find(v => /Microsoft/i.test(v.name) && /zh/i.test(v.lang));
        } else if (isChrome) {
          selectedVoice = voices.find(v => /Google 國語/i.test(v.name)) ||
                          voices.find(v => /Google/i.test(v.name) && /zh/i.test(v.lang));
        } else if (isSafari) {
          selectedVoice = voices.find(v => /Tingting/i.test(v.name)) ||
                          voices.find(v => /Sinji/i.test(v.name)) ||
                          voices.find(v => /zh/i.test(v.lang));
        } else if (isFirefox) {
          selectedVoice = voices.find(v => /zh[-_]TW/i.test(v.lang)) ||
                          voices.find(v => /zh/i.test(v.lang));
        }

        // Fallbacks
        if (!selectedVoice) {
          selectedVoice = voices.find(v => /Microsoft Yating/i.test(v.name)) ||
                          voices.find(v => /Yating/i.test(v.name)) ||
                          voices.find(v => /zh[-_]TW/i.test(v.lang)) ||
                          voices.find(v => /zh/i.test(v.lang)) ||
                          voices[0] || null;
        }

        // Auto-save the detected default voice to the backend if we found one and don't have a setting for this browser yet!
        if (selectedVoice) {
          const browserKey = getBrowserKey();
          ttsVoiceConfig.browsers = ttsVoiceConfig.browsers || {};
          if (!ttsVoiceConfig.browsers[browserKey]) {
            saveVoiceConfig(selectedVoice.name, ttsVoiceConfig.speed);
          } else {
            localStorage.setItem('hana_tts_voice', selectedVoice.name);
          }
        }
        window.selectedVoice = selectedVoice;
      }

      selectElements.forEach(sel => {
        sel.innerHTML = '';
        if (!voices.length) {
          sel.innerHTML = '<option value="">無可用語音</option>';
          return;
        }

        const zhVoices = voices.filter(v => /zh/i.test(v.lang));
        const otherVoices = voices.filter(v => !/zh/i.test(v.lang));
        const all = [...zhVoices, ...otherVoices];

        all.forEach(v => {
          const opt = document.createElement('option');
          opt.value = v.name;
          opt.textContent = `${selectedVoice && v.name === selectedVoice.name ? 'Hana - ' : ''}${v.name} (${v.lang})`;
          opt.selected = selectedVoice && v.name === selectedVoice.name;
          sel.appendChild(opt);
        });
      });
    }

    function stopSpeech() {
      if (window.speechSynthesis) {
        window.speechSynthesis.cancel();
      }
      if (currentSpeakerBtn) {
        updateSpeakerBtnState(currentSpeakerBtn, false);
        currentSpeakerBtn = null;
      }
      currentUtterance = null;
      setAvatarState('idle');
    }

    function updateSpeakerBtnState(btn, isPlaying) {
      if (!btn) return;
      const icon = btn.querySelector('i');
      const textSpan = btn.querySelector('span');
      if (isPlaying) {
        if (icon) {
          icon.setAttribute('data-lucide', 'square');
          btn.title = '停止朗讀';
        }
        if (textSpan) textSpan.textContent = '停止';
        btn.classList.add('text-rose-500', 'hover:text-rose-600');
        btn.classList.remove('text-slate-400', 'hover:text-cyan-600');
      } else {
        if (icon) {
          icon.setAttribute('data-lucide', 'volume-2');
          btn.title = '播放語音';
        }
        if (textSpan) textSpan.textContent = '朗讀';
        btn.classList.remove('text-rose-500', 'hover:text-rose-600');
        btn.classList.add('text-slate-400', 'hover:text-cyan-600');
      }
      if (typeof lucide !== 'undefined') lucide.createIcons();
    }

    // ── Floating widget drag behaviour ────────────────────────────────────────────
    (function () {
      const widget = document.getElementById('hana-float-widget');
      if (!widget) return;

      let dragging = false, ox = 0, oy = 0, sx = 0, sy = 0;

      widget.addEventListener('mousedown', function (e) {
        if (e.target.closest('button') || e.target.closest('#hana-settings-panel')) return; // don't drag when clicking icon buttons or settings panel
        dragging = true;
        window.__hanaDragging = true;
        widget.style.transition = '';   // cancel any pacing transition so drag stays snappy
        sx = e.clientX;
        sy = e.clientY;
        const rect = widget.getBoundingClientRect();
        ox = rect.left;
        oy = rect.top;
        widget.style.right  = 'auto';
        widget.style.bottom = 'auto';
        widget.style.left   = ox + 'px';
        widget.style.top    = oy + 'px';
        widget.style.cursor = 'grabbing';
        e.preventDefault();
      });

      document.addEventListener('mousemove', function (e) {
        if (!dragging) return;
        widget.style.left = (ox + e.clientX - sx) + 'px';
        widget.style.top  = (oy + e.clientY - sy) + 'px';
        if (typeof syncFloatChatToWidget === 'function') syncFloatChatToWidget();
      });

      document.addEventListener('mouseup', function () {
        if (dragging) {
          dragging = false;
          window.__hanaDragging = false;
          widget.style.cursor = 'grab';
          if (typeof window.updateHanaAvatarDirection === 'function') window.updateHanaAvatarDirection();
        }
      });
    })();

    // ── Global avatar manual show/hide toggle ──
    // AVT-FIX：不再持久化（localStorage hana_avatar_visible 與「顯示動漫形象」勾選框已移除）；
    // 只剩頭像 × 隱藏 / 還原鈕與簡報 iframe 的同步訊息，重新整理後一律顯示。
    window.toggleHanaAvatarVisible = function (visible) {
      const widget = document.getElementById('hana-float-widget');
      if (widget) {
        widget.classList.toggle('avatar-hidden', !visible);
      }

      // Notify the active presentation iframe if present
      const frame = document.getElementById('html-preview-frame');
      if (frame && frame.contentWindow) {
        try {
          frame.contentWindow.postMessage({
            type: 'HANA_PORTAL_AVATAR_VISIBLE_CHANGED',
            visible: visible
          }, window.location.origin);
        } catch (e) {
          console.warn('Failed to notify presentation iframe of avatar visibility change:', e);
        }
      }
    };

    // ── Presentation Unified speech bridge functions ──
    window.hanaSpeak = function (text, onendCallback) {
      const synth = window.speechSynthesis;
      if (!synth) return;
      if (typeof stopSpeech === 'function') stopSpeech();

      let clean = text
        .replace(/```[\s\S]*?```/g, '這是一段程式碼區塊。')
        .replace(/`[^`]+`/g, '')
        .replace(/!\[.*?\]\(.*?\)/g, '')
        .replace(/\[.*?\]\(.*?\)/g, '')
        .replace(/[#*_~>]/g, '')
        .replace(/\bHana\b/g, '哈娜')
        .trim();
      if (!clean) {
        if (typeof onendCallback === 'function') onendCallback();
        return;
      }

      const u = new SpeechSynthesisUtterance(window.ttsNormalize ? window.ttsNormalize(clean) : clean);
      if (window.selectedVoice) u.voice = window.selectedVoice;
      u.lang = window.selectedVoice ? window.selectedVoice.lang : 'zh-TW';
      u.rate = parseFloat(localStorage.getItem('hana_tts_speed') || '1.2');

      u.onstart = () => {
        if (typeof setAvatarState === 'function') setAvatarState('speaking');
      };
      u.onend = () => {
        if (typeof setAvatarState === 'function') setAvatarState('idle');
        if (typeof onendCallback === 'function') onendCallback();
      };
      u.onerror = (e) => {
        if (typeof setAvatarState === 'function') setAvatarState('idle');
        if (e.error !== 'interrupted' && e.error !== 'canceled') {
          if (typeof onendCallback === 'function') onendCallback();
        }
      };
      synth.speak(u);
    };

    window.hanaPauseSpeech = function () {
      const synth = window.speechSynthesis;
      if (synth && (synth.speaking || synth.pending)) {
        if (synth.paused) {
          synth.resume();
          if (typeof setAvatarState === 'function') setAvatarState('speaking');
          return false;
        } else {
          synth.pause();
          if (typeof setAvatarState === 'function') setAvatarState('idle');
          return true;
        }
      }
      return false;
    };

    window.hanaStopSpeech = function () {
      if (typeof stopSpeech === 'function') stopSpeech();
    };

    // ── Global avatar pose mapping based on TTS mode ──
    function mapPoseByMode(pose, mode) {
      const p = pose.replace(/_(left|right)$/, '');
      if (mode === 'mic') {
        if (p.startsWith('headset_')) return p;
        if (p.startsWith('glasses_think')) return 'headset_think';
        if (p.startsWith('sit_smile')) return 'headset_idle';
        if (p.startsWith('laptop_talk')) return 'headset_talk';
        if (p.startsWith('tablet_read')) return 'headset_think';
        if (p.startsWith('hips_confident')) return 'headset_smile';
        if (p.startsWith('wave_hi')) return 'headset_smile';
        return 'headset_idle';
      } else {
        if (p.startsWith('headset_idle')) return 'sit_smile';
        if (p.startsWith('headset_smile')) return 'sit_smile';
        if (p.startsWith('headset_talk')) return 'laptop_talk';
        if (p.startsWith('headset_think')) return 'glasses_think';
        if (p.startsWith('headset_cheer')) return 'wave_hi';
        if (p.startsWith('headset_idea')) return 'glasses_think';
        return p;
      }
    }

    // ── Global avatar pose updates from presentation slide changes ──
    window.updateHanaFloatPose = function (pose) {
      const img = document.getElementById('hana-float-img');
      if (!img) return;
      const mode = window.hanaTTSMode || 'notebook';
      const cleanPose = pose.replace(/_(left|right)$/, '');
      const mappedPose = mapPoseByMode(cleanPose, mode);
      img.dataset.pose = mappedPose;
      img.src = window.getHanaAvatarSrc(mappedPose);
    };

    // ── TTS Settings panel toggle ─────────────────────────────────────────────────
    function toggleHanaSettings(e) {
      if (e) e.stopPropagation();
      const panel = document.getElementById('hana-settings-panel');
      if (!panel) return;
      const isOpen = panel.style.display !== 'none';
      panel.style.display = isOpen ? 'none' : 'block';
    }
    document.addEventListener('click', function(e) {
      const panel = document.getElementById('hana-settings-panel');
      const btn = document.getElementById('hana-gear-btn');
      if (panel && panel.style.display !== 'none' && !panel.contains(e.target) && e.target !== btn) {
        panel.style.display = 'none';
      }
    });

    // ── TTS Mode (mic = auto-speak, notebook = text-only) ────────────────────────
    window.hanaTTSMode = localStorage.getItem('hana_tts_mode') || 'notebook';

    function setHanaTTSMode(mode) {
      window.hanaTTSMode = mode;
      localStorage.setItem('hana_tts_mode', mode);
      const micBtn  = document.getElementById('hana-mode-btn-mic');
      const nbBtn   = document.getElementById('hana-mode-btn-notebook');
      const badge   = document.getElementById('hana-mode-badge');
      const img     = document.getElementById('hana-float-img');
      const idlePose = mode === 'mic' ? 'headset_idle' : 'sit_smile';
      if (mode === 'mic') {
        if (micBtn) micBtn.classList.add('active');
        if (nbBtn)  nbBtn.classList.remove('active');
        if (badge)  badge.textContent = '🎙️';
      } else {
        if (nbBtn)  nbBtn.classList.add('active');
        if (micBtn) micBtn.classList.remove('active');
        if (badge)  badge.textContent = '📝';
      }
      if (img) {
        img.dataset.pose = idlePose;
        img.src = window.getHanaAvatarSrc ? window.getHanaAvatarSrc(idlePose) : img.src;
      }
    }

    // Apply persisted mode on load
    (function () { setHanaTTSMode(window.hanaTTSMode); })();

    // Auto-speak the last assistant reply when in mic mode
    function hanaAutoSpeak(text) {
      const synth = window.speechSynthesis;
      if (!synth || !text) return;
      if (typeof stopSpeech === 'function') stopSpeech();
      let clean = text
        .replace(/```[\s\S]*?```/g, '這是一段程式碼區塊。')
        .replace(/`[^`]+`/g, '')
        .replace(/!\[.*?\]\(.*?\)/g, '')
        .replace(/\[.*?\]\(.*?\)/g, '')
        .replace(/[#*_~>]/g, '')
        .replace(/\bHana\b/g, '哈娜')
        .trim();
      if (!clean) return;
      const u = new SpeechSynthesisUtterance(window.ttsNormalize ? window.ttsNormalize(clean) : clean);
      if (window.selectedVoice) u.voice = window.selectedVoice;
      u.lang = window.selectedVoice ? window.selectedVoice.lang : 'zh-TW';
      u.rate = parseFloat(localStorage.getItem('hana_tts_speed') || '1.2');
      u.onstart = () => { if (typeof setAvatarState === 'function') setAvatarState('speaking'); };
      u.onend   = () => { if (typeof setAvatarState === 'function') setAvatarState('idle'); };
      u.onerror = (e) => { if (e.error !== 'interrupted' && e.error !== 'canceled' && typeof setAvatarState === 'function') setAvatarState('idle'); };
      synth.speak(u);
    }

    // ── Floating widget avatar helpers ────────────────────────────────────────────
    window.getHanaAvatarSrc = function (pose) {
      const widget = document.getElementById('hana-float-widget');
      let dir = 'left'; // default: face left (widget on right side)
      if (widget) {
        const rect = widget.getBoundingClientRect();
        const cx = rect.left + rect.width / 2;
        dir = cx < window.innerWidth / 2 ? 'right' : 'left';
      }
      return '/raw?path=portal/avatar/full/hana_' + pose + '_' + dir + '.png';
    };

    window.updateHanaAvatarDirection = function () {
      const img = document.getElementById('hana-float-img');
      if (!img || !img.dataset.pose) return;
      img.src = window.getHanaAvatarSrc(img.dataset.pose);
    };

    // ── Hook floating widget into setAvatarState ──────────────────────────────────
    (function () {
      const _orig = window.setAvatarState;
      window.setAvatarState = function (state) {
        if (typeof _orig === 'function') _orig(state);
        const img    = document.getElementById('hana-float-img');
        const bubble = document.getElementById('hana-think-bubble');
        if (!img) return;
        const isThinking = state.startsWith('thinking');
        const isSpeaking = state === 'speaking';
        const isSuccess  = state === 'success';
        img.classList.toggle('state-thinking', isThinking);
        img.classList.toggle('state-speaking', isSpeaking);
        if (bubble) bubble.classList.toggle('visible', isThinking);
        const mode = window.hanaTTSMode || 'notebook';
        let pose = mode === 'mic' ? 'headset_idle' : 'sit_smile';
        if (isThinking) pose = mode === 'mic' ? 'headset_think' : 'glasses_think';
        else if (isSpeaking || isSuccess) pose = mode === 'mic' ? 'headset_talk' : 'laptop_talk';
        img.dataset.pose = pose;
        img.src = window.getHanaAvatarSrc(pose);
      };

      // Wave hi on load, then switch to idle
      const img = document.getElementById('hana-float-img');
      if (img) {
        img.dataset.pose = 'wave_hi';
        img.src = window.getHanaAvatarSrc('wave_hi');
        setTimeout(function () {
          const m = window.hanaTTSMode || 'notebook';
          const idlePose = m === 'mic' ? 'headset_idle' : 'sit_smile';
          img.dataset.pose = idlePose;
          img.src = window.getHanaAvatarSrc(idlePose);
        }, 2800);
      }
    })();

    // ── Phase 1: 全身 Hana — 思考/待機隨機換姿勢 + 溫和踱步 ──────────────────────────
    (function () {
      const img    = document.getElementById('hana-float-img');
      const widget = document.getElementById('hana-float-widget');
      if (!img || !widget) return;
      // 講話(mic/頭戴)模式 → 頭戴系列；文字(notebook)模式 → 眼鏡/坐姿/平板系列。兩組不交叉
      // （hips_confident / wave_hi 為中性姿勢，兩邊共用）。
      const IDLE = (m) => m === 'mic'
        ? ['headset_idle', 'headset_smile', 'headset_cheer', 'hips_confident', 'wave_hi']
        : ['sit_smile', 'glasses_think', 'tablet_read', 'hips_confident', 'wave_hi'];
      const THINK = (m) => m === 'mic'
        ? ['headset_think', 'headset_idea', 'headset_cheer']
        : ['glasses_think', 'tablet_read', 'sit_smile'];
      const thinking = () => img.classList.contains('state-thinking');
      const speaking = () => img.classList.contains('state-speaking');
      const hidden   = () => widget.classList.contains('avatar-hidden');
      const pick = (a) => a[Math.floor(Math.random() * a.length)];

      // 隨機換姿勢（speaking 時不換，交給 TTS；避免連續挑到同一張）
      let lastPose = '';
      function rotate() {
        if (speaking() || hidden()) return;
        const m = window.hanaTTSMode || 'notebook';
        const pool = thinking() ? THINK(m) : IDLE(m);
        let p = pick(pool), guard = 0;
        while (p === lastPose && pool.length > 1 && guard++ < 4) p = pick(pool);
        lastPose = p;
        img.dataset.pose = p;
        img.src = window.getHanaAvatarSrc(p);
      }
      (function loop() { setTimeout(function () { rotate(); loop(); }, 4000 + Math.random() * 3000); })();
      // 踱步（位置飄移）已移除——等之後有真正的走路動畫素材再加（Phase 1.5）。
    })();
