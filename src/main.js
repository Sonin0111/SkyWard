import * as THREE from '../vendor/three.module.js';
import { FLIGHT_CONFIG } from './config/flightConfig.js';
import { FlightPhysics } from './physics/FlightPhysics.js';
import { InputManager } from './input/InputManager.js';
import { InterceptorModel } from './models/InterceptorModel.js';
import { ReconUAVModel } from './models/ReconUAVModel.js';
import { EnemyReconAI } from './ai/EnemyReconAI.js';
import { WorldManager } from './world/WorldManager.js';
import { CameraSystem } from './camera/CameraSystem.js';
import { EffectsManager } from './effects/EffectsManager.js';
import { TacticalOSD } from './ui/TacticalOSD.js';
import { ControllerUI } from './ui/ControllerUI.js';
import { TouchControlsUI } from './ui/TouchControlsUI.js';
import { runVerificationSuite } from './tests/verificationSuite.js';

/**
 * SkyWard — Main 3D Fixed-Wing UAV Interceptor Simulation Engine.
 * Decouples fixed-timestep 120Hz aerodynamic physics from 60+ FPS WebGL rendering.
 */
class SkyWardSimulator {
  constructor() {
    this.config = FLIGHT_CONFIG;
    this.currentSeed = this.config.world.defaultSeed;

    this.viewportCanvas = document.getElementById('viewport-canvas');
    this.osdCanvas = document.getElementById('osd-canvas');

    this._initRendererAndScene();

    // Modular subsystems
    this.world = new WorldManager(this.scene, this.config);
    this.physics = new FlightPhysics(this.config);
    this.enemyAI = new EnemyReconAI(this.config);

    // 3D Procedural Aircraft Models
    this.interceptorModel = new InterceptorModel();
    this.scene.add(this.interceptorModel.root);

    this.reconModel = new ReconUAVModel();
    this.scene.add(this.reconModel.root);

    // Camera, Visual Effects, OSD & Input
    this.cameraSystem = new CameraSystem(this.renderer, this.scene);
    this.effects = new EffectsManager(this.scene);
    this.osd = new TacticalOSD(this.osdCanvas, this.config);

    this.inputManager = new InputManager({
      onToggleCamera: () => this.toggleCameraView(),
      onToggleThermal: () => this.toggleOpticalMode(),
      onDetonate: () => this.triggerWarheadDetonation(),
      onToggleControllerUI: () => this.controllerUI.toggle(),
      onRestart: () => this.restartWithNewSeed(),
      onToggleArm: () => this.toggleManualArm(),
      onToggleFullscreen: () => this.toggleFullscreen(),
      onGamepadStatusChange: (status) => this._updateTopBarControllerBadge(status)
    });

    this.controllerUI = new ControllerUI(
      document.getElementById('controller-modal'),
      this.inputManager
    );

    this.touchUI = new TouchControlsUI(
      document.getElementById('touch-controls-layer'),
      this.inputManager,
      {
        onDetonate: () => this.triggerWarheadDetonation(),
        onToggleCamera: () => this.toggleCameraView(),
        onToggleThermal: () => this.toggleOpticalMode(),
        onRestart: () => this.restartWithNewSeed(),
        onToggleFullscreen: () => this.toggleFullscreen(),
        onEnterFullscreenLandscape: () => this.enterFullscreen(true),
        onGimbalTouch: () => this.setMobileTopBarOpen(false)
      }
    );

    // Interception Gameplay State
    this.interceptionState = {
      warheadArmed: false,
      manualArmOverride: false,
      statusLabel: 'SEARCHING / TRACKING',
      missionEnded: false,
      missionSuccess: false,
      outcomeTitle: '',
      outcomeSubtitle: '',
      detonationDistanceM: null,
      resultsShown: false,
      resultsTimerSec: 0.0
    };

    // Fixed-timestep loop state
    this.fixedDt = this.config.environment.fixedTimeStep; // 1/120 s
    this.accumulator = 0.0;
    this.lastFrameTimeMs = performance.now();
    this.isPaused = false;
    this.fpsCounter = 60;
    this._fpsFrames = 0;
    this._fpsTimer = 0.0;

    this._bindUIControls();
    this._bindWindowLifecycle();

    // If detected as a mobile / touchscreen device, immediately open in Fullscreen + Landscape mode
    if (this.touchUI.isMobile || this.touchUI.isTouchDevice) {
      this._initMobileFullscreenAndLandscape();
    }

    // Start initial scenario
    this.startScenario(this.currentSeed);
    this._animate = this._animate.bind(this);
    requestAnimationFrame(this._animate);
  }

