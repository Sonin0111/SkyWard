import { clamp } from '../utils/math.js';

/**
 * Mobile & Touchscreen Virtual RC Transmitter Controls (Mode 2 AETR Gimbal Layout).
 *
 * - Left Virtual Gimbal:
 *   - Vertical (Y): Non-centering Throttle stick ([0%, 100%], retains position on release)
 *   - Horizontal (X): Spring-centering Yaw / Rudder stick ([-1, +1], returns to 0 on release)
 * - Right Virtual Gimbal:
 *   - Horizontal (X): Spring-centering Roll / Aileron stick ([-1, +1], returns to 0 on release)
 *   - Vertical (Y): Spring-centering Pitch / Elevator stick ([-1, +1], returns to 0 on release)
 * - Multi-touch independent pointer tracking via Pointer Events & Touch Events
 * - Ergonomic thumb buttons for Warhead Detonation, FPV/Chase Camera, and Thermal FLIR toggle
 * - Landscape orientation prompt for narrow portrait mobile screens
 */
export class TouchControlsUI {
  constructor(containerEl, inputManager, callbacks = {}) {
    this.container = containerEl;
    this.inputManager = inputManager;
    this.callbacks = {
      onDetonate: callbacks.onDetonate || (() => {}),
      onToggleCamera: callbacks.onToggleCamera || (() => {}),
      onToggleThermal: callbacks.onToggleThermal || (() => {}),
      onRestart: callbacks.onRestart || (() => {})
    };

    // Detect mobile / touchscreen capability
    this.isTouchDevice =
      typeof window !== 'undefined' &&
      ('ontouchstart' in window ||
        (navigator && navigator.maxTouchPoints > 0) ||
        (window.matchMedia && window.matchMedia('(pointer: coarse)').matches) ||
        window.innerWidth <= 960);

    this.enabled = this.isTouchDevice;
    this.hiddenForDetonation = false;
    this.orientationDismissed = false;

    // Gimbal state
    this.leftPointerId = null;
    this.rightPointerId = null;

    this.leftYaw = 0.0;       // [-1, +1]
    this.leftThrottle = 0.58; // [0, 1] (non-centering Mode 2 throttle)
    this.rightRoll = 0.0;     // [-1, +1]
    this.rightPitch = 0.0;    // [-1, +1]

    this._buildDOM();
    this._bindEvents();
    this.updateVisibility();
    this._updateKnobVisuals();
  }

  _buildDOM() {
    this.container.innerHTML = `
      <!-- Left Mode 2 Gimbal: Throttle (Non-Centering Y) & Yaw (Spring-Centering X) -->
      <div class="touch-cluster touch-cluster-left">
        <div class="touch-quick-btns">
          <button id="touch-btn-view" class="touch-action-btn" type="button">CAM [V]</button>
          <button id="touch-btn-optic" class="touch-action-btn" type="button">FLIR [T]</button>
        </div>
        <div id="touch-gimbal-left" class="touch-gimbal" data-side="left">
          <div class="gimbal-grid-h"></div>
          <div class="gimbal-grid-v"></div>
          <div class="gimbal-throttle-ticks"></div>
          <div id="touch-knob-left" class="touch-knob"></div>
          <span class="gimbal-caption">THR / YAW</span>
        </div>
      </div>

      <!-- Right Mode 2 Gimbal: Pitch (Spring-Centering Y) & Roll (Spring-Centering X) -->
      <div class="touch-cluster touch-cluster-right">
        <div class="touch-quick-btns">
          <button id="touch-btn-detonate" class="touch-action-btn touch-btn-detonate" type="button">DETONATE</button>
          <button id="touch-btn-restart" class="touch-action-btn" type="button">RESET</button>
        </div>
        <div id="touch-gimbal-right" class="touch-gimbal" data-side="right">
          <div class="gimbal-grid-h"></div>
          <div class="gimbal-grid-v"></div>
          <div id="touch-knob-right" class="touch-knob"></div>
          <span class="gimbal-caption">PITCH / ROLL</span>
        </div>
      </div>

      <!-- Portrait Orientation Notice for Mobile Phones -->
      <div id="orientation-prompt" class="orientation-prompt hidden">
        <div class="orientation-card">
          <div class="orientation-icon">⟳</div>
          <h3>ROTATE DEVICE TO LANDSCAPE</h3>
          <p>SkyWard's FPV OSD and Dual Mode-2 Virtual RC Gimbals are designed for horizontal landscape flight.</p>
          <button id="orientation-dismiss-btn" class="hud-btn hud-btn-primary" type="button">Continue in Current View</button>
        </div>
      </div>
    `;

    this.leftGimbalEl = this.container.querySelector('#touch-gimbal-left');
    this.rightGimbalEl = this.container.querySelector('#touch-gimbal-right');
    this.leftKnobEl = this.container.querySelector('#touch-knob-left');
    this.rightKnobEl = this.container.querySelector('#touch-knob-right');
    this.orientationPromptEl = this.container.querySelector('#orientation-prompt');
  }

