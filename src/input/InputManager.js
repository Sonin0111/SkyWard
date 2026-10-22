import { clamp, damp, applyDeadzoneAndExpo, normalizeRCThrottle } from '../utils/math.js';

const STORAGE_KEY = 'skyward_controller_profile_v1';

/**
 * Default AETR (Mode 2) profile for EdgeTX / OpenTX USB HID Transmitters
 * (RadioMaster TX12, Boxer, Pocket, TX16S, Zorro).
 * Channel 1 (Axis 0): Aileron (Roll)
 * Channel 2 (Axis 1): Elevator (Pitch)
 * Channel 3 (Axis 2): Throttle ([-1, +1] -> [0%, 100%])
 * Channel 4 (Axis 3): Rudder (Yaw)
 * Auxiliary Channels 5, 6, 7: Mapped to Gamepad Buttons 0, 1, 2 (and Axis 4, 5, 6 fallback)
 */
export const DEFAULT_RC_PROFILE = {
  axes: {
    roll: 0,      // Ch1: Aileron
    pitch: 1,     // Ch2: Elevator
    throttle: 2,  // Ch3: Throttle
    yaw: 3        // Ch4: Rudder
  },
  invert: {
    roll: false,
    pitch: false,
    throttle: false,
    yaw: false
  },
  expo: 0.30,
  deadzone: 0.02,
  // Switch bindings support both button index (0..15) and auxiliary axis (4..7)
  switches: {
    cameraView: { type: 'button', index: 0, auxAxis: 4 },   // Ch5 / Button 0
    thermalMode: { type: 'button', index: 1, auxAxis: 5 },  // Ch6 / Button 1
    detonate: { type: 'button', index: 2, auxAxis: 6 }      // Ch7 / Button 2
  }
};

export class InputManager {
  constructor(callbacks = {}) {
    this.callbacks = {
      onToggleCamera: callbacks.onToggleCamera || (() => {}),
      onToggleThermal: callbacks.onToggleThermal || (() => {}),
      onDetonate: callbacks.onDetonate || (() => {}),
      onToggleControllerUI: callbacks.onToggleControllerUI || (() => {}),
      onRestart: callbacks.onRestart || (() => {}),
      onToggleArm: callbacks.onToggleArm || (() => {}),
      onGamepadStatusChange: callbacks.onGamepadStatusChange || (() => {})
    };

    this.profile = this._loadProfile();

    // Active keyboard state
    this.keys = new Set();

    // Smoothed keyboard virtual axes
    this.kbState = {
      pitch: 0.0,
      roll: 0.0,
      yaw: 0.0,
      throttle: 0.58
    };

    // Mobile / Touchscreen Virtual RC Gimbal state (Mode 2 layout)
    this.touchState = {
      leftActive: false,
      rightActive: false,
      yaw: 0.0,
      throttle: 0.58,
      roll: 0.0,
      pitch: 0.0
    };

    // Final merged flight control output
    this.controls = {
      pitch: 0.0,     // -1 (nose down) to +1 (nose up)
      roll: 0.0,      // -1 (bank left) to +1 (bank right)
      yaw: 0.0,       // -1 (yaw left) to +1 (yaw right)
      throttle: 0.58  // 0.0 (0%) to 1.0 (100%)
    };

    // Normalized stick monitor coordinates for HUD crosshair widgets (Mode 2 layout)
    // Left stick: X = Yaw [-1, 1], Y = Throttle [-1, 1]
    // Right stick: X = Roll [-1, 1], Y = Pitch [-1, 1]
    this.stickMonitor = {
      leftX: 0.0,
      leftY: 0.16,
      rightX: 0.0,
      rightY: 0.0
    };

    // Connected Gamepad / RC Transmitter state
    this.gamepadConnected = false;
    this.gamepadIndex = null;
    this.gamepadName = 'No RC Transmitter (Keyboard Mode)';
    this.isEdgeTX = false;
    this.rawAxes = new Float32Array(8);
    this.rawButtons = new Array(16).fill(false);

    // Edge-detection states for physical RC switches
    this._prevSwitchState = {
      cameraView: false,
      thermalMode: false,
      detonate: false
    };
    this._lastThrottleAxisVal = null;
    this._rcThrottleActive = false;

    // Bind interactive listen mode for UI switch/axis assignment
    this.listeningTarget = null; // e.g., { kind: 'axis'|'switch', action: 'pitch'|'detonate', callback }
    this._listenBaselineAxes = null;

    this._bindEvents();
    this._scanInitialGamepads();
  }