  _initRendererAndScene() {
    try {
      this.renderer = new THREE.WebGLRenderer({
        canvas: this.viewportCanvas,
        antialias: true,
        powerPreference: 'high-performance',
        logarithmicDepthBuffer: true
      });
    } catch (err) {
      this._showFatalError(`WebGL initialization failed: ${err.message}`);
      throw err;
    }

    const preset = this.config.world.qualityPresets.Medium;
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.setPixelRatio(preset.pixelRatio);
    this.renderer.shadowMap.enabled = preset.shadows;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;

    this.scene = new THREE.Scene();
  }

  /**
   * Initializes or restarts the flight scenario with the specified random seed.
   */
  startScenario(seed) {
    this.currentSeed = Number(seed) || Math.floor(Math.random() * 89999999 + 10000000);
    const seedInput = document.getElementById('seed-input');
    if (seedInput) seedInput.value = String(this.currentSeed);

    // Re-seed world & terrain
    this.world.reseed(this.currentSeed);

    // Reset player interceptor physics & 3D model
    this.physics.reset(this.world.getTerrainHeight);
    this.interceptorModel.resetDamageState();
    this.interceptorModel.root.visible = true;
    this.interceptorModel.setFpvVisibility(this.cameraSystem.viewMode === 'FPV');
    this.inputManager.resetThrottle(this.config.spawn.initialThrottle);

    // Restore OSD & Touch RC visibility
    this.osd.setVisible(true);
    this.touchUI?.reset(this.config.spawn.initialThrottle);

    // Generate new procedural enemy reconnaissance UAV route
    this.enemyAI.initScenario(this.currentSeed, this.world.getTerrainHeight);
    this.reconModel.reset();
    this.world.setThermalMode(this.cameraSystem.opticalMode);
    this.reconModel.setThermalMode(this.cameraSystem.opticalMode);

    // Sync initial mesh transforms & camera
    this.interceptorModel.root.position.copy(this.physics.position);
    this.interceptorModel.root.quaternion.copy(this.physics.quaternion);
    this.reconModel.root.position.copy(this.enemyAI.position);
    this.reconModel.root.quaternion.copy(this.enemyAI.quaternion);

    this.cameraSystem.resetToAircraft(this.physics.position, this.physics.quaternion);
    this.world.update(this.physics.position);
    this.effects.reset();

    const camBtn = document.getElementById('btn-cam-view');
    if (camBtn) camBtn.textContent = this.cameraSystem.viewMode === 'FPV' ? 'View: FPV [V]' : 'View: Chase [V]';

    const optBtn = document.getElementById('btn-optical-mode');
    if (optBtn) {
      const mode = this.cameraSystem.opticalMode;
      optBtn.textContent =
        mode === 'DAY'
          ? 'Optic: Day [T]'
          : mode === 'WHITE_HOT'
          ? 'Optic: FLIR W-Hot [T]'
          : 'Optic: FLIR B-Hot [T]';
    }

    this.touchUI?.updateStatusBadges({
      viewMode: this.cameraSystem.viewMode,
      opticalMode: this.cameraSystem.opticalMode,
      inRange: false
    });

    // Reset gameplay state
    this.interceptionState.warheadArmed = false;
    this.interceptionState.manualArmOverride = false;
    this.interceptionState.statusLabel = 'SEARCHING / TRACKING';
    this.interceptionState.missionEnded = false;
    this.interceptionState.missionSuccess = false;
    this.interceptionState.outcomeTitle = '';
    this.interceptionState.outcomeSubtitle = '';
    this.interceptionState.detonationDistanceM = null;
    this.interceptionState.resultsShown = false;
    this.interceptionState.resultsTimerSec = 0.0;

    this._hideResultsModal();
    this.accumulator = 0.0;
    this.lastFrameTimeMs = performance.now();
  }

