/**
 * BROADSIDE HYPERION — Helm Control Console
 *
 * Implements Newtonian piloting inputs for Desktop Keyboard and Tablet Multi-Touch
 * virtual thumbsticks, SAS PID stabilization toggling, physical continuous roll RCS
 * (dorsal/ventral thrusters, roll damper), and automatic orientation flight computer.
 */

function isTextEntryElement(el) {
  if (!el) return false;
  const tag = (el.tagName || '').toUpperCase();
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (el.isContentEditable) return true;
  if (tag === 'INPUT') {
    const type = (el.type || 'text').toLowerCase();
    const textTypes = ['text', 'search', 'email', 'password', 'number', 'url', 'tel'];
    return textTypes.includes(type);
  }
  return false;
}

export class HelmController {
  /**
   * @param {object} [options={}]
   * @param {function} [options.send] - Callback to send network message: send(msg)
   * @param {object} [options.sound] - SoundSynthesizer instance for sound effects
   */
  constructor(options = {}) {
    this.send = typeof options === 'function' ? options : (options.send || options.sendInput || (() => {}));
    this.sound = options.sound || options.soundSynth || null;
    this.isActive = options.isActive !== undefined ? Boolean(options.isActive) : true;

    // Pilot state
    this.state = {
      forward: 0,
      rcsForward: 0,
      strafe: 0,
      turn: 0,
      roll: 0,
      pitch: 0,
      throttle: 0,
    };

    this.throttleSetting = 0;
    this.buttonRoll = 0;
    this.leftStickForward = 0;
    this.leftStickStrafe = 0;
    this.rightStickTurn = 0;
    this.rightStickPitch = 0;

    // Keyboard state
    this.keys = {
      KeyW: false,
      KeyS: false,
      KeyA: false,
      KeyD: false,
      KeyQ: false,
      KeyE: false,
      KeyR: false,
      KeyT: false,
      Equal: false,
      Minus: false,
      ShiftLeft: false,
      ShiftRight: false,
      ControlLeft: false,
      ControlRight: false,
      BracketLeft: false,
      BracketRight: false,
      ArrowUp: false,
      ArrowDown: false,
      ArrowLeft: false,
      ArrowRight: false,
    };

    // Touch joystick tracking
    this.touchLeft = {
      id: null,
      startX: 0,
      startY: 0,
      currentX: 0,
      currentY: 0,
      active: false,
    };

    this.touchRight = {
      id: null,
      startX: 0,
      startY: 0,
      currentX: 0,
      currentY: 0,
      active: false,
    };

    this._wasHyperspaceStage0Offline = false;

    this.latestSnapshot = null;
    this._lastShip = null;
    this.isManualTurn = false;

    this.bound = false;
    this._listeners = [];

    if (typeof window !== 'undefined' && typeof document !== 'undefined') {
      this.bind();
    }
  }

  /**
   * Resets all held keys, button roll, and touch sticks, then recomputes state and emits input.
   *
   * @param {boolean} [emit=true] - Whether to emit helm input network packet
   */
  resetInputs(emit = true) {
    for (const k in this.keys) {
      this.keys[k] = false;
    }
    this.buttonRoll = 0;
    this.leftStickForward = 0;
    this.leftStickStrafe = 0;
    this.rightStickTurn = 0;
    this.rightStickPitch = 0;
    this.touchLeft.active = false;
    this.touchLeft.id = null;
    this.touchRight.active = false;
    this.touchRight.id = null;
    this.isManualTurn = false;

    if (emit === false) {
      this.throttleSetting = 0;
      this.syncThrottleUI(true);
    }

    if (typeof document !== 'undefined' && typeof document.querySelector === 'function') {
      const knobL = document.querySelector('#stick-left-zone .stick-knob');
      if (knobL) knobL.style.transform = 'translate3d(0px, 0px, 0)';
      const knobR = document.querySelector('#stick-right-zone .stick-knob');
      if (knobR) knobR.style.transform = 'translate3d(0px, 0px, 0)';
    }

    this.recomputeState();
    if (emit) {
      this.emitHelmInput();
    }
  }

  /**
   * Activates or deactivates Helm input handling.
   * When deactivated, immediately clears held keys, active virtual sticks, and zeroes thrusters.
   *
   * @param {boolean} active
   */
  setActive(active) {
    this.isActive = Boolean(active);
    if (!this.isActive) {
      this.resetInputs();
    }
  }

  /**
   * Checks whether Helm inputs should be blocked due to battle completion,
   * gameover state, replay mode, or player ship destruction.
   *
   * @returns {boolean}
   */
  _isBlockedByState() {
    if (typeof document !== 'undefined') {
      const el = document.getElementById('battle-outcome-overlay');
      if (el) {
        const isHidden = (el.classList && typeof el.classList.contains === 'function' && el.classList.contains('hidden')) || (el.style && el.style.display === 'none');
        if (!isHidden) {
          return true;
        }
      }
    }

    if (this.latestSnapshot) {
      if (this.latestSnapshot.replayActive || ['gameover', 'game_over', 'restarting'].includes(this.latestSnapshot.state)) {
        return true;
      }
    }

    if (this._lastShip) {
      if (this._lastShip.destroyed === true || (typeof this._lastShip.hullHp === 'number' && this._lastShip.hullHp <= 0)) {
        return true;
      }
    }

    return false;
  }

  /**
   * Checks whether Helm controller is active and permitted to process inputs.
   * Blocks input when inactive, when text fields are focused, when #lobby-overlay is open,
   * or when battle has concluded / ship is destroyed.
   *
   * @returns {boolean}
   */
  canHandleInput() {
    if (!this.isActive) return false;
    if (this._isBlockedByState()) return false;
    if (typeof document === 'undefined') return true;

    const lobby = document.getElementById('lobby-overlay');
    if (lobby && (lobby.classList.contains('active') || lobby.style.display === 'flex')) {
      return false;
    }

    const activeEl = document.activeElement;
    if (activeEl && isTextEntryElement(activeEl)) {
      return false;
    }

    return true;
  }

  /**
   * Binds keyboard, multi-touch joystick, and helm action button listeners.
   */
  bind() {
    if (this.bound || typeof window === 'undefined') return;
    this.bound = true;

    // Keyboard controls
    const onKeyDown = (e) => this.handleKeyDown(e);
    const onKeyUp = (e) => this.handleKeyUp(e);

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);

    // Window Blur / Visibility Reset
    const onWindowBlur = () => {
      this.resetInputs();
    };
    const onVisibilityChange = () => {
      if (typeof document === 'undefined' || document.hidden !== false) {
        this.resetInputs();
      }
    };

