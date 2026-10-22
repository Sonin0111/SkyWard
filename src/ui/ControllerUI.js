/**
 * Interactive Controller Configuration & Calibration UI (Collapsible Panel toggled via 'C').
 * Designed for USB HID RC Transmitters (RadioMaster TX12, Boxer, Pocket, EdgeTX / OpenTX)
 * and standard HTML5 Gamepads.
 */
export class ControllerUI {
  constructor(containerEl, inputManager) {
    this.container = containerEl;
    this.inputManager = inputManager;
    this.isVisible = false;

    this._axisBarEls = [];
    this._axisValEls = [];
    this._buttonEls = [];

    this._buildDOM();
    this.syncControlsFromProfile();
  }

  _buildDOM() {
    this.container.innerHTML = `
      <div class="ctrl-panel-header">
        <div>
          <h2 class="ctrl-title">RC TRANSMITTER & CONTROLLER CONFIGURATION [C]</h2>
          <div id="ctrl-device-status" class="ctrl-subtitle">Scanning USB HID Gamepad API...</div>
        </div>
        <div class="ctrl-header-actions">
          <button id="ctrl-reset-btn" class="hud-btn">Reset Default AETR</button>
          <button id="ctrl-close-btn" class="hud-btn hud-btn-primary">Close [C]</button>
        </div>
      </div>

      <div class="ctrl-grid">
        <!-- Left Column: Real-Time Axes 0-7 & Buttons 0-15 Telemetry -->
        <div class="ctrl-section">
          <h3>REAL-TIME USB HID TELEMETRY (AXES 0–7)</h3>
          <div id="ctrl-axes-list" class="axes-list"></div>

          <h3 style="margin-top:14px;">ACTIVE SWITCHES / BUTTONS (0–15)</h3>
          <div id="ctrl-buttons-grid" class="buttons-grid"></div>
        </div>

        <!-- Right Column: Channel Assignment, Inversion, Expo/Deadzone & Switch Mapping -->
        <div class="ctrl-section">
          <h3>AETR CHANNEL MAPPING & AXIS INVERSION</h3>
          <p class="ctrl-hint">Default Mode 2 EdgeTX/OpenTX: Ch1=Roll(Ax0), Ch2=Pitch(Ax1), Ch3=Throttle(Ax2), Ch4=Yaw(Ax3)</p>

          <div class="mapping-rows" id="ctrl-axis-mappings"></div>

          <h3 style="margin-top:14px;">EXPO CURVE & CENTER DEADZONE</h3>
          <div class="slider-row">
            <label for="ctrl-expo-slider">Expo Smoothing Curve:</label>
            <input type="range" id="ctrl-expo-slider" min="0" max="0.80" step="0.01" value="0.30" />
            <span id="ctrl-expo-val" class="mono-val">0.30</span>
          </div>
          <div class="slider-row">
            <label for="ctrl-dz-slider">Center Stick Deadzone:</label>
            <input type="range" id="ctrl-dz-slider" min="0" max="0.15" step="0.005" value="0.02" />
            <span id="ctrl-dz-val" class="mono-val">0.020</span>
          </div>

          <h3 style="margin-top:14px;">AUXILIARY SWITCH BINDINGS (CH 5 / 6 / 7)</h3>
          <div class="mapping-rows" id="ctrl-switch-mappings"></div>
        </div>
      </div>
    `;

    // Build Axes 0..7 visual bars
    const axesList = this.container.querySelector('#ctrl-axes-list');
    for (let i = 0; i < 8; i++) {
      const row = document.createElement('div');
      row.className = 'axis-bar-row';
      row.innerHTML = `
        <span class="axis-label">AXIS ${i} (CH${i + 1})</span>
        <div class="axis-bar-track">
          <div class="axis-bar-center"></div>
          <div class="axis-bar-fill" id="axis-fill-${i}"></div>
        </div>
        <span class="axis-num" id="axis-val-${i}">0.00</span>
      `;
      axesList.appendChild(row);
      this._axisBarEls.push(row.querySelector(`#axis-fill-${i}`));
      this._axisValEls.push(row.querySelector(`#axis-val-${i}`));
    }

    // Build Buttons 0..15 indicators
    const btnGrid = this.container.querySelector('#ctrl-buttons-grid');
    for (let b = 0; b < 16; b++) {
      const badge = document.createElement('div');
      badge.className = 'btn-badge';
      badge.textContent = `B${b}`;
      btnGrid.appendChild(badge);
      this._buttonEls.push(badge);
    }

    // Build Flight Axis Assignment Rows
    const axisActions = [
      { key: 'roll', label: 'Roll (Aileron)' },
      { key: 'pitch', label: 'Pitch (Elevator)' },
      { key: 'throttle', label: 'Throttle [-1..+1 -> 0..100%]' },
      { key: 'yaw', label: 'Yaw (Rudder)' }
    ];

    const axisMapContainer = this.container.querySelector('#ctrl-axis-mappings');
    axisActions.forEach(({ key, label }) => {
      const row = document.createElement('div');
      row.className = 'map-row';

      const optionsHtml = Array.from({ length: 8 }, (_, idx) => `<option value="${idx}">Axis ${idx} (Ch ${idx + 1})</option>`).join('');

      row.innerHTML = `
        <span class="map-name">${label}</span>
        <select id="map-axis-${key}" class="hud-select">${optionsHtml}</select>
        <label class="invert-label">
          <input type="checkbox" id="map-inv-${key}" /> Invert
        </label>
        <button id="map-detect-axis-${key}" class="hud-btn hud-btn-sm">Detect</button>
      `;
      axisMapContainer.appendChild(row);

      const sel = row.querySelector(`#map-axis-${key}`);
      const inv = row.querySelector(`#map-inv-${key}`);
      const detectBtn = row.querySelector(`#map-detect-axis-${key}`);

      sel.addEventListener('change', () => {
        this.inputManager.profile.axes[key] = parseInt(sel.value, 10);
        this.inputManager.saveProfile();
      });

      inv.addEventListener('change', () => {
        this.inputManager.profile.invert[key] = inv.checked;
        this.inputManager.saveProfile();
      });

      detectBtn.addEventListener('click', () => {
        detectBtn.textContent = 'Move Stick...';
        detectBtn.classList.add('listening');
        this.inputManager.startListening('axis', key, () => {
          detectBtn.textContent = 'Detect';
          detectBtn.classList.remove('listening');
          this.syncControlsFromProfile();
        });
      });
    });

    // Build Auxiliary Switch Binding Rows
    const switchActions = [
      { key: 'cameraView', label: 'Camera View Toggle [V]' },
      { key: 'thermalMode', label: 'Thermal IR Mode Toggle [T]' },
      { key: 'detonate', label: 'Detonate Warhead [Space]' }
    ];

    const switchContainer = this.container.querySelector('#ctrl-switch-mappings');
    switchActions.forEach(({ key, label }) => {
      const row = document.createElement('div');
      row.className = 'map-row';
      row.innerHTML = `
        <span class="map-name">${label}</span>
        <span id="sw-badge-${key}" class="sw-binding-tag">BTN 0</span>
        <button id="sw-bind-btn-${key}" class="hud-btn hud-btn-sm">Bind Switch</button>
      `;
      switchContainer.appendChild(row);

      const bindBtn = row.querySelector(`#sw-bind-btn-${key}`);
      bindBtn.addEventListener('click', () => {
        bindBtn.textContent = 'Flip Switch...';
        bindBtn.classList.add('listening');
        this.inputManager.startListening('switch', key, () => {
          bindBtn.textContent = 'Bind Switch';
          bindBtn.classList.remove('listening');
          this.syncControlsFromProfile();
        });
      });
    });

    // Sliders & Header buttons
    const expoSlider = this.container.querySelector('#ctrl-expo-slider');
    const expoVal = this.container.querySelector('#ctrl-expo-val');
    expoSlider.addEventListener('input', () => {
      const v = parseFloat(expoSlider.value);
      this.inputManager.profile.expo = v;
      expoVal.textContent = v.toFixed(2);
      this.inputManager.saveProfile();
    });

    const dzSlider = this.container.querySelector('#ctrl-dz-slider');
    const dzVal = this.container.querySelector('#ctrl-dz-val');
    dzSlider.addEventListener('input', () => {
      const v = parseFloat(dzSlider.value);
      this.inputManager.profile.deadzone = v;
      dzVal.textContent = v.toFixed(3);
      this.inputManager.saveProfile();
    });

    this.container.querySelector('#ctrl-reset-btn').addEventListener('click', () => {
      this.inputManager.cancelListening();
      this.inputManager.resetProfileToDefault();
      this.syncControlsFromProfile();
    });

    this.container.querySelector('#ctrl-close-btn').addEventListener('click', () => {
      this.toggle(false);
    });
  }