  restartWithNewSeed() {
    const newSeed = Math.floor(Math.random() * 89999999 + 10000000);
    this.startScenario(newSeed);
  }

  toggleCameraView() {
    const mode = this.cameraSystem.toggleViewMode();
    const btn = document.getElementById('btn-cam-view');
    if (btn) btn.textContent = mode === 'FPV' ? 'View: FPV [V]' : 'View: Chase [V]';
    this.touchUI?.updateStatusBadges({ viewMode: mode });
  }

  toggleOpticalMode() {
    const mode = this.cameraSystem.toggleOpticalMode();
    this.world.setThermalMode(mode);
    this.reconModel.setThermalMode(mode);

    const btn = document.getElementById('btn-optical-mode');
    if (btn) {
      btn.textContent =
        mode === 'DAY'
          ? 'Optic: Day [T]'
          : mode === 'WHITE_HOT'
          ? 'Optic: FLIR W-Hot [T]'
          : 'Optic: FLIR B-Hot [T]';
    }
    this.touchUI?.updateStatusBadges({ opticalMode: mode });
  }

  toggleManualArm() {
    if (this.interceptionState.missionEnded) return;
    this.interceptionState.manualArmOverride = !this.interceptionState.manualArmOverride;
    this.interceptionState.warheadArmed = this.interceptionState.manualArmOverride;
  }

  /**
   * Evaluates Warhead Detonation (triggered by Space, RC Switch, or direct kinetic impact).
   * - Immediately hides FPV OSD overlay (display: none) while KEEPING active Thermal/FLIR shader mode
   * - Freezes and hides the player UAV mesh completely
   * - Instantly detaches camera to external spectator point 45-60m away & slightly above blast center
   * - Delays Mission Results overlay by 3.8 seconds while orbiting blast / tracking falling enemy wreckage
   */
  triggerWarheadDetonation(isKineticImpact = false) {
    if (this.interceptionState.missionEnded) return;

    const blastPos = this.physics.position.clone();
    const enemyPos = this.enemyAI.position.clone();
    const distM = blastPos.distanceTo(enemyPos);
    const icfg = this.config.interception;

    // 1. Immediately hide FPV OSD overlay & Touch Joysticks while keeping Thermal/FLIR filter active
    this.osd.setVisible(false);
    this.touchUI?.setDetonationHidden(true);

    // 2. Freeze player UAV physics & hide player UAV mesh completely
    this.physics.telemetry.detonated = true;
    this.physics.velocity.set(0, 0, 0);
    this.physics.prevVelocity.set(0, 0, 0);
    this.physics.angularVelocity.set(0, 0, 0);
    this.physics.prevAngularVelocity.set(0, 0, 0);
    this.interceptorModel.root.visible = false;

    this.interceptionState.missionEnded = true;
    this.interceptionState.detonationDistanceM = distM;
    this.interceptionState.resultsTimerSec = 0.0;

    // 3. Trigger explosion fireball & white-hot thermal debris at blast center
    this.effects.triggerExplosion(blastPos, 1.25);

    const hitEnemy = distM <= icfg.damageBlastRadiusM;

    // 4. Detach camera to external spectator observation point 45-60m away & slightly above
    const lookCenter = hitEnemy ? blastPos.clone().lerp(enemyPos, 0.5) : blastPos;
    this.cameraSystem.enterSpectatorDetonationMode(
      lookCenter,
      this.physics.quaternion,
      hitEnemy,
      this.world.getTerrainHeight
    );
    this.cameraSystem.addCameraShake(1.1);

    if (distM <= icfg.optimalKillRadiusM) {
      // Direct lethal interception!
      const blastDir = enemyPos.clone().sub(blastPos).normalize().multiplyScalar(12.0);
      blastDir.y += 3.5;
      this.enemyAI.triggerIntercepted(blastDir);
      this.reconModel.triggerDestruction();
      this.effects.triggerExplosion(enemyPos, 1.45);

      this.interceptionState.missionSuccess = true;
      this.interceptionState.statusLabel = 'TARGET DESTROYED';
      this.interceptionState.outcomeTitle = 'INTERCEPTION SUCCESSFUL — TARGET DESTROYED';
      this.interceptionState.outcomeSubtitle = isKineticImpact
        ? `Direct kinetic airframe impact (${distM.toFixed(1)} m) neutralized the enemy reconnaissance UAV.`
        : `High-order proximity detonation at ${distM.toFixed(1)} m (within ${icfg.optimalKillRadiusM} m lethal radius) destroyed the enemy reconnaissance UAV.`;
    } else if (distM <= icfg.damageBlastRadiusM) {
      // Outer blast radius hit — downs target with partial damage
      const blastDir = enemyPos.clone().sub(blastPos).normalize().multiplyScalar(8.0);
      this.enemyAI.triggerIntercepted(blastDir);
      this.reconModel.triggerDestruction();
      this.effects.triggerExplosion(enemyPos, 0.95);

      this.interceptionState.missionSuccess = true;
      this.interceptionState.statusLabel = 'TARGET CRITICAL HIT';
      this.interceptionState.outcomeTitle = 'INTERCEPTION COMPLETE — TARGET DOWNED (OUTER BLAST)';
      this.interceptionState.outcomeSubtitle = `Proximity detonation at ${distM.toFixed(1)} m crippled the enemy UAV's propulsion and tail surfaces.`;
    } else {
      // Missed — detonated too far from target
      this.interceptionState.missionSuccess = false;
      this.interceptionState.statusLabel = 'DETONATION MISSED';
      this.interceptionState.outcomeTitle = 'INTERCEPTION FAILED — DETONATION OUT OF RANGE';
      this.interceptionState.outcomeSubtitle = `Warhead detonated at ${distM.toFixed(1)} m from target (lethal proximity requires < ${icfg.optimalKillRadiusM} m). Approach closer before detonating.`;
    }
  }