    window.addEventListener('blur', onWindowBlur);
    let removeDocVisibility = null;
    if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
      document.addEventListener('visibilitychange', onVisibilityChange);
      removeDocVisibility = () => {
        if (typeof document.removeEventListener === 'function') {
          document.removeEventListener('visibilitychange', onVisibilityChange);
        }
      };
    }

    this._listeners.push(() => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onWindowBlur);
      if (removeDocVisibility) removeDocVisibility();
    });

    // Throttle controls
    const slider = document.getElementById('helm-throttle-slider');
    if (slider) {
      const onSliderInput = () => {
        if (!this.canHandleInput()) return;
        this.throttleSetting = Math.max(0, Math.min(1, Number(slider.value) / 100));
        this.syncThrottleUI(false);
        this.recomputeState();
        this.emitHelmInput();
      };
      const onSliderBlur = () => {
        if (typeof slider.blur === 'function') {
          slider.blur();
        }
      };
      const onSliderKeyDown = (e) => {
        const flightKeys = [
          'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
          'KeyW', 'KeyS', 'ShiftLeft', 'ShiftRight', 'ControlLeft', 'ControlRight', 'Equal', 'Minus'
        ];
        if (flightKeys.includes(e.code)) {
          e.preventDefault();
        }
      };
      slider.addEventListener('input', onSliderInput);
      slider.addEventListener('change', onSliderInput);
      slider.addEventListener('change', onSliderBlur);
      slider.addEventListener('pointerup', onSliderBlur);
      slider.addEventListener('keydown', onSliderKeyDown);
      this._listeners.push(() => {
        slider.removeEventListener('input', onSliderInput);
        slider.removeEventListener('change', onSliderInput);
        slider.removeEventListener('change', onSliderBlur);
        slider.removeEventListener('pointerup', onSliderBlur);
        slider.removeEventListener('keydown', onSliderKeyDown);
      });
    }

    const btnZero = document.getElementById('btn-throttle-zero');
    if (btnZero) {
      const onZeroClick = (e) => {
        e.preventDefault();
        if (!this.canHandleInput()) return;
        this.throttleSetting = 0;
        this.syncThrottleUI(true);
        this.recomputeState();
        this.emitHelmInput();
      };
      btnZero.addEventListener('click', onZeroClick);
      this._listeners.push(() => btnZero.removeEventListener('click', onZeroClick));
    }

    const btnMax = document.getElementById('btn-throttle-max');
    if (btnMax) {
      const onMaxClick = (e) => {
        e.preventDefault();
        if (!this.canHandleInput()) return;
        this.throttleSetting = 1.0;
        this.syncThrottleUI(true);
        this.recomputeState();
        this.emitHelmInput();
      };
      btnMax.addEventListener('click', onMaxClick);
      this._listeners.push(() => btnMax.removeEventListener('click', onMaxClick));
    }

    // Touch thumbsticks
    const stickLeft = document.getElementById('stick-left-zone');
    const stickRight = document.getElementById('stick-right-zone');

    if (stickLeft) {
      this.bindThumbstick(stickLeft, this.touchLeft, (normX, normY) => {
        // Forward is pulling up (-Y), strafe is X (-1 port, +1 stbd)
        this.leftStickForward = Math.max(-1, Math.min(1, -normY));
        this.leftStickStrafe = normX;
        this.recomputeState();
        this.emitHelmInput();
      }, 1.0);
    }

    if (stickRight) {
      this.bindThumbstick(stickRight, this.touchRight, (normX, normY) => {
        // Turn: dragging right stick rightward (normX > 0) turns RIGHT (omega > 0)
        // Pitch: pushing up (normY < 0) -> pitch < 0 (nose down); pulling down (normY > 0) -> pitch > 0 (nose up)
        this.rightStickTurn = normX;
        this.rightStickPitch = normY;
        this.recomputeState();
        this.emitHelmInput();
      }, 1.5);
    }

    // Action buttons: SAS
    const btnSas = document.getElementById('btn-toggle-sas');
    if (btnSas) {
      const onSasClick = (e) => {
        e.preventDefault();
        if (!this.canHandleInput()) return;
        this.toggleSas();
      };
      btnSas.addEventListener('click', onSasClick);
      this._listeners.push(() => btnSas.removeEventListener('click', onSasClick));
    }

    // Action buttons: Roll Port (Ventral RCS)
    const btnRollPort = document.getElementById('btn-roll-port');
    if (btnRollPort) {
      const onDown = (e) => {
        if (e && typeof e.preventDefault === 'function') e.preventDefault();
        if (!this.canHandleInput()) return;
        if (e && e.pointerId !== undefined && typeof btnRollPort.setPointerCapture === 'function') {
          try {
            btnRollPort.setPointerCapture(e.pointerId);
          } catch (_) {}
        }
        this.buttonRoll = -1;
        this.recomputeState();
        this.emitHelmInput();
      };
      const onUp = (e) => {
        if (e && e.pointerId !== undefined && typeof btnRollPort.releasePointerCapture === 'function') {
          try {
            btnRollPort.releasePointerCapture(e.pointerId);
          } catch (_) {}
        }
        if (this.buttonRoll === -1) {
          if (e && typeof e.preventDefault === 'function') e.preventDefault();
          this.buttonRoll = 0;
          this.recomputeState();
          if (this.canHandleInput()) {
            this.emitHelmInput();
          }
        }
      };
      const onKey = (e) => {
        if (e.code === 'Space' || e.code === 'Enter') {
          if (e.type === 'keydown') {
            if (!this.canHandleInput()) return;
            e.preventDefault();
            if (this.buttonRoll !== -1) {
              this.buttonRoll = -1;
              this.recomputeState();
              this.emitHelmInput();
            }
          } else if (e.type === 'keyup') {
            if (this.buttonRoll === -1) {
              e.preventDefault();
              this.buttonRoll = 0;
              this.recomputeState();
              if (this.canHandleInput()) {
                this.emitHelmInput();
              }
            }
          }
        }
      };
      const onClick = (e) => {
        if (e && typeof e.preventDefault === 'function') e.preventDefault();
      };
      btnRollPort.addEventListener('pointerdown', onDown);
      btnRollPort.addEventListener('pointerup', onUp);
      btnRollPort.addEventListener('pointercancel', onUp);
      btnRollPort.addEventListener('pointerleave', onUp);
      btnRollPort.addEventListener('keydown', onKey);
      btnRollPort.addEventListener('keyup', onKey);
      btnRollPort.addEventListener('click', onClick);
      this._listeners.push(() => {
        btnRollPort.removeEventListener('pointerdown', onDown);
        btnRollPort.removeEventListener('pointerup', onUp);
        btnRollPort.removeEventListener('pointercancel', onUp);
        btnRollPort.removeEventListener('pointerleave', onUp);
        btnRollPort.removeEventListener('keydown', onKey);
        btnRollPort.removeEventListener('keyup', onKey);
        btnRollPort.removeEventListener('click', onClick);
      });
    }

    // Action buttons: Roll Starboard (Dorsal RCS)
    const btnRollStbd = document.getElementById('btn-roll-starboard');
    if (btnRollStbd) {
      const onDown = (e) => {
        if (e && typeof e.preventDefault === 'function') e.preventDefault();
        if (!this.canHandleInput()) return;
        if (e && e.pointerId !== undefined && typeof btnRollStbd.setPointerCapture === 'function') {
          try {
            btnRollStbd.setPointerCapture(e.pointerId);
          } catch (_) {}
        }
        this.buttonRoll = 1;
        this.recomputeState();
        this.emitHelmInput();
      };
      const onUp = (e) => {
        if (e && e.pointerId !== undefined && typeof btnRollStbd.releasePointerCapture === 'function') {
          try {
            btnRollStbd.releasePointerCapture(e.pointerId);
          } catch (_) {}
        }
        if (this.buttonRoll === 1) {
          if (e && typeof e.preventDefault === 'function') e.preventDefault();
          this.buttonRoll = 0;
          this.recomputeState();
          if (this.canHandleInput()) {
            this.emitHelmInput();
          }
        }
      };
      const onKey = (e) => {
        if (e.code === 'Space' || e.code === 'Enter') {
          if (e.type === 'keydown') {
            if (!this.canHandleInput()) return;
            e.preventDefault();
            if (this.buttonRoll !== 1) {
              this.buttonRoll = 1;
              this.recomputeState();
              this.emitHelmInput();
            }
          } else if (e.type === 'keyup') {
            if (this.buttonRoll === 1) {
              e.preventDefault();
              this.buttonRoll = 0;
              this.recomputeState();
              if (this.canHandleInput()) {
                this.emitHelmInput();
              }
            }
          }
        }
      };
      const onClick = (e) => {
        if (e && typeof e.preventDefault === 'function') e.preventDefault();
      };
      btnRollStbd.addEventListener('pointerdown', onDown);
      btnRollStbd.addEventListener('pointerup', onUp);
      btnRollStbd.addEventListener('pointercancel', onUp);
      btnRollStbd.addEventListener('pointerleave', onUp);
      btnRollStbd.addEventListener('keydown', onKey);
      btnRollStbd.addEventListener('keyup', onKey);
      btnRollStbd.addEventListener('click', onClick);
      this._listeners.push(() => {
        btnRollStbd.removeEventListener('pointerdown', onDown);
        btnRollStbd.removeEventListener('pointerup', onUp);
        btnRollStbd.removeEventListener('pointercancel', onUp);
        btnRollStbd.removeEventListener('pointerleave', onUp);
        btnRollStbd.removeEventListener('keydown', onKey);
        btnRollStbd.removeEventListener('keyup', onKey);
        btnRollStbd.removeEventListener('click', onClick);
      });
    }

    // Action buttons: Stop Roll (Roll Damper)
    const btnStopRoll = document.getElementById('btn-stop-roll');
    if (btnStopRoll) {
      const onStopClick = (e) => {
        e.preventDefault();
        if (!this.canHandleInput()) return;
        this.stopRoll();
      };
      btnStopRoll.addEventListener('click', onStopClick);
      this._listeners.push(() => btnStopRoll.removeEventListener('click', onStopClick));
    }

    // Action buttons: Turn and Burn
    const btnTurnBurn = document.getElementById('btn-turn-and-burn');
    if (btnTurnBurn) {
      const onTurnBurnClick = (e) => {
        e.preventDefault();
        if (!this.canHandleInput()) return;
        this.toggleTurnAndBurn();
      };
      btnTurnBurn.addEventListener('click', onTurnBurnClick);
      this._listeners.push(() => btnTurnBurn.removeEventListener('click', onTurnBurnClick));
    }

    // Action buttons: Automatic Orientation Flight Computer
    const orientModes = ['prograde', 'retrograde', 'target', 'anti_target'];
    for (const mode of orientModes) {
      const btnId = `btn-orient-${mode.replace('_', '-')}`;
      const btn = document.getElementById(btnId);
      if (btn) {
        const onOrientClick = (e) => {
          e.preventDefault();
          if (!this.canHandleInput()) return;
          this.setAutoOrient(btn.dataset.orient || mode);
        };
        btn.addEventListener('click', onOrientClick);
        this._listeners.push(() => btn.removeEventListener('click', onOrientClick));
      }
    }

    // Action buttons: Hyperspace Jump Button [H]
    const btnHyperspace = document.getElementById('btn-hyperspace');
    if (btnHyperspace) {
      const onHyperspaceClick = (e) => {
        e.preventDefault();
        if (!this.canHandleInput()) return;
        this.triggerHyperspace();
      };
      const onPointerUp = () => {
        if (typeof btnHyperspace.blur === 'function') btnHyperspace.blur();
      };
      btnHyperspace.addEventListener('click', onHyperspaceClick);
      btnHyperspace.addEventListener('pointerup', onPointerUp);
      this._listeners.push(() => {
        btnHyperspace.removeEventListener('click', onHyperspaceClick);
        btnHyperspace.removeEventListener('pointerup', onPointerUp);
      });
    }
  }

  /**
   * Unbinds all registered DOM listeners.
   */
  destroy() {
    for (const unbind of this._listeners) {
      unbind();
    }
    this._listeners = [];
    this.bound = false;
  }

  /**
   * Binds a multi-touch thumbstick zone.
   *
   * @param {HTMLElement} element - Stick zone container
   * @param {object} touchData - State tracker for this touch
   * @param {function} onMove - Callback (normalizedX, normalizedY)
   * @param {number|object} [options=1.0] - Response curve exponent or options object
   */
  bindThumbstick(element, touchData, onMove, options = {}) {
    const maxRadius = 50; // px
    const knob = element.querySelector('.stick-knob');
    const responseCurve = typeof options === 'number' ? options : (options?.responseCurve ?? 1.0);

    let mouseActive = false;
    const resetKnob = () => {
      mouseActive = false;
      touchData.active = false;
      touchData.id = null;
      if (knob) {
        knob.style.transform = 'translate3d(0px, 0px, 0)';
      }
      if (this.canHandleInput()) {
        onMove(0, 0);
      } else {
        if (touchData === this.touchLeft) {
          this.leftStickForward = 0;
          this.leftStickStrafe = 0;
        } else if (touchData === this.touchRight) {
          this.rightStickTurn = 0;
          this.rightStickPitch = 0;
        }
        this.recomputeState();
      }
    };

    const onTouchStart = (e) => {
      if (!this.canHandleInput()) return;
      e.preventDefault();
      if (touchData.active) return;

      const touch = e.changedTouches[0];
      touchData.active = true;
      touchData.id = touch.identifier;

      const rect = element.getBoundingClientRect ? element.getBoundingClientRect() : { left: 0, top: 0, width: 0, height: 0 };
      const centerX = rect.left + rect.width / 2;
      const centerY = rect.top + rect.height / 2;

      touchData.startX = centerX;
      touchData.startY = centerY;
      this.updateThumbstick(touch, touchData, maxRadius, knob, onMove, responseCurve);
    };

    const onTouchMove = (e) => {
      if (!touchData.active) return;
      if (!this.canHandleInput()) {
        resetKnob();
        return;
      }
      for (let i = 0; i < e.changedTouches.length; i++) {
        const touch = e.changedTouches[i];
        if (touch.identifier === touchData.id) {
          e.preventDefault();
          this.updateThumbstick(touch, touchData, maxRadius, knob, onMove, responseCurve);
          break;
        }
      }
    };

    const onTouchEnd = (e) => {
      for (let i = 0; i < e.changedTouches.length; i++) {
        const touch = e.changedTouches[i];
        if (touch.identifier === touchData.id) {
          e.preventDefault();
          resetKnob();
          break;
        }
      }
    };

    const onMouseDown = (e) => {
      if (e.button !== 0) return;
      if (!this.canHandleInput()) return;
      e.preventDefault();
      mouseActive = true;
      touchData.active = true;
      touchData.id = 'mouse';
      const rect = element.getBoundingClientRect ? element.getBoundingClientRect() : { left: 0, top: 0, width: 0, height: 0 };
      const centerX = rect.left + rect.width / 2;
      const centerY = rect.top + rect.height / 2;
      touchData.startX = centerX;
      touchData.startY = centerY;
      this.updateThumbstick(e, touchData, maxRadius, knob, onMove, responseCurve);
    };

    const onMouseMove = (e) => {
      if (!mouseActive || !touchData.active) return;
      if (!this.canHandleInput()) {
        resetKnob();
        return;
      }
      e.preventDefault();
      this.updateThumbstick(e, touchData, maxRadius, knob, onMove, responseCurve);
    };

    const onMouseUp = () => {
      if (!mouseActive && !touchData.active) return;
      resetKnob();
    };

    element.addEventListener('touchstart', onTouchStart, { passive: false });
    window.addEventListener('touchmove', onTouchMove, { passive: false });
    window.addEventListener('touchend', onTouchEnd, { passive: false });
    window.addEventListener('touchcancel', onTouchEnd, { passive: false });

    element.addEventListener('mousedown', onMouseDown);
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);

    this._listeners.push(() => {
      element.removeEventListener('touchstart', onTouchStart);
      element.removeEventListener('mousedown', onMouseDown);
      if (typeof window !== 'undefined') {
        window.removeEventListener('touchmove', onTouchMove);
        window.removeEventListener('touchend', onTouchEnd);
        window.removeEventListener('touchcancel', onTouchEnd);
        window.removeEventListener('mousemove', onMouseMove);
        window.removeEventListener('mouseup', onMouseUp);
      }
    });
  }

  /**
   * Updates thumbstick position and fires normalized movement.
   * Applies a 0.12 radial deadzone (rescaling 0.12..1.0 smoothly to 0..1)
   * and optional power response curve while preserving direction.
   *
   * @param {Touch} touch
   * @param {object} touchData
   * @param {number} maxRadius
   * @param {HTMLElement|null} knob
   * @param {function} onMove
   * @param {number|object} [responseCurve=1.0]
   */
  updateThumbstick(touch, touchData, maxRadius, knob, onMove, responseCurve = 1.0) {
    const curve = typeof responseCurve === 'object' && responseCurve !== null
      ? (responseCurve.responseCurve ?? 1.0)
      : (Number(responseCurve) || 1.0);

    const dx = touch.clientX - touchData.startX;
    const dy = touch.clientY - touchData.startY;
    const dist = Math.hypot(dx, dy);

    const clampedDist = Math.min(dist, maxRadius);
    const angle = Math.atan2(dy, dx);
    const clampedX = Math.cos(angle) * clampedDist;
    const clampedY = Math.sin(angle) * clampedDist;

    if (knob) {
      knob.style.transform = `translate3d(${clampedX}px, ${clampedY}px, 0)`;
    }

    const DEADZONE = 0.12;
    const rawMag = clampedDist / maxRadius;

    let normX = 0;
    let normY = 0;

    if (rawMag > DEADZONE) {
      const rescaledMag = Math.min(1.0, Math.max(0.0, (rawMag - DEADZONE) / (1.0 - DEADZONE)));
      const curvedMag = curve !== 1.0 ? Math.pow(rescaledMag, curve) : rescaledMag;
      normX = Math.cos(angle) * curvedMag;
      normY = Math.sin(angle) * curvedMag;
    }

    onMove(normX, normY);
  }

  /**
   * Keyboard key down handler.
   */
  handleKeyDown(e) {
    if (!this.canHandleInput()) return;

    // Ignore input if typing in text fields
    if (e.target && isTextEntryElement(e.target)) {
      return;
    }

    if (e.code === 'KeyZ') {
      e.preventDefault();
      this.toggleSas();
      return;
    }

    if (e.code === 'KeyX') {
      e.preventDefault();
      this.stopRoll();
      return;
    }

    if (e.code === 'KeyB') {
      e.preventDefault();
      this.toggleTurnAndBurn();
      return;
    }

    if (e.code === 'KeyH' && !e.repeat) {
      e.preventDefault();
      this.triggerHyperspace();
      return;
    }

    if (e.code === 'Digit1' || e.code === 'Numpad1') {
      e.preventDefault();
      this.setAutoOrient('prograde');
      return;
    }

    if (e.code === 'Digit2' || e.code === 'Numpad2') {
      e.preventDefault();
      this.setAutoOrient('retrograde');
      return;
    }

    if (e.code === 'Digit3' || e.code === 'Numpad3') {
      e.preventDefault();
      this.setAutoOrient('target');
      return;
    }

    if (e.code === 'Digit4' || e.code === 'Numpad4') {
      e.preventDefault();
      this.setAutoOrient('anti_target');
      return;
    }

    let changed = false;

    if (e.code === 'ShiftLeft' || e.code === 'ShiftRight' || e.code === 'Equal') {
      if (!this.keys[e.code]) {
        this.keys[e.code] = true;
        this.throttleSetting = Math.min(1.0, this.throttleSetting + 0.05);
        this.syncThrottleUI(true);
        changed = true;
      }
    } else if (e.code === 'ControlLeft' || e.code === 'ControlRight' || e.code === 'Minus') {
      if (!this.keys[e.code]) {
        this.keys[e.code] = true;
        this.throttleSetting = Math.max(0.0, this.throttleSetting - 0.05);
        this.syncThrottleUI(true);
        changed = true;
      }
    } else if (e.code in this.keys) {
      if (e.code.startsWith('Arrow')) {
        e.preventDefault();
      }
      if (['KeyA', 'KeyD', 'ArrowLeft', 'ArrowRight'].includes(e.code)) {
        this.isManualTurn = true;
      }
      if (!this.keys[e.code]) {
        this.keys[e.code] = true;
        changed = true;
      }
    }

    if (changed) {
      this.recomputeState();
      this.emitHelmInput();
    }
  }

  /**
   * Keyboard key up handler.
   */
  handleKeyUp(e) {
    if (e.target && isTextEntryElement(e.target)) return;

    if (e.code in this.keys) {
      this.keys[e.code] = false;
      this.isManualTurn = Boolean(this.keys.KeyA || this.keys.KeyD || this.keys.ArrowLeft || this.keys.ArrowRight);
      this.recomputeState();
      if (this.canHandleInput()) {
        this.emitControl();
      }
    }
  }

  /**
   * Recomputes forward, strafe, turn, pitch, and roll values from keys and button state.
   */
  recomputeState() {
    const forward = Math.max(0, Math.min(1, this.throttleSetting));

    let rcsForward = 0;
    if (this.keys.KeyW) rcsForward += 1.0;
    if (this.keys.KeyS) rcsForward -= 1.0;
    if (this.touchLeft.active && this.leftStickForward !== undefined) {
      rcsForward = this.leftStickForward;
    }
    rcsForward = Math.max(-1, Math.min(1, rcsForward));

    let strafe = 0;
    if (this.keys.KeyQ) strafe -= 1.0; // Strafe Port
    if (this.keys.KeyE) strafe += 1.0; // Strafe Starboard
    if (this.touchLeft.active && this.leftStickStrafe !== undefined) {
      strafe = this.leftStickStrafe;
    }

    let turn = 0;
    if (this.keys.KeyA || this.keys.ArrowLeft) turn -= 1.0;  // Turn LEFT / Port / CCW (omega < 0)
    if (this.keys.KeyD || this.keys.ArrowRight) turn += 1.0; // Turn RIGHT / Starboard / CW (omega > 0)
    if (this.touchRight.active && this.rightStickTurn !== undefined) {
      turn = this.rightStickTurn;
    }

    let pitch = 0;
    if (this.keys.ArrowUp) pitch -= 1.0;   // Pitch forwards / nose down (-1.0)
    if (this.keys.ArrowDown) pitch += 1.0; // Pull back / nose up (+1.0)
    if (this.touchRight.active && this.rightStickPitch !== undefined) {
      pitch = this.rightStickPitch;
    }
    pitch = Math.max(-1.0, Math.min(1.0, pitch));

    let roll = this.buttonRoll || 0;
    if (this.keys.KeyR || this.keys.BracketLeft) roll -= 1.0; // Roll Port / CCW (ventralRoll)
    if (this.keys.KeyT || this.keys.BracketRight) roll += 1.0; // Roll Starboard / CW (dorsalRoll)
    roll = Math.max(-1, Math.min(1, roll));

    this.state.forward = forward;
    this.state.rcsForward = rcsForward;
    this.state.strafe = strafe;
    this.state.turn = turn;
    this.state.roll = roll;
    this.state.pitch = pitch;
    this.state.throttle = this.throttleSetting;
  }

  /**
   * Smoothly ramps throttle setting while keys are held and syncs UI.
   *
   * @param {number} [dt=0.016]
   */
  step(dt = 0.016) {
    if (!this.canHandleInput()) return;
    let changed = false;
    const rampRate = 0.55;

    if (this.keys.ShiftLeft || this.keys.ShiftRight || this.keys.Equal) {
      const prev = this.throttleSetting;
      this.throttleSetting = Math.min(1.0, this.throttleSetting + rampRate * dt);
      if (Math.abs(this.throttleSetting - prev) > 1e-4) changed = true;
    }

    if (this.keys.ControlLeft || this.keys.ControlRight || this.keys.Minus) {
      const prev = this.throttleSetting;
      this.throttleSetting = Math.max(0.0, this.throttleSetting - rampRate * dt);
      if (Math.abs(this.throttleSetting - prev) > 1e-4) changed = true;
    }

    if (changed) {
      this.syncThrottleUI(true);
      this.recomputeState();
      this.emitHelmInput();
    }
  }

  /**
   * Directly sets the persistent engine throttle setting [0..1] and syncs UI.
   *
   * @param {number} val
   */
  setThrottleSetting(val) {
    this.throttleSetting = Math.max(0.0, Math.min(1.0, Number(val) || 0));
    this.syncThrottleUI(true);
    this.recomputeState();
    this.emitHelmInput();
  }

  /**
   * Synchronizes throttle slider and text percentage readout.
   *
   * @param {boolean} [updateSlider=true]
   */
  syncThrottleUI(updateSlider = true) {
    if (typeof document === 'undefined') return;
    const pct = Math.round(this.throttleSetting * 100);
    const valEl = document.getElementById('helm-throttle-value');
    if (valEl) valEl.textContent = `${pct}%`;
    if (updateSlider) {
      const slider = document.getElementById('helm-throttle-slider');
      if (slider && Number(slider.value) !== pct) {
        slider.value = String(pct);
      }
    }
  }

  /**
   * Evaluates keyboard state (alias for recomputeState).
   */
  updateStateFromKeyboard() {
    this.recomputeState();
  }

  /**
   * Dispatches helm_input over network socket.
   */
  emitHelmInput(extra = {}) {
    this.send({
      type: 'helm_input',
      forward: this.state.forward,
      rcsForward: this.state.rcsForward,
      strafe: this.state.strafe,
      turn: this.state.turn,
      roll: this.state.roll,
      pitch: this.state.pitch,
      mainThrottle: this.state.forward,
      throttleSetting: this.throttleSetting,
      ...extra,
    });
  }

  /**
   * Dispatches control input over network socket (alias for emitHelmInput).
   */
  emitControl(extra = {}) {
    return this.emitHelmInput(extra);
  }

  /**
   * Toggles SAS mode.
   */
  toggleSas() {
    if (!this.canHandleInput()) return;
    this.emitHelmInput({ toggleSas: true });
    if (this.sound && typeof this.sound.playConduitClick === 'function') {
      this.sound.playConduitClick();
    }
  }

  /**
   * Stops active roll using counter-torque roll damper.
   */
  stopRoll() {
    if (!this.canHandleInput()) return;

    if (this._lastShip) {
      const hs = this._lastShip.hyperspace;
      const isStage0 = hs?.state === 'jumping' || (hs?.state === 'rebooting' && (hs.rebootTimer ?? 0) < (hs.stage1Sec ?? 4.0));
      if (isStage0) return;
      if (this._lastShip.powerMap && (this._lastShip.powerMap.rcs_thrusters ?? 0) <= 0) return;
    }

    this.buttonRoll = 0;
    this.state.roll = 0;
    this.emitHelmInput({ stopRoll: true, roll: 0 });
    if (this.sound && typeof this.sound.playRcsHiss === 'function') {
      this.sound.playRcsHiss();
    }
  }

  /**
   * Toggles turn-and-burn: flip retrograde and burn until velocity is zero.
   * Cuts the throttle first so the server does not treat it as a thrust change.
   */
  toggleTurnAndBurn() {
    if (!this.canHandleInput()) return;
    if (this.latestTurnAndBurn) {
      this.emitHelmInput({ toggleTurnAndBurn: true, turn: 0, pitch: 0 });
    } else {
      this.throttleSetting = 0;
      this.syncThrottleUI(true);
      this.recomputeState();
      this.state.forward = 0;
      this.state.rcsForward = 0;
      this.state.turn = 0;
      this.state.pitch = 0;
      this.emitHelmInput({ toggleTurnAndBurn: true, forward: 0, rcsForward: 0, mainThrottle: 0, turn: 0, pitch: 0 });
    }
    if (this.sound && typeof this.sound.playConduitClick === 'function') {
      this.sound.playConduitClick();
    }
  }

  /**
   * Commands the SAS flight computer to auto-orient toward a target vector.
   *
   * @param {'prograde'|'retrograde'|'target'|'anti_target'} mode
   */
  setAutoOrient(mode) {
    if (!this.canHandleInput()) return;
    this.state.turn = 0;
    this.state.pitch = 0;
    this.emitHelmInput({ toggleAutoOrient: mode, turn: 0, pitch: 0 });
    if (this.sound && typeof this.sound.playConduitClick === 'function') {
      this.sound.playConduitClick();
    }
  }

  /**
   * Triggers hyperspace jump toggle: initiates charging from ready, or aborts active charging.
   */
  triggerHyperspace() {
    if (!this.canHandleInput()) return;
    this.send({ type: 'helm_input', toggleHyperspace: true });
    if (this.sound && typeof this.sound.playConduitClick === 'function') {
      this.sound.playConduitClick();
    }
  }

  /**
   * Normalizes angle into [-PI, PI] range.
   *
   * @param {number} rad
   * @returns {number}
   */
  normalizeAngle(rad) {
    return ((rad + Math.PI) % (Math.PI * 2) + (Math.PI * 2)) % (Math.PI * 2) - Math.PI;
  }

  /**
   * Updates relative enemy vector HUD overlay (relative bearing, elevation, distance, velocity).
   *
   * @param {object} ship - Player's ship snapshot
   * @param {object} enemyShip - Opponent's ship snapshot
   */
  updateEnemyVector(ship, enemyShip) {
    if (typeof document === 'undefined') return;

    const card = document.getElementById('helm-enemy-vector');
    const statusEl = document.getElementById('helm-enemy-status');
    const arrowEl = document.getElementById('helm-enemy-arrow');
    const bearingEl = document.getElementById('helm-enemy-bearing');
    const velocityEl = document.getElementById('helm-enemy-velocity');

    if (!card) return;

    const isEnemyInWarp = enemyShip?.hyperspace?.state === 'jumping';
    const isSensorsOffline = ship?.sensorsOnline === false;
    const isObscured = !ship ||
      isSensorsOffline ||
      ship.targetAvailable === false ||
      isEnemyInWarp ||
      ship.inNebula === true ||
      ship.targetHiddenInNebula === true ||
      ship.enemyHidden === true ||
      ship.enemyHiddenInNebula === true ||
      !enemyShip ||
      enemyShip.inNebula === true ||
      enemyShip.enemyHiddenInNebula === true ||
      enemyShip.destroyed === true ||
      !enemyShip.pos;

    if (isObscured) {
      card.classList.add('obscured');
      let statusText = 'SIGNAL OBSCURED / NEBULA';
      if (isSensorsOffline) {
        statusText = 'SENSORS OFFLINE';
      } else if (isEnemyInWarp || ship.targetAvailable === false) {
        statusText = 'NO TARGET LOCK';
      } else if (enemyShip?.destroyed) {
        statusText = 'TARGET DESTROYED';
      }
      if (statusEl) statusEl.textContent = statusText;
      if (bearingEl) bearingEl.textContent = 'BRG ---° | ELV --° | RNG ----m';
      if (velocityEl) velocityEl.textContent = 'VEL --- m/s | HDG ---° | CLS --- m/s';
      if (arrowEl) arrowEl.style.transform = '';
      return;
    }

    card.classList.remove('obscured');
    if (statusEl) statusEl.textContent = 'TRACKING';

    const dx = enemyShip.pos.x - ship.pos.x;
    const dy = enemyShip.pos.y - ship.pos.y;
    const dz = (enemyShip.pos.z || 0) - (ship.pos.z || 0);

    const enemyAngle = Math.atan2(dy, dx);
    const relYaw = this.normalizeAngle(enemyAngle - (ship.angle || 0));
    const distHoriz = Math.hypot(dx, dy);
    const rng = Math.hypot(dx, dy, dz);
    const elvDeg = Math.round(Math.atan2(dz, Math.max(1, distHoriz)) * 180 / Math.PI);

    // Rotate arrow by relative yaw in degrees (0° nose forward / up, +90° right / starboard)
    const arrowDeg = (relYaw * 180 / Math.PI).toFixed(1);
    if (arrowEl) {
      arrowEl.style.transform = `rotate(${arrowDeg}deg)`;
    }

    // Relative bearing in 000°-359° format
    const relBrgDeg = Math.round((((relYaw * 180 / Math.PI) % 360) + 360) % 360).toString().padStart(3, '0');
    const elvSign = elvDeg >= 0 ? '+' : '-';
    if (bearingEl) {
      bearingEl.textContent = `BRG ${relBrgDeg}° | ELV ${elvSign}${Math.abs(elvDeg)}° | RNG ${Math.round(rng)}m`;
    }

    // Enemy velocity, heading, closing speed
    const evx = enemyShip.vel?.x || 0;
    const evy = enemyShip.vel?.y || 0;
    const evz = enemyShip.vel?.z || 0;
    const vel = Math.hypot(evx, evy, evz);
    const hdg = (((Math.atan2(evy, evx) * 180 / Math.PI) % 360) + 360) % 360;

    const mvx = ship.vel?.x || 0;
    const mvy = ship.vel?.y || 0;
    const mvz = ship.vel?.z || 0;
    const closing = -((evx - mvx) * dx + (evy - mvy) * dy + (evz - mvz) * dz) / Math.max(1, rng);

    const hdgDeg = Math.round(hdg).toString().padStart(3, '0');
    const clsSign = closing >= 0 ? '+' : '';
    if (velocityEl) {
      velocityEl.textContent = `VEL ${Math.round(vel)} m/s | HDG ${hdgDeg}° | CLS ${clsSign}${Math.round(closing)} m/s`;
    }
  }

  /**
   * Updates all Helm HUD gauges, thruster indicators, action buttons, and enemy vector overlay from latest ship state snapshot.
   *
   * @param {object} ship - Ship state object from snapshot
   * @param {object} [enemyShip] - Opponent ship state object from snapshot
   */
  updateHUD(ship, enemyShip) {
    if (!ship) return;
    this._lastShip = ship;

    if (this._isBlockedByState()) {
      if (this.throttleSetting !== 0) {
        this.throttleSetting = 0;
        this.syncThrottleUI(true);
      }
      this.resetInputs(false);
    }

    if (enemyShip !== undefined) {
      this._lastEnemyShip = enemyShip;
    }
    const currentEnemyShip = enemyShip || this._lastEnemyShip || null;

    // Hyperspace transition tracking: reset stale throttleSetting when entering jumping or Stage-0 reboot (<4.0s)
    const hs = ship.hyperspace || {};
    const hsState = hs.state || 'ready';
    const hsCharge = hs.charge || 0;
    const rebootTimer = hs.rebootTimer || 0;
    const stage1Sec = hs.stage1Sec || 4.0;
    const rebootDuration = hs.rebootDuration || 7.0;
    const hsPower = ship.powerMap?.hyperspace ?? 1;
    const hsHealth = hs.health ?? 100;

    const isJumping = hsState === 'jumping';
    const isStage0 = hsState === 'rebooting' && rebootTimer < stage1Sec;
    const isStage1 = hsState === 'rebooting' && rebootTimer >= stage1Sec && rebootTimer < rebootDuration;
    const driveRestricted = isJumping || isStage0;
    const systemsRestricted = isJumping || isStage0 || isStage1;

    const isHyperspaceOffline = driveRestricted;
    const wasOffline = Boolean(this._wasHyperspaceStage0Offline);
    if (isHyperspaceOffline) {
      if (!wasOffline || this.throttleSetting !== 0) {
        this.throttleSetting = 0;
        this.syncThrottleUI(true);
        this.recomputeState();
      }
    }
    this._wasHyperspaceStage0Offline = isHyperspaceOffline;

    if (typeof document === 'undefined') return;

    // 1. Kinematic Telemetry
    const speedEl = document.getElementById('helm-speed');
    const speed = ship.vel ? Math.hypot(ship.vel.x, ship.vel.y, ship.vel.z || 0) : 0;
    if (speedEl && ship.vel) {
      speedEl.textContent = `${speed.toFixed(1)} m/s`;
    }

    const headingEl = document.getElementById('helm-heading');
    if (headingEl && ship.angle !== undefined) {
      const deg = ((((ship.angle * 180 / Math.PI) % 360) + 360) % 360).toFixed(1);
      headingEl.textContent = `${deg.padStart(5, '0')}°`;
    }

    const omegaEl = document.getElementById('helm-omega');
    if (omegaEl && ship.omega !== undefined) {
      omegaEl.textContent = `${ship.omega.toFixed(3)} rad/s`;
    }

    // Roll Telemetry (φ / ωx)
    const rollEl = document.getElementById('helm-roll-telemetry');
    if (rollEl) {
      const rollAngle = ship.rollAngle !== undefined
        ? ship.rollAngle
        : ((ship.rollState || 0) * Math.PI);
      const rollDeg = ((((rollAngle * 180 / Math.PI) % 360) + 360) % 360).toFixed(1);
      const rollOmega = (ship.rollOmega !== undefined ? ship.rollOmega : (ship.omegaX || 0)).toFixed(2);
      const invertedSuffix = Math.cos(rollAngle) < 0 ? ' [INVERTED]' : '';
      rollEl.textContent = `${rollDeg}° (${rollOmega} rad/s)${invertedSuffix}`;
    }

    // Pitch Telemetry
    const pitchEl = document.getElementById('helm-pitch');
    if (pitchEl) {
      const p = ship.pitch || 0;
      const deg = (p * 180 / Math.PI).toFixed(1);
      const sign = p >= 0 ? '+' : '';
      pitchEl.textContent = `${sign}${deg}°`;
    }

    // Altitude / Elevation Z Telemetry
    const altEl = document.getElementById('helm-alt');
    if (altEl) {
      const z = Math.round(ship.pos?.z || 0);
      const sign = z >= 0 ? '+' : '';
      altEl.textContent = `${sign}${z}m`;
    }

    const throttleEl = document.getElementById('helm-throttle');
    if (throttleEl && ship.mainDrive) {
      const pct = Math.round((ship.mainDrive.throttle || 0) * 100);
      throttleEl.textContent = `${pct}%`;
    }

    // 2. Main Drive Offline & Overheat Flashing Alerts
    const mainPower = ship.powerMap?.main_drive ?? 1;
    const mainOffline = !ship.mainDrive || ship.mainDrive.health <= 0 || ship.mainDrive.powered === false || mainPower <= 0;
    const mainOverheated = Boolean(ship.mainDrive?.overheated || ship.thermal?.mainDrive?.overheated);

    const throttlePanel = document.getElementById('helm-throttle-panel');
    if (throttlePanel) {
      if (mainOffline || driveRestricted) {
        throttlePanel.classList.add('alert-flash-red');
        throttlePanel.classList.remove('alert-flash-yellow');
      } else if (mainOverheated) {
        throttlePanel.classList.add('alert-flash-yellow');
        throttlePanel.classList.remove('alert-flash-red');
      } else {
        throttlePanel.classList.remove('alert-flash-red', 'alert-flash-yellow');
      }
    }
    const throttleSlider = document.getElementById('helm-throttle-slider');
    if (throttleSlider && throttleSlider.classList) {
      if (mainOffline || driveRestricted) {
        throttleSlider.classList.add('offline');
      } else {
        throttleSlider.classList.remove('offline');
      }
    }

    // 3. RCS Thrusters Nozzles (10 banks: 6 original + 4 pitch)
    const nozzleKeys = [
      'bowPort', 'bowStarboard', 'sternPort', 'sternStarboard', 'dorsalRoll', 'ventralRoll',
      'bowDorsal', 'bowVentral', 'sternDorsal', 'sternVentral'
    ];
    for (const nozzleKey of nozzleKeys) {
      let pill = document.getElementById(`rcs-${nozzleKey}`);
      if (!pill) {
        const kebab = nozzleKey.replace(/([A-Z])/g, '-$1').toLowerCase();
        pill = document.getElementById(`rcs-${kebab}`);
      }
      if (!pill) continue;

      const thruster = ship.thrusters?.[nozzleKey];
      const stateSpan = (pill.querySelector && pill.querySelector('.rcs-state')) || pill;

      pill.classList.remove('nominal', 'firing', 'damaged', 'offline');

      if (!thruster || thruster.health <= 0) {
        pill.classList.add('offline');
        if (stateSpan) stateSpan.textContent = 'OFFLINE';
      } else if (!thruster.powered) {
        pill.classList.add('offline');
        if (stateSpan) stateSpan.textContent = 'NO PWR';
      } else if (thruster.isFiring || (thruster.throttle || 0) > 0) {
        pill.classList.add('firing');
        if (stateSpan) stateSpan.textContent = `${Math.round((thruster.throttle || 1) * 100)}%`;
      } else if (thruster.health < 100) {
        pill.classList.add('damaged');
        if (stateSpan) stateSpan.textContent = `${Math.round(thruster.health)}%`;
      } else {
        pill.classList.add('nominal');
        if (stateSpan) stateSpan.textContent = '100%';
      }
    }

    // 4. RCS Availability, Orientation Presets, Roll & Gimbal Fallback Alerts
    const rcsPower = ship.powerMap?.rcs_thrusters ?? 1;
    const rotNozzleKeys = ['bowPort', 'bowStarboard', 'sternPort', 'sternStarboard'];
    const rcsRotationalOffline = rotNozzleKeys.every((k) => {
      const t = ship.thrusters?.[k];
      return !t || t.health <= 0 || t.powered === false;
    });
    const rcsOffline = rcsPower <= 0 || rcsRotationalOffline;
    const rcsOverheated = Boolean(ship.thermal?.rcs?.overheated);
    const gimbalSteeringAvail = !mainOffline && (ship.mainDrive?.throttle || 0) > 0.01;

    const orientPresetIds = [
      'btn-orient-prograde', 'btn-orient-retrograde', 'btn-orient-target', 'btn-orient-anti-target'
    ];
    const rollButtonIds = ['btn-roll-port', 'btn-stop-roll', 'btn-roll-starboard'];

    if (rcsOffline) {
      for (const id of orientPresetIds) {
        document.getElementById(id)?.classList.add('alert-flash-red');
      }
      for (const id of rollButtonIds) {
        document.getElementById(id)?.classList.add('alert-flash-red');
      }
      document.getElementById('stick-left-zone')?.classList.add('alert-flash-red');

      const stickRightZone = document.getElementById('stick-right-zone');
      const stickRightLabel = stickRightZone?.querySelector('.stick-label');
      if (stickRightZone) {
        if (gimbalSteeringAvail) {
          stickRightZone.classList.add('alert-flash-yellow');
          stickRightZone.classList.remove('alert-flash-red');
          if (stickRightLabel) stickRightLabel.textContent = 'ROTATION (GIMBAL ONLY)';
        } else {
          stickRightZone.classList.add('alert-flash-red');
          stickRightZone.classList.remove('alert-flash-yellow');
          if (stickRightLabel) stickRightLabel.textContent = 'ROTATION OFFLINE';
        }
      }
    } else {
      for (const id of orientPresetIds) {
        document.getElementById(id)?.classList.remove('alert-flash-red');
      }
      for (const id of rollButtonIds) {
        document.getElementById(id)?.classList.remove('alert-flash-red');
      }
      document.getElementById('stick-left-zone')?.classList.remove('alert-flash-red');

      const stickRightZone = document.getElementById('stick-right-zone');
      const stickRightLabel = stickRightZone?.querySelector('.stick-label');
      if (stickRightZone) {
        stickRightZone.classList.remove('alert-flash-red');
        if (rcsOverheated) {
          stickRightZone.classList.add('alert-flash-yellow');
        } else {
          stickRightZone.classList.remove('alert-flash-yellow');
        }
        if (stickRightLabel) stickRightLabel.textContent = 'ROTATION (ARROWS)';
      }
    }

    // 5. SAS Button State
    const btnSas = document.getElementById('btn-toggle-sas');
    if (btnSas) {
      const btnMain = btnSas.querySelector('.btn-main');
      if (systemsRestricted) {
        btnSas.classList.add('disabled');
        btnSas.disabled = true;
        if (btnMain) btnMain.textContent = 'SAS OFFLINE';
      } else if (ship.sasActive) {
        btnSas.classList.remove('disabled');
        btnSas.disabled = false;
        btnSas.classList.add('active');
        if (btnMain) btnMain.textContent = 'SAS ACTIVE';
      } else {
        btnSas.classList.remove('disabled');
        btnSas.disabled = false;
        btnSas.classList.remove('active');
        if (btnMain) btnMain.textContent = 'SAS DECOUPLED';
      }
    }

    // 6. Physical Roll Buttons Active States
    const btnStopRoll = document.getElementById('btn-stop-roll');
    if (btnStopRoll) {
      if (ship.stopRollActive) {
        btnStopRoll.classList.add('active');
      } else {
        btnStopRoll.classList.remove('active');
      }
    }

    const btnRollPort = document.getElementById('btn-roll-port');
    if (btnRollPort) {
      if (ship.thrusters?.ventralRoll?.isFiring || (ship.thrusters?.ventralRoll?.throttle || 0) > 0) {
        btnRollPort.classList.add('active');
      } else {
        btnRollPort.classList.remove('active');
      }
    }

    const btnRollStbd = document.getElementById('btn-roll-starboard');
    if (btnRollStbd) {
      if (ship.thrusters?.dorsalRoll?.isFiring || (ship.thrusters?.dorsalRoll?.throttle || 0) > 0) {
        btnRollStbd.classList.add('active');
      } else {
        btnRollStbd.classList.remove('active');
      }
    }

    // 7. Turn and Burn Button State
    this.latestTurnAndBurn = Boolean(ship.turnAndBurn);
    const btnTurnBurn = document.getElementById('btn-turn-and-burn');
    if (btnTurnBurn) {
      const tbMain = btnTurnBurn.querySelector('.btn-main');
      if (ship.turnAndBurn) {
        btnTurnBurn.classList.add('active');
        btnTurnBurn.classList.remove('disabled');
        btnTurnBurn.disabled = false;
        if (tbMain) tbMain.textContent = 'BURNING (CANCEL)';
      } else {
        btnTurnBurn.classList.remove('active');
        if (tbMain) tbMain.textContent = 'TURN AND BURN';
        const tbDisabled = speed < 2.0 || driveRestricted || systemsRestricted;
        btnTurnBurn.classList.toggle('disabled', tbDisabled);
        btnTurnBurn.disabled = tbDisabled;
      }
    }

    // 7b. Automatic Orientation Flight Computer Buttons State
    const orientModes = ['prograde', 'retrograde', 'target', 'anti_target'];
    for (const mode of orientModes) {
      const btnId = `btn-orient-${mode.replace('_', '-')}`;
      const btn = document.getElementById(btnId);
      if (!btn) continue;

      if (ship.autoOrientMode === mode) {
        btn.classList.add('active');
      } else {
        btn.classList.remove('active');
      }

      // Check disabled availability
      let disabled = false;
      if (systemsRestricted) {
        disabled = true;
      } else if (mode === 'prograde' || mode === 'retrograde') {
        if (speed < 2.0) disabled = true;
      } else if (mode === 'target' || mode === 'anti_target') {
        if (ship.targetAvailable === false || ship.sensorsOnline === false || ship.inNebula === true || ship.enemyHidden === true || ship.targetHiddenInNebula === true || currentEnemyShip?.hyperspace?.state === 'jumping') {
          disabled = true;
        }
      }

      if (disabled) {
        btn.classList.add('disabled');
        btn.disabled = true;
      } else {
        btn.classList.remove('disabled');
        btn.disabled = false;
      }
    }

    // 7c. Hyperspace Jump Button State
    const btnHyperspace = document.getElementById('btn-hyperspace');
    if (btnHyperspace) {
      let progressStr = '0%';
      if (hsState === 'ready' || hsState === 'charging') {
        progressStr = `${Math.round(hsCharge * 100)}%`;
      } else if (hsState === 'jumping') {
        progressStr = '100%';
      } else if (hsState === 'rebooting') {
        progressStr = `${((rebootTimer / 7.0) * 100).toFixed(1)}%`;
      }
      btnHyperspace.style.setProperty('--hyper-progress', progressStr);

      btnHyperspace.classList.remove('charging', 'jumping', 'reboot-stage1', 'reboot-stage2', 'disabled');

      if (hsState === 'charging') {
        btnHyperspace.textContent = `ABORT JUMP ${Math.round(hsCharge * 100)}%`;
        btnHyperspace.classList.add('charging');
        btnHyperspace.disabled = false;
      } else if (hsState === 'jumping') {
        btnHyperspace.textContent = 'WARP TRANSIT';
        btnHyperspace.classList.add('jumping');
        btnHyperspace.classList.add('disabled');
        btnHyperspace.disabled = true;
      } else if (hsState === 'rebooting') {
        if (rebootTimer < stage1Sec) {
          btnHyperspace.textContent = `REBOOT ${(stage1Sec - rebootTimer).toFixed(1)}s`;
          btnHyperspace.classList.add('reboot-stage1');
          btnHyperspace.classList.add('disabled');
        } else {
          btnHyperspace.textContent = `SYS BOOT ${(rebootDuration - rebootTimer).toFixed(1)}s`;
          btnHyperspace.classList.add('reboot-stage2');
          btnHyperspace.classList.add('disabled');
        }
        btnHyperspace.disabled = true;
      } else {
        // ready state
        if (hsPower <= 0 || hsHealth <= 0 || ship.destroyed) {
          btnHyperspace.textContent = 'HYPERSPACE OFFLINE';
          btnHyperspace.classList.add('disabled');
          btnHyperspace.disabled = true;
        } else {
          btnHyperspace.textContent = 'HYPERSPACE [H]';
          btnHyperspace.disabled = false;
        }
      }
    }

    // 7d. External Views PiPs (offline indicator)
    if (typeof document.querySelectorAll === 'function') {
      const pipPanels = document.querySelectorAll('.helm-pip-panel, .helm-pips-cluster, #helm-pip-panel');
      pipPanels.forEach((p) => {
        if (ship.externalViewsOnline === false) {
          p.classList.add('pip-offline');
        } else {
          p.classList.remove('pip-offline');
        }
      });
    }

    // 8. Enemy Vector Overlay
    this.updateEnemyVector(ship, currentEnemyShip);
  }

  /**
   * Alias for updateHUD to update telemetry and thrusters.
   *
   * @param {object} ship
   * @param {object} [enemyShip]
   */
  updateTelemetry(ship, enemyShip) {
    this.updateHUD(ship, enemyShip);
  }
}
