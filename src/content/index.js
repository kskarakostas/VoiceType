// VoiceType - Content Script
// Expandable pill toolbar for speech-to-text

import { MSG } from '../shared/messages.js';
import { PROVIDERS } from '../shared/models.js';
import { formatCost } from '../shared/pricing.js';
import { freshSettings } from '../shared/defaults.js';
import { isValidInput, deepActiveElement } from './fields.js';
import { insertText } from './insert.js';

  // State
  let isRecording = false;
  let isStopping = false; // Prevent race conditions during stop
  let isProcessing = false; // Lock to prevent multiple transcriptions
  let isStarting = false; // getUserMedia in flight; blocks toggles until it settles
  let mediaRecorder = null;
  let audioChunks = [];
  let currentInput = null;
  let pill = null;
  let settings = null;
  let isInitialized = false;
  let recordingStartTime = null;
  let recordingTimer = null;
  let maxRecordingTimer = null; // For auto-stop at max time
  let isExpanded = false;
  let dropdownOpen = false;
  let hoverTimeout = null;
  let statusTimeout = null;
  let lastToggleTime = 0; // Track last toggle for debounce
  let pendingToggle = false; // Shortcut toggle that arrived before init() finished
  let audioContext = null;
  let analyser = null;
  let animationFrameId = null;

  // Every message to the service worker goes through here so a reloaded extension
  // (orphaned content script) produces one clear notice instead of console noise.
  function send(message) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(message, (response) => {
          if (chrome.runtime.lastError) {
            handleRuntimeError(chrome.runtime.lastError);
            resolve(null);
          } else {
            resolve(response);
          }
        });
      } catch (err) {
        handleRuntimeError(err);
        resolve(null);
      }
    });
  }

  function handleRuntimeError(err) {
    const text = String(err?.message || err);
    if (text.includes('Extension context invalidated') || text.includes('message port closed')) {
      showStatus('VoiceType was updated. Reload this page.', 'error', { sticky: true });
    } else {
      console.error('VoiceType: runtime error', err);
    }
  }

  // Initialize
  async function init() {
    if (isInitialized) return;
    isInitialized = true;
    
    try {
      // Load settings (v2). An error reply has no modes, so it falls back to defaults too.
      const loaded = await send({ action: MSG.GET_SETTINGS });
      settings = loaded?.modes ? loaded : freshSettings();
      
      // Create UI elements
      createPill();
      
      // Listen for input focus
      document.addEventListener('focusin', handleFocusIn);
      document.addEventListener('focusout', handleFocusOut);
      
      // Listen for clicks outside to close dropdown (use mousedown to catch before DOM changes)
      document.addEventListener('mousedown', handleDocumentClick);
      
      // Check if there's already a focused input
      const activeEl = deepActiveElement();
      if (isValidInput(activeEl)) {
        currentInput = activeEl;
        showPill(activeEl);
      }

      // Run a shortcut toggle that arrived while settings were loading
      if (pendingToggle) {
        pendingToggle = false;
        handleToggleCommand();
      }
    } catch (err) {
      console.error('VoiceType: Initialization error', err);
    }
  }

  // Keyboard shortcut toggle from the service worker (listener registered at load, see bottom)
  function handleToggleCommand() {
    // If recording, stop it
    if (isRecording) {
      stopRecording();
      return;
    }
    if (isStarting) return;
    
    // Force reset any stuck flags
    isStopping = false;
    isProcessing = false;
    
    // Ensure we have an input
    if (!currentInput) {
      const activeEl = deepActiveElement();
      if (isValidInput(activeEl)) {
        currentInput = activeEl;
        showPill(activeEl);
      }
    }
    
    // Now start if we have a valid input
    if (currentInput && pill) {
      expandPill();
      startRecording();
    }
  }

  // Create the pill element
  function createPill() {
    pill = document.createElement('div');
    pill.id = 'voicetype-pill';
    pill.className = 'collapsed';
    pill.style.display = 'none';
    
    pill.innerHTML = `
      <div class="vt-collapse-dot">
        <div class="vt-collapse-dot-inner"></div>
      </div>
      <div class="vt-expand-content">
        <button class="vt-mode-btn" title="Current mode">
          <span class="vt-mode-icon">🎤</span>
        </button>
        <div class="vt-divider"></div>
        <button class="vt-record-btn">
          <span class="vt-record-icon"></span>
          <span class="vt-record-text">REC</span>
        </button>
        <div class="vt-divider"></div>
        <button class="vt-menu-btn" title="Settings">•••</button>
      </div>
      <div class="vt-dropdown" id="vt-dropdown"></div>
      <div class="vt-status"></div>
    `;
    
    // Event listeners
    pill.addEventListener('mouseenter', handlePillMouseEnter);
    pill.addEventListener('mouseleave', handlePillMouseLeave);
    
    // Collapsed dot click
    pill.querySelector('.vt-collapse-dot').addEventListener('click', (e) => {
      e.stopPropagation();
      expandPill();
    });
    
    // Mode button click - just shows current mode, doesn't do anything special
    pill.querySelector('.vt-mode-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      // Show current mode name
      const mode = settings.modes[settings.activeMode] || settings.modes.default;
      showStatus(`${mode.icon} ${mode.name}`, '');
    });
    
    // Record button click
    pill.querySelector('.vt-record-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      toggleRecording();
    }, { capture: true });
    
    // Menu button click - opens full settings dropdown
    pill.querySelector('.vt-menu-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      toggleDropdown();
    });
    
    document.body.appendChild(pill);
    
    // Catch all clicks on the pill to prevent them from reaching document
    pill.addEventListener('click', (e) => {
      e.stopPropagation();
    });
    
    // Populate dropdown
    updateDropdown();
  }

  // Update mode button to show current mode
  function updateModeButton() {
    if (!settings || !pill) return;
    const mode = settings.modes[settings.activeMode] || settings.modes.default;
    const modeBtn = pill.querySelector('.vt-mode-btn');
    modeBtn.innerHTML = `<span class="vt-mode-icon">${mode.icon}</span>`;
    modeBtn.title = mode.name;
  }

  // Update dropdown with full settings
  function updateDropdown() {
    if (!settings || !pill) return;
    
    const dropdown = pill.querySelector('#vt-dropdown');
    const provider = settings.provider || 'openai';
    const maxTime = settings.maxRecordingTime || 120;
    const targetLang = settings.translateTargetLang || 'English';
    
    // Build modes list with special handling for translate mode
    const modesHtml = Object.entries(settings.modes)
      .map(([key, mode]) => {
        let extra = '';
        if (mode.hasLanguageOption && settings.activeMode === key) {
          extra = `<span class="vt-mode-lang">→ ${targetLang}</span>`;
        }
        return `
          <button class="vt-dropdown-item ${settings.activeMode === key ? 'active' : ''}" data-mode="${key}">
            <span class="vt-dropdown-item-icon">${mode.icon}</span>
            <span class="vt-dropdown-item-name">${mode.name}</span>
            ${extra}
          </button>
        `;
      }).join('');
    
    // Language selector for translate mode (only show when translate is active)
    const isTranslateMode = settings.activeMode === 'translate';
    const languageSelector = isTranslateMode ? `
      <div class="vt-dropdown-section">
        <div class="vt-dropdown-label">Translate To</div>
        <div class="vt-dropdown-row vt-lang-row">
          <button class="vt-lang-btn ${targetLang === 'English' ? 'active' : ''}" data-lang="English">EN</button>
          <button class="vt-lang-btn ${targetLang === 'Greek' ? 'active' : ''}" data-lang="Greek">EL</button>
          <button class="vt-lang-btn ${targetLang === 'Spanish' ? 'active' : ''}" data-lang="Spanish">ES</button>
          <button class="vt-lang-btn ${targetLang === 'French' ? 'active' : ''}" data-lang="French">FR</button>
          <button class="vt-lang-btn ${targetLang === 'German' ? 'active' : ''}" data-lang="German">DE</button>
        </div>
      </div>
      <div class="vt-dropdown-divider"></div>
    ` : '';
    
    dropdown.innerHTML = `
      <div class="vt-dropdown-section">
        <div class="vt-dropdown-label">Mode</div>
        ${modesHtml}
      </div>
      ${languageSelector}
      <div class="vt-dropdown-divider"></div>
      <div class="vt-dropdown-section">
        <div class="vt-dropdown-label">Provider</div>
        <div class="vt-dropdown-row">
          ${Object.entries(PROVIDERS).map(([id, p]) => `
            <button class="vt-provider-btn ${provider === id ? 'active' : ''}" data-provider="${id}">${p.label}</button>
          `).join('')}
        </div>
      </div>
      <div class="vt-dropdown-divider"></div>
      <div class="vt-dropdown-section">
        <div class="vt-dropdown-label">Max Recording</div>
        <div class="vt-dropdown-row">
          <button class="vt-time-btn ${maxTime === 30 ? 'active' : ''}" data-time="30">30s</button>
          <button class="vt-time-btn ${maxTime === 60 ? 'active' : ''}" data-time="60">1m</button>
          <button class="vt-time-btn ${maxTime === 120 ? 'active' : ''}" data-time="120">2m</button>
          <button class="vt-time-btn ${maxTime === 180 ? 'active' : ''}" data-time="180">3m</button>
          <button class="vt-time-btn ${maxTime === 300 ? 'active' : ''}" data-time="300">5m</button>
        </div>
      </div>
      <div class="vt-dropdown-divider"></div>
      <div class="vt-dropdown-section">
        <button class="vt-dropdown-item vt-usage-btn" id="vt-usage-toggle">
          <span class="vt-dropdown-item-icon">💰</span>
          <span class="vt-dropdown-item-name">Usage</span>
          <span class="vt-usage-value" id="vt-usage-cost">$0.00</span>
        </button>
        <div class="vt-usage-details" id="vt-usage-details" style="display: none;">
          <div class="vt-usage-row">
            <span>Today</span>
            <span id="vt-today-stats">0 sessions • 0:00</span>
          </div>
          <div class="vt-usage-row">
            <span>All time</span>
            <span id="vt-total-stats">0 sessions • 0:00</span>
          </div>
        </div>
      </div>
      <div class="vt-dropdown-footer">
        <span class="vt-shortcut"><kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>Space</kbd></span>
      </div>
    `;
    
    // Add click handlers for modes
    dropdown.querySelectorAll('.vt-dropdown-item[data-mode]').forEach(item => {
      item.addEventListener('click', (e) => {
        e.stopPropagation();
        selectMode(item.dataset.mode);
      });
    });
    
    // Add click handlers for language selection
    dropdown.querySelectorAll('.vt-lang-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        selectLanguage(btn.dataset.lang);
      });
    });
    
    // Add click handlers for provider
    dropdown.querySelectorAll('.vt-provider-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        selectProvider(btn.dataset.provider);
      });
    });
    
    // Add click handlers for min time
    dropdown.querySelectorAll('.vt-time-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        selectMaxTime(parseInt(btn.dataset.time));
      });
    });
    
    // Usage toggle
    dropdown.querySelector('#vt-usage-toggle').addEventListener('click', (e) => {
      e.stopPropagation();
      const details = dropdown.querySelector('#vt-usage-details');
      details.style.display = details.style.display === 'none' ? 'block' : 'none';
    });
    
    updateModeButton();
  }

  // Load usage stats into dropdown
  async function loadUsageForDropdown() {
    const stats = await send({ action: MSG.GET_USAGE });
    if (!stats?.today || !stats?.total || !pill) return;
    
    const costEl = pill.querySelector('#vt-usage-cost');
    const todayEl = pill.querySelector('#vt-today-stats');
    const totalEl = pill.querySelector('#vt-total-stats');
    
    if (costEl) {
      costEl.textContent = formatCost(stats.total.estimatedCost || 0);
    }
    if (todayEl) {
      todayEl.textContent = `${stats.today.sessions || 0} sessions • ${formatTime(stats.today.audioSeconds || 0)}`;
    }
    if (totalEl) {
      totalEl.textContent = `${stats.total.sessions || 0} sessions • ${formatTime(stats.total.audioSeconds || 0)}`;
    }
  }

  // Format time helper
  function formatTime(seconds) {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  }

  // Select provider
  async function selectProvider(provider) {
    settings.provider = provider;
    saveSettings();
    
    // Update active state without rebuilding dropdown
    const dropdown = pill.querySelector('#vt-dropdown');
    dropdown.querySelectorAll('.vt-provider-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.provider === provider);
    });
    
    showStatus(`Provider: ${PROVIDERS[provider]?.label || provider}`, '');
  }

  // Select max time
  async function selectMaxTime(time) {
    settings.maxRecordingTime = time;
    saveSettings();
    
    // Update active state without rebuilding dropdown
    const dropdown = pill.querySelector('#vt-dropdown');
    dropdown.querySelectorAll('.vt-time-btn').forEach(btn => {
      btn.classList.toggle('active', parseInt(btn.dataset.time) === time);
    });
    
    const label = time >= 60 ? `${time/60}m` : `${time}s`;
    showStatus(`Max: ${label}`, '');
  }

  // Select language for translate mode
  async function selectLanguage(lang) {
    settings.translateTargetLang = lang;
    saveSettings();
    
    // Update active state without rebuilding dropdown
    const dropdown = pill.querySelector('#vt-dropdown');
    dropdown.querySelectorAll('.vt-lang-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.lang === lang);
    });
    
    // Update the mode indicator
    const translateModeItem = dropdown.querySelector('.vt-dropdown-item[data-mode="translate"]');
    if (translateModeItem) {
      let langSpan = translateModeItem.querySelector('.vt-mode-lang');
      if (langSpan) {
        langSpan.textContent = `→ ${lang}`;
      }
    }
    
    showStatus(`Translate → ${lang}`, '');
  }

  // Save settings helper
  function saveSettings() {
    send({ action: MSG.SAVE_SETTINGS, settings });
  }

  // Select mode
  async function selectMode(modeKey) {
    settings.activeMode = modeKey;
    saveSettings();
    
    // Update active state without rebuilding dropdown
    const dropdown = pill.querySelector('#vt-dropdown');
    dropdown.querySelectorAll('.vt-dropdown-item').forEach(item => {
      item.classList.toggle('active', item.dataset.mode === modeKey);
    });
    
    // Update mode button
    updateModeButton();
    
    // Show/hide language selector based on mode
    const langRow = dropdown.querySelector('.vt-lang-row');
    if (langRow) {
      langRow.style.display = modeKey === 'translate' ? 'flex' : 'none';
    }
    
    const mode = settings.modes[modeKey];
    showStatus(`${mode.icon} ${mode.name}`, '');
  }

  // Toggle dropdown
  function toggleDropdown() {
    if (dropdownOpen) {
      closeDropdown();
    } else {
      openDropdown();
    }
  }

  // Open dropdown
  function openDropdown() {
    const dropdown = pill.querySelector('#vt-dropdown');
    dropdown.classList.add('show');
    dropdownOpen = true;
    loadUsageForDropdown(); // Refresh usage stats when opening
  }

  // Close dropdown
  function closeDropdown() {
    const dropdown = pill.querySelector('#vt-dropdown');
    dropdown.classList.remove('show');
    dropdownOpen = false;
  }

  // Handle document mousedown (close dropdown if click outside)
  function handleDocumentClick(e) {
    if (dropdownOpen && pill && !pill.contains(e.target)) {
      closeDropdown();
    }
  }

  // Handle pill mouse enter
  function handlePillMouseEnter() {
    clearTimeout(hoverTimeout);
    if (!isExpanded && !isRecording) {
      hoverTimeout = setTimeout(() => {
        expandPill();
      }, 150);
    }
  }

  // Handle pill mouse leave
  function handlePillMouseLeave() {
    clearTimeout(hoverTimeout);
    
    if (!isRecording && !dropdownOpen) {
      hoverTimeout = setTimeout(() => {
        collapsePill();
      }, 300);
    }
  }

  // Expand pill
  function expandPill() {
    if (!pill) return;
    pill.classList.remove('collapsed');
    pill.classList.add('expanded');
    isExpanded = true;
  }

  // Collapse pill
  function collapsePill() {
    if (!pill || isRecording || dropdownOpen) return;
    pill.classList.remove('expanded');
    pill.classList.add('collapsed');
    isExpanded = false;
  }

  // Show pill near input (on the LEFT, anchored by right edge so it expands leftward)
  function showPill(input) {
    if (!pill || !input) return;
    
    const rect = input.getBoundingClientRect();
    const scrollTop = window.scrollY || document.documentElement.scrollTop;
    const scrollLeft = window.scrollX || document.documentElement.scrollLeft;
    const viewportWidth = document.documentElement.scrollWidth;
    
    // Position to the LEFT of the input with gap
    // The pill's RIGHT edge should be [gap]px away from the input's left edge
    const gap = settings?.pillGap ?? 8; // Gap between pill and text field (from settings)
    const collapsedSize = 16; // Size of collapsed dot
    
    let top = rect.top + scrollTop + (rect.height / 2) - (collapsedSize / 2);
    let rightEdgeFromLeft = rect.left + scrollLeft - gap; // Where the right edge of pill should be
    
    // Calculate 'right' value (distance from right edge of document)
    let rightValue = viewportWidth - rightEdgeFromLeft;
    
    // Ensure minimum distance from right edge of viewport
    if (rightValue < 50) {
      rightValue = 50;
    }
    
    pill.style.top = `${top}px`;
    pill.style.left = 'auto';
    pill.style.right = `${rightValue}px`;
    pill.style.display = 'flex';
  }

  // Hide pill
  function hidePill() {
    if (pill && !isRecording) {
      pill.style.display = 'none';
      collapsePill();
      closeDropdown();
    }
  }

  // Handle focus in (composedPath reaches inputs inside open shadow roots)
  function handleFocusIn(e) {
    const target = e.composedPath ? e.composedPath()[0] : e.target;
    if (isValidInput(target)) {
      currentInput = target;
      showPill(target);
    }
  }

  // Handle focus out
  function handleFocusOut(e) {
    // Don't hide anything while recording or while the microphone is starting
    if (isRecording || isStarting) return;
    
    // Small delay to allow clicking the pill
    setTimeout(() => {
      if (isRecording || isStarting) return;
      
      if (deepActiveElement() !== currentInput) {
        if (!pill?.contains(deepActiveElement())) {
          hidePill();
        }
      }
    }, 200);
  }

  // Toggle recording (with debounce for button clicks)
  async function toggleRecording() {
    const now = Date.now();
    
    // Debounce - ignore if less than 500ms since last toggle (for rapid button clicks)
    if (now - lastToggleTime < 500) return;
    lastToggleTime = now;
    
    // Don't toggle if we're in the middle of stopping or processing
    if (isStopping || isProcessing || isStarting) return;
    
    if (isRecording) {
      await stopRecording();
    } else {
      await startRecording();
    }
  }

  // Start recording
  async function startRecording() {
    if (isRecording || isStopping || isStarting) return;
    isStarting = true;
    try {
      const apiCheck = await send({ action: MSG.CHECK_KEY });
      if (!apiCheck) return; // send() already reported the failure; keep its notice visible
      if (!apiCheck.hasKey) {
        showStatus('Add an API key in the extension settings', 'error');
        return;
      }
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      audioChunks = [];
      mediaRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm;codecs=opus', audioBitsPerSecond: 32000 });
      mediaRecorder.ondataavailable = (e) => { if (e.data.size > 0) audioChunks.push(e.data); };
      mediaRecorder.onstop = handleRecordingComplete;
      setupAudioAnalyzer(stream);
      mediaRecorder.start(100);
      recordingStartTime = Date.now();
      isRecording = true; // only now: nothing can observe a half-started recorder

      const maxTime = (settings?.maxRecordingTime || 120) * 1000;
      maxRecordingTimer = setTimeout(() => {
        if (isRecording && !isStopping) {
          showStatus('Max time reached', '');
          stopRecording();
        }
      }, maxTime);

      pill.classList.add('recording');
      expandPill();
      updateRecordButton(true);
      startRecordingTimer();
      startVoiceVisualization();
    } catch (err) {
      console.error('VoiceType: Failed to start recording', err);
      showStatus(err?.name === 'NotAllowedError' ? 'Microphone access denied' : 'Could not start the microphone', 'error');
    } finally {
      isStarting = false;
    }
  }

  // Set up audio analyzer for voice level detection
  function setupAudioAnalyzer(stream) {
    try {
      audioContext = new (window.AudioContext || window.webkitAudioContext)();
      analyser = audioContext.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.8;
      
      const source = audioContext.createMediaStreamSource(stream);
      source.connect(analyser);
    } catch (err) {
      console.error('VoiceType: Failed to set up audio analyzer', err);
    }
  }

  // Voice visualization - glow effect based on audio level
  function startVoiceVisualization() {
    if (!analyser || !pill) return;
    
    const dataArray = new Uint8Array(analyser.frequencyBinCount);
    
    function updateGlow() {
      if (!isRecording) return;
      
      analyser.getByteFrequencyData(dataArray);
      
      // Calculate average volume (0-255)
      let sum = 0;
      for (let i = 0; i < dataArray.length; i++) {
        sum += dataArray[i];
      }
      const average = sum / dataArray.length;
      
      // Normalize to 0-1 range, with boost for sensitivity
      const normalizedLevel = Math.min(1, (average / 100) * 1.5);
      
      // Apply BIGGER glow effect (40% larger than before)
      const innerGlow = 14 + (normalizedLevel * 56);    // 14px to 70px
      const outerGlow = 28 + (normalizedLevel * 112);   // 28px to 140px
      const extraGlow = 56 + (normalizedLevel * 168);   // 56px to 224px
      const glowOpacity = 0.4 + (normalizedLevel * 0.5); // 0.4 to 0.9
      
      pill.style.boxShadow = `
        0 0 ${innerGlow}px rgba(239, 68, 68, ${glowOpacity}),
        0 0 ${outerGlow}px rgba(239, 68, 68, ${glowOpacity * 0.6}),
        0 0 ${extraGlow}px rgba(239, 68, 68, ${glowOpacity * 0.3})
      `;
      
      animationFrameId = requestAnimationFrame(updateGlow);
    }
    
    updateGlow();
  }

  // Stop voice visualization
  function stopVoiceVisualization() {
    if (animationFrameId) {
      cancelAnimationFrame(animationFrameId);
      animationFrameId = null;
    }
    
    if (audioContext) {
      audioContext.close().catch(() => {});
      audioContext = null;
      analyser = null;
    }
    
    // Reset glow
    if (pill) {
      pill.style.boxShadow = '';
    }
  }

  // Stop recording
  async function stopRecording() {
    // Prevent multiple stop calls
    if (isStopping || !isRecording) return;
    
    // Set flags FIRST
    isStopping = true;
    isRecording = false;
    
    // Clear max recording timer
    if (maxRecordingTimer) {
      clearTimeout(maxRecordingTimer);
      maxRecordingTimer = null;
    }
    
    // Update UI immediately
    pill?.classList.remove('recording');
    stopRecordingTimer();
    stopVoiceVisualization();
    updateRecordButton(false);
    
    // Stop the media recorder
    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
      try {
        mediaRecorder.stop();
        // Stop all tracks
        if (mediaRecorder.stream) {
          mediaRecorder.stream.getTracks().forEach(track => track.stop());
        }
      } catch (e) {
        console.error('VoiceType: Error stopping mediaRecorder', e);
      }
    }
  }

  // Update record button UI
  function updateRecordButton(recording) {
    const btn = pill.querySelector('.vt-record-btn');
    const textEl = btn.querySelector('span:last-child');
    
    if (recording) {
      btn.classList.add('recording');
      textEl.className = 'vt-record-timer';
      textEl.textContent = '0:00'; // Always reset to 0:00 when starting
    } else {
      btn.classList.remove('recording');
      textEl.className = 'vt-record-text';
      textEl.textContent = 'REC';
    }
  }

  // Start recording timer
  function startRecordingTimer() {
    // Clear any existing timer first
    stopRecordingTimer();
    
    const timerEl = pill.querySelector('.vt-record-timer');
    if (timerEl) {
      timerEl.textContent = '0:00'; // Ensure reset
    }
    
    recordingTimer = setInterval(() => {
      if (!recordingStartTime) return;
      
      const elapsed = Math.floor((Date.now() - recordingStartTime) / 1000);
      const mins = Math.floor(elapsed / 60);
      const secs = elapsed % 60;
      
      const timerEl = pill.querySelector('.vt-record-timer');
      if (timerEl) {
        timerEl.textContent = `${mins}:${secs.toString().padStart(2, '0')}`;
      }
    }, 100);
  }

  // Stop recording timer
  function stopRecordingTimer() {
    if (recordingTimer) {
      clearInterval(recordingTimer);
      recordingTimer = null;
    }
  }

  // Handle recording complete
  async function handleRecordingComplete() {
    if (isProcessing) { isStopping = false; return; }
    isProcessing = true;
    // Take this recording's chunks now: a shortcut toggle may start the next recording
    // while this one is still being transcribed.
    const chunks = audioChunks;
    audioChunks = [];
    const recordingDuration = recordingStartTime ? (Date.now() - recordingStartTime) / 1000 : 0;
    recordingStartTime = null;
    const minTime = Number(settings?.minRecordingTime ?? 1);

    try {
      if (recordingDuration < minTime) {
        showStatus('Too short, ignored', 'warning');
        collapsePill();
        return;
      }
      if (chunks.length === 0) {
        showStatus('No audio recorded', 'warning');
        return;
      }
      showStatus('Processing…', 'processing', { sticky: true });

      const audioBlob = new Blob(chunks, { type: 'audio/webm' });
      const base64 = await blobToBase64(audioBlob);
      const watchdog = new Promise((resolve) => {
        setTimeout(() => resolve({ success: false, error: 'No response from the extension. Try again.' }), 75_000);
      });
      const response = await Promise.race([
        send({
          action: MSG.TRANSCRIBE,
          audioBase64: base64,
          mimeType: 'audio/webm',
          mode: settings?.activeMode || 'default',
          audioDuration: recordingDuration,
        }),
        watchdog,
      ]);
      if (!response) throw new Error('VoiceType is not responding. Reload the page.');
      if (!response.success) throw new Error(response.error || 'Transcription failed');

      const outcome = await insertText(currentInput, response.text);
      if (outcome === 'inserted') {
        if (typeof response.warning === 'string' && response.warning) showStatus(response.warning, 'warning');
        else showStatus(`Done ${formatCost(response.cost || 0)}`, 'success');
      } else if (outcome === 'clipboard') showStatus('Copied to clipboard (field not editable)', 'warning');
      else showStatus('Could not insert or copy the text', 'error');
      setTimeout(collapsePill, 1500);
    } catch (err) {
      console.error('VoiceType: Transcription failed', err);
      showStatus(err.message, 'error');
    } finally {
      isProcessing = false;
      isStopping = false;
    }
  }

  // Convert blob to base64
  function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => {
        const base64 = reader.result.split(',')[1];
        resolve(base64);
      };
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  }

  // Show status message (sticky ones stay until the next message replaces them)
  function showStatus(message, type = '', { sticky = false } = {}) {
    if (!pill) return;
    const statusEl = pill.querySelector('.vt-status');
    statusEl.textContent = message;
    statusEl.className = `vt-status show ${type}`;
    clearTimeout(statusTimeout);
    if (!sticky) statusTimeout = setTimeout(() => statusEl.classList.remove('show'), 2500);
  }

  // Keyboard shortcut from the service worker. Registered at load, before init() awaits
  // settings, so an early toggle is queued instead of lost and the service worker's
  // fallback injection never runs a second copy of this script.
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === MSG.TOGGLE_RECORDING) {
      if (pill) handleToggleCommand();
      else pendingToggle = true; // pill exists only once init() has settings; init() runs it
      sendResponse({ received: true });
    }
    return false;
  });

  // Listen for settings changes (an open dropdown is not rebuilt under the cursor)
  chrome.storage.onChanged.addListener((changes, namespace) => {
    if (namespace === 'local' && changes.settings) {
      settings = changes.settings.newValue;
      if (dropdownOpen) updateModeButton(); else updateDropdown();
    }
  });

  // Initialize when DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