  /**
   * Fixed-timestep gameplay & proximity update.
   */
  _stepInterceptionGameplay(dt) {
    const st = this.interceptionState;
    const pPos = this.physics.position;
    const ePos = this.enemyAI.position;
    const distM = pPos.distanceTo(ePos);
    const icfg = this.config.interception;

    if (!st.missionEnded) {
      // Check terrain crash
      if (this.physics.telemetry.crashed) {
        st.missionEnded = true;
        st.missionSuccess = false;
        st.detonationDistanceM = distM;
        st.statusLabel = 'AIRFRAME CRASHED';
        st.outcomeTitle = 'MISSION FAILED — TERRAIN IMPACT';
        st.outcomeSubtitle = 'The interceptor UAV collided with terrain. Maintain safe altitude and airspeed above 55 km/h stall threshold.';

        this.osd.setVisible(false);
        this.touchUI?.setDetonationHidden(true);
        this.interceptorModel.root.visible = false;
        this.effects.triggerExplosion(pPos, 1.0);
        this.cameraSystem.enterSpectatorDetonationMode(
          pPos,
          this.physics.quaternion,
          false,
          this.world.getTerrainHeight
        );
        this.cameraSystem.addCameraShake(1.2);
        return;
      }

      // Check battery depletion
      if (this.physics.telemetry.batteryDepleted && this.physics.telemetry.altitudeAGL < 5.0) {
        st.missionEnded = true;
        st.missionSuccess = false;
        st.detonationDistanceM = distM;
        st.statusLabel = 'BATTERY DEPLETED';
        st.outcomeTitle = 'MISSION TERMINATED — BATTERY DEPLETED';
        st.outcomeSubtitle = '6S battery pack exhausted before interception could be completed.';
        this.osd.setVisible(false);
        return;
      }

      // Check direct kinetic collision with enemy UAV
      if (distM <= icfg.kineticImpactRadiusM) {
        this.triggerWarheadDetonation(true);
        return;
      }

      // Update arming & pursuit status stages
      if (distM <= icfg.autoArmDistanceM || st.manualArmOverride) {
        st.warheadArmed = true;
      } else {
        st.warheadArmed = false;
      }

      if (distM <= icfg.optimalKillRadiusM) {
        st.statusLabel = 'PROXIMITY LOCK — DETONATE!';
      } else if (distM <= icfg.autoArmDistanceM) {
        st.statusLabel = 'TERMINAL APPROACH (ARMED)';
      } else if (distM <= 750.0) {
        st.statusLabel = 'PURSUIT / CLOSING';
      } else {
        st.statusLabel = 'SEARCHING / TRACKING';
      }

      this.touchUI?.updateStatusBadges({ inRange: distM <= icfg.optimalKillRadiusM });
    } else if (!st.resultsShown) {
      // Wait 3.8 seconds (within 3.5 - 4.0s requirement) showing external thermal spectator view
      // before fading in the Mission Results / Restart UI overlay
      st.resultsTimerSec += dt;
      if (st.resultsTimerSec >= 3.8) {
        st.resultsShown = true;
        this._showResultsModal();
      }
    }
  }