  _bindEvents() {
    // Auto-enable virtual sticks if user touches the screen on a hybrid device
    window.addEventListener(
      'touchstart',
      () => {
        if (!this.enabled) {
          this.enabled = true;
          this.updateVisibility();
        }
      },
      { passive: true, once: true }
    );

    // Bind Left Gimbal (Throttle Y + Yaw X)
    this._bindGimbalPointer(this.leftGimbalEl, 'left');

    // Bind Right Gimbal (Pitch Y + Roll X)
    this._bindGimbalPointer(this.rightGimbalEl, 'right');

    // Bind Mobile Tactical Action Buttons
    const bindTouchBtn = (selector, handler) => {
      const btn = this.container.querySelector(selector);
      if (!btn) return;
      btn.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this._tryLockLandscape();
        handler();
      });
    };

    bindTouchBtn('#touch-btn-detonate', () => this.callbacks.onDetonate());
    bindTouchBtn('#touch-btn-view', () => this.callbacks.onToggleCamera());
    bindTouchBtn('#touch-btn-optic', () => this.callbacks.onToggleThermal());
    bindTouchBtn('#touch-btn-restart', () => this.callbacks.onRestart());

    const dismissBtn = this.container.querySelector('#orientation-dismiss-btn');
    if (dismissBtn) {
      dismissBtn.addEventListener('click', () => {
        this.orientationDismissed = true;
        this._checkOrientation();
      });
    }

    window.addEventListener('resize', () => this._checkOrientation());
    window.addEventListener('orientationchange', () => this._checkOrientation());
    this._checkOrientation();
  }

  _bindGimbalPointer(gimbalEl, side) {
    if (!gimbalEl) return;

    const updateFromEvent = (clientX, clientY) => {
      const rect = gimbalEl.getBoundingClientRect();
      const halfW = Math.max(20, rect.width * 0.5);
      const halfH = Math.max(20, rect.height * 0.5);
      const centerX = rect.left + halfW;
      const centerY = rect.top + halfH;

      // Normalized [-1, +1] within gimbal pad radius (with 82% active travel radius)
      const maxTravelX = halfW * 0.78;
      const maxTravelY = halfH * 0.78;

      const normX = clamp((clientX - centerX) / maxTravelX, -1.0, 1.0);
      const normY = clamp((clientY - centerY) / maxTravelY, -1.0, 1.0);

      if (side === 'left') {
        this.leftYaw = normX;
        // Top of gimbal (normY = -1) is 100% throttle (1.0); Bottom (normY = +1) is 0% throttle (0.0)
        this.leftThrottle = clamp((1.0 - normY) * 0.5, 0.0, 1.0);
      } else {
        this.rightRoll = normX;
        // Pushing stick up (normY < 0) = Nose Down (pitch < 0); Pulling stick down (normY > 0) = Nose Up (pitch > 0)
        this.rightPitch = normY;
      }

      this._syncToInputManager();
      this._updateKnobVisuals();
    };

    gimbalEl.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this._tryLockLandscape();

      try {
        gimbalEl.setPointerCapture(e.pointerId);
      } catch (_) {}

      if (side === 'left') {
        this.leftPointerId = e.pointerId;
        gimbalEl.classList.add('gimbal-active');
      } else {
        this.rightPointerId = e.pointerId;
        gimbalEl.classList.add('gimbal-active');
      }

      updateFromEvent(e.clientX, e.clientY);
    });

    gimbalEl.addEventListener('pointermove', (e) => {
      if (side === 'left' && e.pointerId === this.leftPointerId) {
        e.preventDefault();
        updateFromEvent(e.clientX, e.clientY);
      } else if (side === 'right' && e.pointerId === this.rightPointerId) {
        e.preventDefault();
        updateFromEvent(e.clientX, e.clientY);
      }
    });

    const onRelease = (e) => {
      if (side === 'left' && e.pointerId === this.leftPointerId) {
        this.leftPointerId = null;
        gimbalEl.classList.remove('gimbal-active');
        // Mode 2 Left Stick: Yaw springs to 0, Throttle STAYS at set position!
        this.leftYaw = 0.0;
        this._syncToInputManager();
        this._updateKnobVisuals();
      } else if (side === 'right' && e.pointerId === this.rightPointerId) {
        this.rightPointerId = null;
        gimbalEl.classList.remove('gimbal-active');
        // Mode 2 Right Stick: Both Roll and Pitch spring back to center (0, 0)
        this.rightRoll = 0.0;
        this.rightPitch = 0.0;
        this._syncToInputManager();
        this._updateKnobVisuals();
      }
    };

    gimbalEl.addEventListener('pointerup', onRelease);
    gimbalEl.addEventListener('pointercancel', onRelease);
  }

  _syncToInputManager() {
    this.inputManager.setTouchControls({
      leftActive: this.leftPointerId !== null,
      rightActive: this.rightPointerId !== null,
      yaw: this.leftYaw,
      throttle: this.leftThrottle,
      roll: this.rightRoll,
      pitch: this.rightPitch
    });
  }

  _updateKnobVisuals() {
    if (this.leftKnobEl) {
      // Left knob X: leftYaw [-1, 1] -> [-38%, +38%]
      // Left knob Y: leftThrottle [0, 1] -> [+38% (bottom), -38% (top)]
      const lxPct = this.leftYaw * 38.0;
      const lyPct = (1.0 - this.leftThrottle * 2.0) * 38.0;
      this.leftKnobEl.style.transform = `translate(calc(-50% + ${lxPct}px), calc(-50% + ${lyPct}px))`;
    }

    if (this.rightKnobEl) {
      const rxPct = this.rightRoll * 38.0;
      const ryPct = this.rightPitch * 38.0;
      this.rightKnobEl.style.transform = `translate(calc(-50% + ${rxPct}px), calc(-50% + ${ryPct}px))`;
    }
  }

  /**
   * Keeps the left virtual throttle knob synced if throttle is changed via keyboard/RC.
   */
  syncThrottleFromPhysics(throttleVal) {
    if (this.leftPointerId === null) {
      this.leftThrottle = clamp(throttleVal, 0.0, 1.0);
      this._updateKnobVisuals();
    }
  }

  reset(initialThrottle = 0.58) {
    this.leftPointerId = null;
    this.rightPointerId = null;
    this.leftYaw = 0.0;
    this.leftThrottle = initialThrottle;
    this.rightRoll = 0.0;
    this.rightPitch = 0.0;
    this.hiddenForDetonation = false;
    this._syncToInputManager();
    this._updateKnobVisuals();
    this.updateVisibility();
  }

  toggle(forceState) {
    this.enabled = typeof forceState === 'boolean' ? forceState : !this.enabled;
    this.updateVisibility();
    return this.enabled;
  }

  setDetonationHidden(hidden) {
    this.hiddenForDetonation = Boolean(hidden);
    this.updateVisibility();
  }

  updateVisibility() {
    const show = this.enabled && !this.hiddenForDetonation;
    this.container.classList.toggle('hidden', !show);
    const btn = document.getElementById('btn-touch-rc');
    if (btn) {
      btn.classList.toggle('hud-btn-primary', this.enabled);
    }
  }

  _checkOrientation() {
    if (!this.orientationPromptEl) return;
    const isPortraitMobile =
      window.innerHeight > window.innerWidth &&
      window.innerWidth < 768 &&
      (this.isTouchDevice || this.enabled) &&
      !this.orientationDismissed;

    this.orientationPromptEl.classList.toggle('hidden', !isPortraitMobile);
  }

  _tryLockLandscape() {
    if (
      typeof screen !== 'undefined' &&
      screen.orientation &&
      typeof screen.orientation.lock === 'function'
    ) {
      screen.orientation.lock('landscape').catch(() => {});
    }
  }
}