  syncControlsFromProfile() {
    const p = this.inputManager.profile;
    ['roll', 'pitch', 'throttle', 'yaw'].forEach((key) => {
      const sel = this.container.querySelector(`#map-axis-${key}`);
      const inv = this.container.querySelector(`#map-inv-${key}`);
      if (sel) sel.value = String(p.axes[key]);
      if (inv) inv.checked = Boolean(p.invert[key]);
    });

    const expoSlider = this.container.querySelector('#ctrl-expo-slider');
    const expoVal = this.container.querySelector('#ctrl-expo-val');
    if (expoSlider) expoSlider.value = String(p.expo);
    if (expoVal) expoVal.textContent = p.expo.toFixed(2);

    const dzSlider = this.container.querySelector('#ctrl-dz-slider');
    const dzVal = this.container.querySelector('#ctrl-dz-val');
    if (dzSlider) dzSlider.value = String(p.deadzone);
    if (dzVal) dzVal.textContent = p.deadzone.toFixed(3);

    ['cameraView', 'thermalMode', 'detonate'].forEach((key) => {
      const badge = this.container.querySelector(`#sw-badge-${key}`);
      const b = p.switches[key];
      if (badge && b) {
        badge.textContent = b.type === 'axis'
          ? `AXIS ${b.index} (CH${b.index + 1})`
          : `BUTTON ${b.index}${b.auxAxis >= 0 ? ` / CH${b.auxAxis + 1}` : ''}`;
      }
    });
  }