  /**
   * Main RequestAnimationFrame Loop:
   * Steps physics at fixed 120Hz rate and interpolates state for decoupled rendering.
   */
  _animate(nowMs) {
    requestAnimationFrame(this._animate);

    let frameDt = (nowMs - this.lastFrameTimeMs) * 0.001;
    this.lastFrameTimeMs = nowMs;

    if (frameDt <= 0.0 || frameDt > 0.25) {
      frameDt = this.fixedDt;
    }

    // FPS counter update
    this._fpsFrames++;
    this._fpsTimer += frameDt;
    if (this._fpsTimer >= 0.5) {
      this.fpsCounter = Math.round(this._fpsFrames / this._fpsTimer);
      this._fpsFrames = 0;
      this._fpsTimer = 0.0;
      const fpsEl = document.getElementById('fps-badge');
      if (fpsEl) fpsEl.textContent = `${this.fpsCounter} FPS`;
    }

    // 1. Poll keyboard, Virtual Touch Gimbals & USB RC Transmitter Gamepad inputs
    const controls = this.inputManager.update(frameDt);
    this.touchUI?.syncThrottleFromPhysics(controls.throttle);
    this.controllerUI.update();

    if (!this.isPaused) {
      // 2. Fixed-Timestep Physics Accumulator Loop
      this.accumulator += frameDt;
      const maxAccum = this.fixedDt * this.config.environment.maxSubSteps;
      if (this.accumulator > maxAccum) {
        this.accumulator = maxAccum;
      }

      while (this.accumulator >= this.fixedDt) {
        this.physics.step(this.fixedDt, controls, this.world.getTerrainHeight);
        this.enemyAI.step(this.fixedDt, this.world.getTerrainHeight);
        this._stepInterceptionGameplay(this.fixedDt);
        this.accumulator -= this.fixedDt;
      }
    }

    // 3. Compute interpolation factor alpha in [0, 1] for smooth decoupled rendering
    const alpha = this.accumulator / this.fixedDt;
    const playerInterp = this.physics.getInterpolatedState(alpha);
    const enemyInterp = this.enemyAI.getInterpolatedState(alpha);

    // 4. Update 3D Aircraft Meshes & Control Surface Animations
    if (this.interceptorModel.root.visible) {
      this.interceptorModel.root.position.copy(playerInterp.position);
      this.interceptorModel.root.quaternion.copy(playerInterp.quaternion);
      this.interceptorModel.updateAnimations(
        this.physics.surfaceDeflections,
        this.physics.telemetry.rpm,
        frameDt
      );
    }

    this.reconModel.root.position.copy(enemyInterp.position);
    this.reconModel.root.quaternion.copy(enemyInterp.quaternion);
    this.reconModel.update(frameDt);

    // 5. Update World Chunk Streaming, Particles, Camera, and Render 3D Scene
    this.world.update(this.cameraSystem.camera.position);

    const enemySmokePos =
      this.enemyAI.isDestroyed && !this.enemyAI.isCrashedOnGround
        ? enemyInterp.position
        : null;
    this.effects.update(frameDt, null, enemySmokePos);

    this.cameraSystem.update(
      frameDt,
      playerInterp,
      this.physics.telemetry,
      this.world.getTerrainHeight,
      this.interceptorModel,
      enemyInterp.position
    );

    this.cameraSystem.render();

    // 6. Render Analog FPV OSD Overlay (only while player UAV is alive)
    if (!this.interceptionState.missionEnded) {
      this.osd.render(frameDt, {
        telemetry: this.physics.telemetry,
        playerInterp,
        enemyInterp,
        enemyAI: this.enemyAI,
        inputManager: this.inputManager,
        cameraSystem: this.cameraSystem,
        interceptionState: this.interceptionState
      });
    }
  }