  _loadProfile() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        return {
          axes: { ...DEFAULT_RC_PROFILE.axes, ...(parsed.axes || {}) },
          invert: { ...DEFAULT_RC_PROFILE.invert, ...(parsed.invert || {}) },
          expo: clamp(Number(parsed.expo ?? DEFAULT_RC_PROFILE.expo), 0.0, 0.85),
          deadzone: clamp(Number(parsed.deadzone ?? DEFAULT_RC_PROFILE.deadzone), 0.0, 0.25),
          switches: {
            cameraView: { ...DEFAULT_RC_PROFILE.switches.cameraView, ...(parsed.switches?.cameraView || {}) },
            thermalMode: { ...DEFAULT_RC_PROFILE.switches.thermalMode, ...(parsed.switches?.thermalMode || {}) },
            detonate: { ...DEFAULT_RC_PROFILE.switches.detonate, ...(parsed.switches?.detonate || {}) }
          }
        };
      }
    } catch (_) {
      // Ignore storage errors in restricted contexts
    }
    return JSON.parse(JSON.stringify(DEFAULT_RC_PROFILE));
  }

  saveProfile() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.profile));
    } catch (_) {
      // Ignore storage errors
    }
  }

  resetProfileToDefault() {
    this.profile = JSON.parse(JSON.stringify(DEFAULT_RC_PROFILE));
    this.saveProfile();
  }

  _bindEvents() {
    this._onKeyDown = (e) => {
      // Ignore shortcuts if typing in an input box (e.g. seed input)
      if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT')) {
        return;
      }

      const code = e.code;
      if (
        code === 'Space' ||
        code === 'ArrowUp' ||
        code === 'ArrowDown' ||
        code === 'ArrowLeft' ||
        code === 'ArrowRight'
      ) {
        e.preventDefault();
      }

      if (!e.repeat) {
        if (code === 'KeyV') this.callbacks.onToggleCamera();
        else if (code === 'KeyT') this.callbacks.onToggleThermal(e.shiftKey);
        else if (code === 'Space') this.callbacks.onDetonate();
        else if (code === 'KeyC') this.callbacks.onToggleControllerUI();
        else if (code === 'KeyR') this.callbacks.onRestart();
        else if (code === 'KeyM') this.callbacks.onToggleArm();
      }

      this.keys.add(code);
    };

    this._onKeyUp = (e) => {
      this.keys.delete(e.code);
    };

    this._onBlur = () => {
      this.keys.clear();
    };

    this._onGamepadConnected = (e) => {
      const gp = e.gamepad;
      if (!gp) return;
      this._selectGamepad(gp);
    };

    this._onGamepadDisconnected = (e) => {
      if (this.gamepadIndex === e.gamepad.index) {
        this.gamepadConnected = false;
        this.gamepadIndex = null;
        this.gamepadName = 'No RC Transmitter (Keyboard Mode)';
        this.isEdgeTX = false;
        this._rcThrottleActive = false;
        this._lastThrottleAxisVal = null;
        this.rawAxes.fill(0);
        this.rawButtons.fill(false);
        this._scanInitialGamepads();
        this.callbacks.onGamepadStatusChange(this.getStatusSummary());
      }
    };

    window.addEventListener('keydown', this._onKeyDown);
    window.addEventListener('keyup', this._onKeyUp);
    window.addEventListener('blur', this._onBlur);
    window.addEventListener('gamepadconnected', this._onGamepadConnected);
    window.addEventListener('gamepaddisconnected', this._onGamepadDisconnected);
  }

  _scanInitialGamepads() {
    if (typeof navigator === 'undefined' || typeof navigator.getGamepads !== 'function') return;
    const pads = navigator.getGamepads();
    if (!pads) return;

    // Prefer EdgeTX / OpenTX / RadioMaster controllers if multiple gamepads exist
    let bestPad = null;
    for (let i = 0; i < pads.length; i++) {
      const p = pads[i];
      if (!p || !p.connected) continue;
      if (!bestPad) bestPad = p;
      const idLower = (p.id || '').toLowerCase();
      if (
        idLower.includes('radiomaster') ||
        idLower.includes('tx12') ||
        idLower.includes('edgetx') ||
        idLower.includes('opentx') ||
        idLower.includes('boxer') ||
        idLower.includes('pocket') ||
        idLower.includes('frsky')
      ) {
        bestPad = p;
        break;
      }
    }

    if (bestPad) {
      this._selectGamepad(bestPad);
    }
  }

  _selectGamepad(gp) {
    this.gamepadConnected = true;
    this.gamepadIndex = gp.index;
    this.gamepadName = this._formatControllerName(gp.id);
    const idLower = (gp.id || '').toLowerCase();
    this.isEdgeTX =
      idLower.includes('radiomaster') ||
      idLower.includes('tx12') ||
      idLower.includes('edgetx') ||
      idLower.includes('opentx') ||
      idLower.includes('boxer') ||
      idLower.includes('pocket');

    this._lastThrottleAxisVal = null;
    this._rcThrottleActive = false;
    this.callbacks.onGamepadStatusChange(this.getStatusSummary());
  }

  _formatControllerName(rawId) {
    if (!rawId) return 'USB HID Flight Controller';
    const clean = rawId.replace(/\s*\([0-9a-fA-F:\-\s]+\)\s*/g, ' ').trim();
    return clean || rawId;
  }

  getStatusSummary() {
    return {
      connected: this.gamepadConnected,
      name: this.gamepadName,
      isEdgeTX: this.isEdgeTX,
      index: this.gamepadIndex
    };
  }

  /**
   * Starts interactive listening for a physical axis move or button/switch flip
   * so the user can bind controls directly in the Controller Configuration Panel.
   */
  startListening(kind, action, callback) {
    this._listenBaselineAxes = Float32Array.from(this.rawAxes);
    this.listeningTarget = { kind, action, callback };
  }

  cancelListening() {
    this.listeningTarget = null;
    this._listenBaselineAxes = null;
  }

  /**
   * Resets throttle to cruise setting on mission restart.
   */
  resetThrottle(initialThrottle = 0.58) {
    this.kbState.throttle = initialThrottle;
    this.touchState.throttle = initialThrottle;
    this.controls.throttle = initialThrottle;
    this.kbState.pitch = 0.0;
    this.kbState.roll = 0.0;
    this.kbState.yaw = 0.0;
    this.touchState.pitch = 0.0;
    this.touchState.roll = 0.0;
    this.touchState.yaw = 0.0;
  }

  /**
   * Updates virtual RC stick values from the mobile/touchscreen Mode 2 gimbal UI.
   */
  setTouchControls({ leftActive, rightActive, yaw, throttle, roll, pitch }) {
    if (typeof leftActive === 'boolean') this.touchState.leftActive = leftActive;
    if (typeof rightActive === 'boolean') this.touchState.rightActive = rightActive;
    if (typeof yaw === 'number') this.touchState.yaw = clamp(yaw, -1.0, 1.0);
    if (typeof throttle === 'number') {
      this.touchState.throttle = clamp(throttle, 0.0, 1.0);
      if (this.touchState.leftActive) {
        this._rcThrottleActive = false;
        this.kbState.throttle = this.touchState.throttle;
      }
    }
    if (typeof roll === 'number') this.touchState.roll = clamp(roll, -1.0, 1.0);
    if (typeof pitch === 'number') this.touchState.pitch = clamp(pitch, -1.0, 1.0);
  }

  /**
   * Polls keyboard & HTML5 Gamepad API every frame and updates normalized flight controls.
   * @param {number} dt - Frame delta time in seconds
   */
  update(dt) {
    // 1. Update keyboard virtual inputs
    // W / ArrowUp: Nose Down (negative pitch); S / ArrowDown: Nose Up (positive pitch)
    let kbPitchTarget = 0.0;
    if (this.keys.has('KeyS') || this.keys.has('ArrowDown')) kbPitchTarget += 1.0;
    if (this.keys.has('KeyW') || this.keys.has('ArrowUp')) kbPitchTarget -= 1.0;

    // A / ArrowLeft: Bank Left (-1); D / ArrowRight: Bank Right (+1)
    let kbRollTarget = 0.0;
    if (this.keys.has('KeyD') || this.keys.has('ArrowRight')) kbRollTarget += 1.0;
    if (this.keys.has('KeyA') || this.keys.has('ArrowLeft')) kbRollTarget -= 1.0;

    // Q: Yaw Left (-1); E: Yaw Right (+1)
    let kbYawTarget = 0.0;
    if (this.keys.has('KeyE')) kbYawTarget += 1.0;
    if (this.keys.has('KeyQ')) kbYawTarget -= 1.0;

    // Shift / Ctrl: Throttle Up / Down
    let kbThrottleDelta = 0.0;
    if (this.keys.has('ShiftLeft') || this.keys.has('ShiftRight')) kbThrottleDelta += 0.48;
    if (this.keys.has('ControlLeft') || this.keys.has('ControlRight')) kbThrottleDelta -= 0.48;

    if (kbThrottleDelta !== 0.0) {
      this._rcThrottleActive = false; // Allow keyboard override if user presses Shift/Ctrl
      this.kbState.throttle = clamp(this.kbState.throttle + kbThrottleDelta * dt, 0.0, 1.0);
    }

    const kbResponseRate = 10.5;
    this.kbState.pitch = damp(this.kbState.pitch, kbPitchTarget, kbResponseRate, dt);
    this.kbState.roll = damp(this.kbState.roll, kbRollTarget, kbResponseRate, dt);
    this.kbState.yaw = damp(this.kbState.yaw, kbYawTarget, kbResponseRate, dt);

    // 2. Poll HTML5 Gamepad API (navigator.getGamepads())
    let rcPitch = 0.0;
    let rcRoll = 0.0;
    let rcYaw = 0.0;
    let hasActiveGamepad = false;

    if (typeof navigator !== 'undefined' && typeof navigator.getGamepads === 'function') {
      const pads = navigator.getGamepads();
      let gp = this.gamepadIndex !== null && pads ? pads[this.gamepadIndex] : null;

      // Auto-discover if a gamepad woke up without firing event first
      if (!gp && pads) {
        for (let i = 0; i < pads.length; i++) {
          if (pads[i] && pads[i].connected) {
            this._selectGamepad(pads[i]);
            gp = pads[i];
            break;
          }
        }
      }

      if (gp && gp.connected) {
        hasActiveGamepad = true;
        for (let i = 0; i < 8; i++) {
          this.rawAxes[i] = i < gp.axes.length ? gp.axes[i] : 0.0;
        }
        for (let i = 0; i < 16; i++) {
          this.rawButtons[i] = i < gp.buttons.length ? Boolean(gp.buttons[i].pressed || gp.buttons[i].value > 0.5) : false;
        }

        // Check if interactive binding listener is waiting for an axis or switch
        if (this.listeningTarget) {
          this._checkInteractiveBind();
        }

        const p = this.profile;
        const rawRollAxis = this.rawAxes[p.axes.roll] ?? 0.0;
        const rawPitchAxis = this.rawAxes[p.axes.pitch] ?? 0.0;
        const rawThrottleAxis = this.rawAxes[p.axes.throttle] ?? -1.0;
        const rawYawAxis = this.rawAxes[p.axes.yaw] ?? 0.0;

        rcRoll = applyDeadzoneAndExpo(rawRollAxis, p.deadzone, p.expo, p.invert.roll);
        rcPitch = applyDeadzoneAndExpo(rawPitchAxis, p.deadzone, p.expo, p.invert.pitch);
        rcYaw = applyDeadzoneAndExpo(rawYawAxis, p.deadzone, p.expo, p.invert.yaw);

        // Activate RC throttle once the physical throttle axis moves or is non-zero
        if (this._lastThrottleAxisVal === null) {
          this._lastThrottleAxisVal = rawThrottleAxis;
          if (Math.abs(rawThrottleAxis) > 0.05) {
            this._rcThrottleActive = true;
          }
        } else if (Math.abs(rawThrottleAxis - this._lastThrottleAxisVal) > 0.015) {
          this._rcThrottleActive = true;
          this._lastThrottleAxisVal = rawThrottleAxis;
        }

        if (this._rcThrottleActive) {
          const normThrottle = normalizeRCThrottle(rawThrottleAxis, p.invert.throttle);
          this.kbState.throttle = normThrottle;
        }

        // Evaluate auxiliary switches (Channels 5, 6, 7 via Buttons or Upper Axes 4, 5, 6)
        this._evaluateSwitch('cameraView', () => this.callbacks.onToggleCamera());
        this._evaluateSwitch('thermalMode', () => this.callbacks.onToggleThermal(false));
        this._evaluateSwitch('detonate', () => this.callbacks.onDetonate());
      }
    }

    // 3. Process Mobile / Touchscreen Virtual RC Joysticks (with Deadzone & Expo)
    const p = this.profile;
    const touchRoll = applyDeadzoneAndExpo(this.touchState.roll, p.deadzone, p.expo, p.invert.roll);
    const touchPitch = applyDeadzoneAndExpo(this.touchState.pitch, p.deadzone, p.expo, p.invert.pitch);
    const touchYaw = applyDeadzoneAndExpo(this.touchState.yaw, p.deadzone, p.expo, p.invert.yaw);

    // 4. Combine RC Transmitter, Virtual Touch RC Joysticks, and Keyboard controls seamlessly
    this.controls.pitch = clamp(rcPitch + touchPitch + this.kbState.pitch, -1.0, 1.0);
    this.controls.roll = clamp(rcRoll + touchRoll + this.kbState.roll, -1.0, 1.0);
    this.controls.yaw = clamp(rcYaw + touchYaw + this.kbState.yaw, -1.0, 1.0);
    this.controls.throttle = clamp(this.kbState.throttle, 0.0, 1.0);

    // 4. Update real-time Mode 2 stick monitor coordinates for HUD OSD
    this.stickMonitor.leftX = this.controls.yaw;
    this.stickMonitor.leftY = this.controls.throttle * 2.0 - 1.0;
    this.stickMonitor.rightX = this.controls.roll;
    this.stickMonitor.rightY = this.controls.pitch;

    return this.controls;
  }

  _evaluateSwitch(switchKey, onTrigger) {
    const binding = this.profile.switches[switchKey];
    if (!binding) return;

    let isActive = false;
    if (binding.type === 'button') {
      isActive = Boolean(this.rawButtons[binding.index]);
      // Also support EdgeTX Aux Axis (Ch5=Axis4, Ch6=Axis5, Ch7=Axis6) if button isn't pressed
      if (!isActive && typeof binding.auxAxis === 'number' && binding.auxAxis < this.rawAxes.length) {
        isActive = this.rawAxes[binding.auxAxis] > 0.45;
      }
    } else if (binding.type === 'axis') {
      isActive = (this.rawAxes[binding.index] || 0.0) > 0.45;
    }

    if (isActive && !this._prevSwitchState[switchKey]) {
      onTrigger();
    }
    this._prevSwitchState[switchKey] = isActive;
  }

  _checkInteractiveBind() {
    const target = this.listeningTarget;
    if (!target) return;

    if (target.kind === 'axis' && this._listenBaselineAxes) {
      for (let i = 0; i < 8; i++) {
        if (Math.abs(this.rawAxes[i] - this._listenBaselineAxes[i]) > 0.35) {
          this.profile.axes[target.action] = i;
          this.saveProfile();
          const cb = target.callback;
          this.cancelListening();
          if (cb) cb(i);
          return;
        }
      }
    } else if (target.kind === 'switch') {
      // Check buttons 0..15 first
      for (let b = 0; b < 16; b++) {
        if (this.rawButtons[b]) {
          this.profile.switches[target.action] = { type: 'button', index: b, auxAxis: -1 };
          this.saveProfile();
          const cb = target.callback;
          this.cancelListening();
          if (cb) cb({ type: 'button', index: b });
          return;
        }
      }
      // Also check axes 4..7 for EdgeTX aux channel switches
      if (this._listenBaselineAxes) {
        for (let a = 4; a < 8; a++) {
          if (Math.abs(this.rawAxes[a] - this._listenBaselineAxes[a]) > 0.45) {
            this.profile.switches[target.action] = { type: 'axis', index: a };
            this.saveProfile();
            const cb = target.callback;
            this.cancelListening();
            if (cb) cb({ type: 'axis', index: a });
            return;
          }
        }
      }
    }
  }

  dispose() {
    window.removeEventListener('keydown', this._onKeyDown);
    window.removeEventListener('keyup', this._onKeyUp);
    window.removeEventListener('blur', this._onBlur);
    window.removeEventListener('gamepadconnected', this._onGamepadConnected);
    window.removeEventListener('gamepaddisconnected', this._onGamepadDisconnected);
  }
}
