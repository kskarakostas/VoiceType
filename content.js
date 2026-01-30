// VoiceType - Content Script
// Expandable pill toolbar for speech-to-text

(function() {
  'use strict';
  
  // State
  let isRecording = false;
  let isStopping = false; // Prevent race conditions during stop
  let isProcessing = false; // Lock to prevent multiple transcriptions
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
  let audioContext = null;
  let analyser = null;
  let animationFrameId = null;

  // Initialize
  async function init() {
    if (isInitialized) return;
    isInitialized = true;
    
    try {
      // Load settings
      settings = await new Promise((resolve) => {
        chrome.runtime.sendMessage({ action: 'getSettings' }, (response) => {
          if (chrome.runtime.lastError) {
            resolve(null);
          } else {
            resolve(response);
          }
        });
      });
      
      // Use default settings if none returned
      if (!settings) {
        settings = {
          provider: 'openai',
          model: 'gpt-4o-transcribe',
          geminiModel: 'gemini-2.5-flash',
          activeMode: 'default',
          minRecordingTime: 0,
          maxRecordingTime: 60,
          modes: {
            default: { name: 'Default', prompt: 'Transcribe accurately.', icon: '🎤' }
          }
        };
      }
      
      // Create UI elements
      createPill();
      
      // Listen for input focus
      document.addEventListener('focusin', handleFocusIn);
      document.addEventListener('focusout', handleFocusOut);
      
      // Listen for clicks outside to close dropdown (use mousedown to catch before DOM changes)
      document.addEventListener('mousedown', handleDocumentClick);
      
      // Listen for keyboard shortcut from background
      chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
        if (request.action === 'toggle-recording') {
          // If recording, stop it
          if (isRecording) {
            stopRecording();
            sendResponse({ received: true });
            return false;
          }
          
          // Force reset any stuck flags
          isStopping = false;
          isProcessing = false;
          
          // Ensure we have an input
          if (!currentInput) {
            const activeEl = document.activeElement;
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
          sendResponse({ received: true });
        }
        return false;
      });
      
      // Check if there's already a focused input
      const activeEl = document.activeElement;
      if (isValidInput(activeEl)) {
        currentInput = activeEl;
        showPill(activeEl);
      }
    } catch (err) {
      console.error('VoiceType: Initialization error', err);
    }
  }

  // Check if element is a valid text input
  function isValidInput(el) {
    if (!el) return false;
    
    const tagName = el.tagName?.toLowerCase();
    const type = el.type?.toLowerCase();
    
    // Standard inputs
    if (tagName === 'textarea') return true;
    if (tagName === 'input') {
      const textTypes = ['text', 'search', 'email', 'url', 'tel', 'password'];
      return textTypes.includes(type) || !type;
    }
    
    // Contenteditable elements
    if (el.isContentEditable) return true;
    if (el.getAttribute('contenteditable') === 'true') return true;
    
    // Check for common editor roles
    if (el.getAttribute('role') === 'textbox') return true;
    
    return false;
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
    const maxTime = settings.maxRecordingTime || 60;
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
    
    // Build model buttons based on provider
    const openaiModels = `
      <button class="vt-model-btn ${settings.model === 'gpt-4o-transcribe' ? 'active' : ''}" data-model="gpt-4o-transcribe">
        gpt-4o
      </button>
      <button class="vt-model-btn ${settings.model === 'gpt-4o-mini-transcribe' ? 'active' : ''}" data-model="gpt-4o-mini-transcribe">
        gpt-4o-mini
      </button>
    `;
    
    const geminiModels = `
      <button class="vt-model-btn ${settings.geminiModel === 'gemini-3-flash-preview' ? 'active' : ''}" data-model="gemini-3-flash-preview">
        3 Flash
      </button>
      <button class="vt-model-btn ${settings.geminiModel === 'gemini-2.5-flash' ? 'active' : ''}" data-model="gemini-2.5-flash">
        2.5 Flash
      </button>
    `;
    
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
          <button class="vt-provider-btn ${provider === 'openai' ? 'active' : ''}" data-provider="openai">
            OpenAI
          </button>
          <button class="vt-provider-btn ${provider === 'gemini' ? 'active' : ''}" data-provider="gemini">
            Gemini
          </button>
        </div>
      </div>
      <div class="vt-dropdown-section">
        <div class="vt-dropdown-label">Model</div>
        <div class="vt-dropdown-row vt-model-row">
          ${provider === 'openai' ? openaiModels : geminiModels}
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
    
    // Add click handlers for model
    dropdown.querySelectorAll('.vt-model-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        selectModel(btn.dataset.model);
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
    loadUsageForDropdown();
  }

  // Load usage stats into dropdown
  async function loadUsageForDropdown() {
    const stats = await new Promise(resolve => {
      chrome.runtime.sendMessage({ action: 'getUsageStats' }, resolve);
    });
    
    if (!stats || !pill) return;
    
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

  // Format cost helper
  function formatCost(cost) {
    if (cost < 0.01) return '$' + cost.toFixed(4);
    return '$' + cost.toFixed(2);
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
    
    // Update model buttons for new provider
    const modelRow = dropdown.querySelector('.vt-model-row');
    if (modelRow) {
      if (provider === 'openai') {
        modelRow.innerHTML = `
          <button class="vt-model-btn ${settings.model === 'gpt-4o-transcribe' ? 'active' : ''}" data-model="gpt-4o-transcribe">gpt-4o</button>
          <button class="vt-model-btn ${settings.model === 'gpt-4o-mini-transcribe' ? 'active' : ''}" data-model="gpt-4o-mini-transcribe">gpt-4o-mini</button>
        `;
      } else {
        modelRow.innerHTML = `
          <button class="vt-model-btn ${settings.geminiModel === 'gemini-3-flash-preview' ? 'active' : ''}" data-model="gemini-3-flash-preview">3 Flash</button>
          <button class="vt-model-btn ${settings.geminiModel === 'gemini-2.5-flash' ? 'active' : ''}" data-model="gemini-2.5-flash">2.5 Flash</button>
        `;
      }
      // Re-add click handlers for new model buttons
      modelRow.querySelectorAll('.vt-model-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          selectModel(btn.dataset.model);
        });
      });
    }
    
    showStatus(`Provider: ${provider === 'openai' ? 'OpenAI' : 'Gemini'}`, '');
  }

  // Select model
  async function selectModel(model) {
    const provider = settings.provider || 'openai';
    if (provider === 'gemini') {
      settings.geminiModel = model;
    } else {
      settings.model = model;
    }
    saveSettings();
    
    // Update active state without rebuilding dropdown
    const dropdown = pill.querySelector('#vt-dropdown');
    dropdown.querySelectorAll('.vt-model-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.model === model);
    });
    
    const modelNames = {
      'gpt-4o-transcribe': 'gpt-4o',
      'gpt-4o-mini-transcribe': 'gpt-4o-mini',
      'gemini-3-flash-preview': 'Gemini 3 Flash',
      'gemini-2.5-flash': 'Gemini 2.5 Flash'
    };
    showStatus(`Model: ${modelNames[model] || model}`, '');
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
    chrome.runtime.sendMessage({ 
      action: 'saveSettings', 
      settings: settings 
    });
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
    // The pill's RIGHT edge should be 8px away from the input's left edge
    const gap = 8; // Gap between pill and text field
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

  // Handle focus in
  function handleFocusIn(e) {
    if (isValidInput(e.target)) {
      currentInput = e.target;
      showPill(e.target);
    }
  }

  // Handle focus out
  function handleFocusOut(e) {
    // Don't hide anything while recording
    if (isRecording) return;
    
    // Small delay to allow clicking the pill
    setTimeout(() => {
      if (isRecording) return;
      
      if (document.activeElement !== currentInput) {
        if (!pill?.contains(document.activeElement)) {
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
    if (isStopping || isProcessing) return;
    
    if (isRecording) {
      await stopRecording();
    } else {
      await startRecording();
    }
  }

  // Start recording
  async function startRecording() {
    // Prevent starting if already recording or stopping
    if (isRecording || isStopping) return;
    
    // Check for API key
    const apiCheck = await new Promise(resolve => {
      chrome.runtime.sendMessage({ action: 'checkApiKey' }, resolve);
    });
    
    if (!apiCheck.hasKey) {
      showStatus('⚠️ Add API key in extension settings', 'error');
      return;
    }
    
    try {
      // Set recording flag FIRST to prevent race conditions
      isRecording = true;
      
      const stream = await navigator.mediaDevices.getUserMedia({ 
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        }
      });
      
      audioChunks = [];
      mediaRecorder = new MediaRecorder(stream, {
        mimeType: 'audio/webm;codecs=opus'
      });
      
      mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) {
          audioChunks.push(e.data);
        }
      };
      
      mediaRecorder.onstop = handleRecordingComplete;
      
      // Set up audio analyzer for voice visualization
      setupAudioAnalyzer(stream);
      
      mediaRecorder.start(100);
      recordingStartTime = Date.now();
      
      // Set up max recording time auto-stop
      const maxTime = (settings?.maxRecordingTime || 60) * 1000; // Convert to ms
      if (maxTime > 0) {
        maxRecordingTimer = setTimeout(() => {
          if (isRecording && !isStopping) {
            showStatus('⏱️ Max time reached', '');
            stopRecording();
          }
        }, maxTime);
      }
      
      // Update UI
      pill.classList.add('recording');
      expandPill();
      updateRecordButton(true);
      startRecordingTimer();
      startVoiceVisualization();
      
    } catch (err) {
      // Reset state on error
      isRecording = false;
      console.error('VoiceType: Failed to start recording', err);
      showStatus('❌ Microphone access denied', 'error');
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
    // Prevent duplicate processing
    if (isProcessing) {
      isStopping = false;
      return;
    }
    isProcessing = true;
    
    const recordingDuration = recordingStartTime ? (Date.now() - recordingStartTime) / 1000 : 0;
    recordingStartTime = null;
    
    // Minimum 3 seconds - treat shorter as misclick, silently ignore
    if (recordingDuration < 3) {
      audioChunks = [];
      isProcessing = false;
      isStopping = false;
      collapsePill();
      return;
    }
    
    // Check if we have audio data
    if (audioChunks.length === 0) {
      showStatus('⚠️ No audio recorded', 'warning');
      isProcessing = false;
      isStopping = false;
      return;
    }
    
    showStatus('⏳ Processing...', 'processing');
    
    try {
      // Convert audio to base64
      const audioBlob = new Blob(audioChunks, { type: 'audio/webm' });
      const base64 = await blobToBase64(audioBlob);
      
      // Clear chunks immediately to prevent reuse
      audioChunks = [];
      
      // Send to background for transcription
      const response = await new Promise((resolve, reject) => {
        chrome.runtime.sendMessage({
          action: 'transcribe',
          audioBlob: base64,
          mode: settings?.activeMode || 'default',
          audioDuration: recordingDuration
        }, (result) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
          } else {
            resolve(result);
          }
        });
      });
      
      if (response.success) {
        insertText(response.text);
        showStatus('✓ Done!', 'success');
        
        // Collapse pill after 1.5 seconds
        setTimeout(() => {
          collapsePill();
        }, 1500);
      } else {
        throw new Error(response.error);
      }
      
    } catch (err) {
      console.error('VoiceType: Transcription failed', err);
      showStatus(`❌ ${err.message}`, 'error');
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

  // Insert text into current input
  function insertText(text) {
    if (!currentInput || !text) return;
    
    // Focus the input
    currentInput.focus();
    
    if (currentInput.isContentEditable || currentInput.getAttribute('contenteditable') === 'true') {
      // For contenteditable elements
      const selection = window.getSelection();
      const range = selection.getRangeAt(0);
      
      range.deleteContents();
      
      const textNode = document.createTextNode(text);
      range.insertNode(textNode);
      
      range.setStartAfter(textNode);
      range.setEndAfter(textNode);
      selection.removeAllRanges();
      selection.addRange(range);
      
      currentInput.dispatchEvent(new Event('input', { bubbles: true }));
      
    } else {
      // For regular inputs and textareas
      const start = currentInput.selectionStart || 0;
      const end = currentInput.selectionEnd || 0;
      const value = currentInput.value || '';
      
      currentInput.value = value.slice(0, start) + text + value.slice(end);
      
      const newPos = start + text.length;
      currentInput.setSelectionRange(newPos, newPos);
      
      currentInput.dispatchEvent(new Event('input', { bubbles: true }));
      currentInput.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }

  // Show status message
  function showStatus(message, type = '') {
    if (!pill) return;
    
    const statusEl = pill.querySelector('.vt-status');
    statusEl.textContent = message;
    statusEl.className = `vt-status show ${type}`;
    
    clearTimeout(statusTimeout);
    statusTimeout = setTimeout(() => {
      statusEl.classList.remove('show');
    }, 2500);
  }

  // Listen for settings changes
  chrome.storage.onChanged.addListener((changes, namespace) => {
    if (namespace === 'local' && changes.settings) {
      settings = changes.settings.newValue;
      updateDropdown();
    }
  });

  // Initialize when DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
  
})();