  _bindUIControls() {
    document.getElementById('btn-mobile-topbar-toggle')?.addEventListener('click', (e) => {
      e.stopPropagation();
      this.toggleMobileTopBar();
    });
    document.getElementById('btn-fullscreen')?.addEventListener('click', () => this.toggleFullscreen());
    document.getElementById('btn-cam-view')?.addEventListener('click', () => this.toggleCameraView());
    document.getElementById('btn-optical-mode')?.addEventListener('click', () => this.toggleOpticalMode());
    document.getElementById('btn-controller-ui')?.addEventListener('click', () => this.controllerUI.toggle());
    document.getElementById('btn-touch-rc')?.addEventListener('click', () => this.touchUI.toggle());
    document.getElementById('btn-detonate')?.addEventListener('click', () => this.triggerWarheadDetonation());
    document.getElementById('btn-restart')?.addEventListener('click', () => this.restartWithNewSeed());

    const seedApplyBtn = document.getElementById('btn-apply-seed');
    const seedInput = document.getElementById('seed-input');
    if (seedApplyBtn && seedInput) {
      seedApplyBtn.addEventListener('click', () => {
        const val = seedInput.value.trim();
        if (val) this.startScenario(Number(val) || val);
      });
    }

    const qualitySelect = document.getElementById('quality-select');
    if (qualitySelect) {
      qualitySelect.addEventListener('change', () => {
        const q = qualitySelect.value;
        const preset = this.config.world.qualityPresets[q];
        if (preset) {
          this.renderer.setPixelRatio(preset.pixelRatio);
          this.world.setQuality(q);
          this.cameraSystem.onResize(window.innerWidth, window.innerHeight);
        }
      });
    }

    // Results Modal Buttons
    document.getElementById('res-btn-new-mission')?.addEventListener('click', () => {
      this.restartWithNewSeed();
    });
    document.getElementById('res-btn-replay-seed')?.addEventListener('click', () => {
      this.startScenario(this.currentSeed);
    });

    // Verification Suite Modal Button
    const verifyBtn = document.getElementById('btn-verify-specs');
    const diagModal = document.getElementById('diagnostics-modal');
    const diagClose = document.getElementById('diag-close-btn');
    if (verifyBtn && diagModal) {
      verifyBtn.addEventListener('click', () => {
        this._runAndDisplayDiagnostics();
      });
    }
    if (diagClose && diagModal) {
      diagClose.addEventListener('click', () => {
        diagModal.classList.add('hidden');
      });
    }
  }

  _runAndDisplayDiagnostics() {
    const diagModal = document.getElementById('diagnostics-modal');
    const listEl = document.getElementById('diag-results-list');
    if (!diagModal || !listEl) return;

    const results = runVerificationSuite();
    listEl.innerHTML = results
      .map(
        (r) => `
        <div class="diag-item ${r.passed ? 'diag-pass' : 'diag-fail'}">
          <div class="diag-item-header">
            <span class="diag-status-badge">${r.passed ? 'PASS' : 'FAIL'}</span>
            <strong>${r.name}</strong>
          </div>
          <div class="diag-item-details">${r.details}</div>
        </div>
      `
      )
      .join('');

    diagModal.classList.remove('hidden');
  }