  toggle(forceState) {
    this.isVisible = typeof forceState === 'boolean' ? forceState : !this.isVisible;
    if (!this.isVisible) {
      this.inputManager.cancelListening();
    } else {
      this.syncControlsFromProfile();
    }
    this.container.classList.toggle('hidden', !this.isVisible);
    return this.isVisible;
  }

  /**
   * Updates real-time axis bars and button badges when panel is open.
   */
  update() {
    if (!this.isVisible) return;

    const status = this.inputManager.getStatusSummary();
    const statusEl = this.container.querySelector('#ctrl-device-status');
    if (statusEl) {
      statusEl.textContent = status.connected
        ? `ACTIVE USB CONTROLLER: ${status.name} (Connected)`
        : 'NO USB RC TRANSMITTER DETECTED — Plug in RadioMaster TX12 / USB Joystick & move sticks';
      statusEl.style.color = status.connected ? '#4aff91' : '#ffaa11';
    }

    const rawAxes = this.inputManager.rawAxes;
    for (let i = 0; i < 8; i++) {
      const val = rawAxes[i] || 0.0;
      const pct = ((val + 1.0) * 0.5) * 100.0;
      const bar = this._axisBarEls[i];
      const num = this._axisValEls[i];
      if (bar) {
        bar.style.width = `${Math.max(2, Math.min(100, pct))}%`;
      }
      if (num) {
        num.textContent = (val >= 0 ? '+' : '') + val.toFixed(2);
      }
    }

    const rawButtons = this.inputManager.rawButtons;
    for (let b = 0; b < 16; b++) {
      const active = Boolean(rawButtons[b]);
      this._buttonEls[b].classList.toggle('active', active);
    }
  }
}