  _updateTopBarControllerBadge(status) {
    const badge = document.getElementById('rc-status-pill');
    if (!badge) return;
    if (status.connected) {
      badge.textContent = `RC: ${status.name}`;
      badge.classList.add('rc-connected');
    } else {
      badge.textContent = 'RC: Keyboard (Plug TX12 USB)';
      badge.classList.remove('rc-connected');
    }
  }

  _showResultsModal() {
    const modal = document.getElementById('results-modal');
    if (!modal) return;

    const st = this.interceptionState;
    const t = this.physics.telemetry;

    const titleEl = document.getElementById('res-title');
    const subEl = document.getElementById('res-subtitle');
    if (titleEl) {
      titleEl.textContent = st.outcomeTitle;
      titleEl.className = st.missionSuccess ? 'res-title-success' : 'res-title-fail';
    }
    if (subEl) subEl.textContent = st.outcomeSubtitle;

    const mins = Math.floor(t.flightTimeSec / 60);
    const secs = (t.flightTimeSec % 60).toFixed(1).padStart(4, '0');
    const avgSpeed = t.speedSamples > 0 ? t.speedSumKmh / t.speedSamples : t.airspeedKmh;

    const setField = (id, val) => {
      const el = document.getElementById(id);
      if (el) el.textContent = val;
    };

    setField('res-duration', `${mins}m ${secs}s`);
    setField(
      'res-distance',
      st.detonationDistanceM !== null ? `${st.detonationDistanceM.toFixed(1)} m` : 'N/A'
    );
    setField('res-max-speed', `${t.maxSpeedReachedKmh.toFixed(1)} km/h (Avg ${avgSpeed.toFixed(1)} km/h)`);
    setField('res-altitude', `${Math.round(t.altitudeMSL)} m MSL (${Math.round(t.altitudeAGL)} m AGL)`);
    setField(
      'res-battery',
      `${(100 - t.batteryPercent).toFixed(2)}% used (${Math.round(t.mahUsed)} mAh | ${t.batteryVoltage.toFixed(2)}V)`
    );
    setField('res-seed', `${this.currentSeed} (${this.enemyAI.patternName})`);

    modal.classList.remove('hidden');
    modal.classList.add('fade-in');
  }

  _hideResultsModal() {
    const modal = document.getElementById('results-modal');
    if (modal) {
      modal.classList.add('hidden');
      modal.classList.remove('fade-in');
    }
  }

  /**
   * Fullscreen & Mobile Landscape Mode Management
   */
  isFullscreen() {
    return Boolean(
      document.fullscreenElement ||
        document.webkitFullscreenElement ||
        document.mozFullScreenElement ||
        document.msFullscreenElement
    );
  }

  async enterFullscreen(lockLandscape = true) {
    const docEl = document.documentElement;
    try {
      if (!this.isFullscreen()) {
        if (docEl.requestFullscreen) {
          await docEl.requestFullscreen({ navigationUI: 'hide' });
        } else if (docEl.webkitRequestFullscreen) {
          docEl.webkitRequestFullscreen();
        } else if (docEl.msRequestFullscreen) {
          docEl.msRequestFullscreen();
        }
      }
    } catch (_) {
      // Browser may require a user gesture before entering fullscreen
    }

    if (lockLandscape) {
      this.lockLandscapeOrientation();
    }
    this._updateFullscreenButtonState();
  }

  async exitFullscreen() {
    try {
      if (document.exitFullscreen) {
        await document.exitFullscreen();
      } else if (document.webkitExitFullscreen) {
        document.webkitExitFullscreen();
      } else if (document.msExitFullscreen) {
        document.msExitFullscreen();
      }
    } catch (_) {}
    this._updateFullscreenButtonState();
  }

  toggleFullscreen() {
    if (this.isFullscreen()) {
      return this.exitFullscreen();
    } else {
      return this.enterFullscreen(true);
    }
  }

  lockLandscapeOrientation() {
    if (
      typeof screen !== 'undefined' &&
      screen.orientation &&
      typeof screen.orientation.lock === 'function'
    ) {
      screen.orientation.lock('landscape').catch(() => {});
    }
  }

  setMobileTopBarOpen(open) {
    const topBar = document.getElementById('top-bar');
    const toggleBtn = document.getElementById('btn-mobile-topbar-toggle');
    const isOpen = Boolean(open);
    if (topBar) {
      topBar.classList.toggle('mobile-topbar-open', isOpen);
    }
    if (toggleBtn) {
      toggleBtn.textContent = isOpen ? '✕' : '☰';
      toggleBtn.setAttribute('aria-expanded', String(isOpen));
      toggleBtn.classList.toggle('active', isOpen);
    }
  }

  toggleMobileTopBar() {
    const topBar = document.getElementById('top-bar');
    const currentlyOpen = Boolean(topBar && topBar.classList.contains('mobile-topbar-open'));
    this.setMobileTopBarOpen(!currentlyOpen);
    return !currentlyOpen;
  }

  _updateFullscreenButtonState() {
    const active = this.isFullscreen();
    const topBtn = document.getElementById('btn-fullscreen');
    if (topBtn) {
      topBtn.textContent = active ? 'Exit Full [F]' : 'Fullscreen [F]';
      topBtn.classList.toggle('hud-btn-primary', active);
    }
    const touchBtn = document.getElementById('touch-btn-fullscreen');
    if (touchBtn) {
      touchBtn.classList.toggle('icon-btn-active', active);
    }
  }

  _initMobileFullscreenAndLandscape() {
    // 1. Immediately attempt fullscreen & landscape lock on load
    this.enterFullscreen(true);

    // 2. Also bind a one-time gesture listener on first touch/click so if the mobile browser
    //    blocked non-gesture requestFullscreen() at boot, it enters fullscreen + landscape on first touch
    const onFirstMobileGesture = () => {
      if (!this.isFullscreen()) {
        this.enterFullscreen(true);
      } else {
        this.lockLandscapeOrientation();
      }
    };

    window.addEventListener('touchstart', onFirstMobileGesture, { passive: true, once: true });
    window.addEventListener('pointerdown', onFirstMobileGesture, { passive: true, once: true });
    window.addEventListener('click', onFirstMobileGesture, { passive: true, once: true });
  }

  _bindWindowLifecycle() {
    this._onResize = () => {
      const w = window.innerWidth;
      const h = window.innerHeight;
      this.renderer.setSize(w, h);
      this.cameraSystem.onResize(w, h);
      this.osd.onResize(w, h);
    };

    this._onFullscreenChange = () => {
      this._updateFullscreenButtonState();
      if (this.isFullscreen() && (this.touchUI.isMobile || this.touchUI.isTouchDevice)) {
        this.lockLandscapeOrientation();
      }
      this._onResize();
    };

    this._onVisibilityChange = () => {
      if (document.hidden) {
        this.accumulator = 0.0;
      } else {
        this.lastFrameTimeMs = performance.now();
      }
    };

    window.addEventListener('resize', this._onResize);
    window.addEventListener('visibilitychange', this._onVisibilityChange);
    document.addEventListener('fullscreenchange', this._onFullscreenChange);
    document.addEventListener('webkitfullscreenchange', this._onFullscreenChange);
  }

  _showFatalError(msg) {
    const errBanner = document.getElementById('fatal-error-banner');
    if (errBanner) {
      errBanner.textContent = msg;
      errBanner.classList.remove('hidden');
    }
  }
}

if (document.readyState === 'loading') {
  window.addEventListener('DOMContentLoaded', () => {
    window.skyWardApp = new SkyWardSimulator();
  });
} else {
  window.skyWardApp = new SkyWardSimulator();
}
