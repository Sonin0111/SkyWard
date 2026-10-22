import { clamp, DEG2RAD } from '../utils/math.js';

/**
 * Authentic Analog FPV On-Screen Display (ArduPilot / INAV MAX7456 OSD Style).
 * Matches the attached reference image strictly:
 * - Crisp white (#FFFFFF) 7-segment digits & pixel/monospace glyphs with hard 1px-2px black outline (#000000)
 * - ZERO background boxes
 * - Top-Left: Signal bars icon + Link Quality number (98)
 * - Top-Center: Spaced uppercase "A R M E D" (flashes "I N   R A N G E" when within 15m of target)
 * - Top-Right: Solid battery icon + real-time 6S voltage ("21.5 v")
 * - Center: Minimalist diamond reticle with cardinal dots (· ◊ ·) + Artificial Horizon made ONLY
 *           of a horizontal row of spaced white dots (·  ·  ·  ·  ·) that tilts with roll and moves with pitch
 * - Middle-Right (Stacked): Altitude ("3179 Alt/m") above Vertical Speed ("▲ 6.8 m/s")
 * - Bottom-Left (Stacked): Flight mode "F B W A" above Airspeed ("Air spd 130 km/h")
 * - Bottom-Right: Throttle percentage ("66 %")
 */
export class TacticalOSD {
  constructor(canvas, config) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.config = config;

    this.width = window.innerWidth;
    this.height = window.innerHeight;
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);

    this.onResize(this.width, this.height);
  }

  onResize(width, height) {
    this.width = width;
    this.height = height;
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = Math.floor(width * this.dpr);
    this.canvas.height = Math.floor(height * this.dpr);
    this.canvas.style.width = `${width}px`;
    this.canvas.style.height = `${height}px`;
  }

  /**
   * Immediately shows or hides the OSD canvas element (display: none on detonation).
   */
  setVisible(visible) {
    this.canvas.style.display = visible ? 'block' : 'none';
  }

  /**
   * Renders the minimalist analog MAX7456 FPV OSD overlay.
   */
  render(dt, state) {
    const { telemetry, playerInterp, enemyInterp, interceptionState } = state;

    // Immediately hide OSD if detonated or mission ended
    if (telemetry.detonated || interceptionState.missionEnded) {
      this.setVisible(false);
      return;
    }
    if (this.canvas.style.display === 'none') {
      this.setVisible(true);
    }

    const ctx = this.ctx;
    const w = this.width;
    const h = this.height;

    ctx.save();
    ctx.scale(this.dpr, this.dpr);
    ctx.clearRect(0, 0, w, h);

    // Compute distance to target for IN RANGE flash (< 15m) & link quality
    const distToTargetM = playerInterp.position.distanceTo(enemyInterp.position);
    const inRange = distToTargetM <= 15.0;

    // Scale OSD elements proportionally to viewport while preserving crisp MAX7456 proportions
    const scale = clamp(Math.min(w / 1280, h / 720), 0.78, 1.35);
    const marginX = Math.round(w * 0.035);
    const topY = Math.round(Math.max(82, h * 0.095)); // Clean margin below top toolbar
    const bottomY = Math.round(h - Math.max(36, h * 0.065));
    const cx = w * 0.5;
    const cy = h * 0.5;

    // 1. TOP-LEFT: Signal Bars Icon + Link Quality ("98")
    const rssiVal = clamp(99 - Math.floor(playerInterp.position.length() / 2200), 94, 99);
    this._drawSignalAndRSSI(ctx, marginX, topY, String(rssiVal), scale);

    // 2. TOP-CENTER: "A R M E D" (flashes "I N   R A N G E" when within 15m of target)
    this._drawTopCenterStatus(ctx, cx, topY + 22 * scale, inRange, scale);

    // 3. TOP-RIGHT: Battery Icon + Real-time 6S Voltage ("21.5 v")
    this._drawTopRightBattery(ctx, w - marginX, topY, telemetry.batteryVoltage, scale);

    // 4. CENTER: Minimalist Diamond Reticle (· ◊ ·) + Dotted Artificial Horizon (·  ·  ·  ·  ·)
    this._drawCenterReticleAndDottedHorizon(ctx, cx, cy, telemetry.pitchDeg, telemetry.rollDeg, scale);

    // 5. MIDDLE-RIGHT (Stacked): Altitude ("3179 Alt/m") above Vertical Speed ("▲ 6.8 m/s")
    this._drawMiddleRightAltAndVSI(
      ctx,
      w - marginX,
      cy + 10 * scale,
      Math.round(telemetry.altitudeMSL),
      telemetry.verticalSpeedMs,
      scale
    );

    // 6. BOTTOM-LEFT (Stacked): Flight Mode "F B W A" above Airspeed ("Air spd 130 km/h")
    this._drawBottomLeftModeAndAirspeed(
      ctx,
      marginX,
      bottomY,
      Math.round(telemetry.airspeedKmh),
      scale
    );

    // 7. BOTTOM-RIGHT: Throttle Percentage ("66 %")
    this._drawBottomRightThrottle(
      ctx,
      w - marginX,
      bottomY,
      Math.round(telemetry.throttlePercent),
      scale
    );

    ctx.restore();
  }

  /**
   * Draws crisp white text with a hard 1px-2px black outline and zero background boxes.
   */
  _drawOutlinedText(ctx, text, x, y, fontSizePx, align = 'left', letterSpacingPx = 0) {
    ctx.save();
    ctx.font = `700 ${Math.round(fontSizePx)}px "Consolas", "Lucida Console", "Courier New", monospace`;
    ctx.textAlign = align;
    ctx.textBaseline = 'alphabetic';
    ctx.lineJoin = 'miter';
    ctx.miterLimit = 2;

    if (letterSpacingPx > 0 && align === 'center') {
      const spaced = text.split('').join(' ');
      ctx.strokeStyle = '#000000';
      ctx.lineWidth = Math.max(3.0, fontSizePx * 0.16);
      ctx.strokeText(spaced, x, y);
      ctx.fillStyle = '#FFFFFF';
      ctx.fillText(spaced, x, y);
    } else {
      ctx.strokeStyle = '#000000';
      ctx.lineWidth = Math.max(3.0, fontSizePx * 0.16);
      ctx.strokeText(text, x, y);
      ctx.fillStyle = '#FFFFFF';
      ctx.fillText(text, x, y);
    }
    ctx.restore();
  }

  /**
   * Draws a rectangular shape in crisp white (#FFFFFF) with a hard black outline (#000000).
   */
  _drawOutlinedRect(ctx, x, y, w, h, outlineW = 1.6) {
    ctx.fillStyle = '#000000';
    ctx.fillRect(x - outlineW, y - outlineW, w + outlineW * 2, h + outlineW * 2);
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(x, y, w, h);
  }

  /**
   * Renders a string of digits ('0'-'9', '.', '-') using authentic MAX7456 7-segment geometry.
   * Returns total width drawn.
   */
  _drawSevenSegmentString(ctx, str, startX, topY, digitW, digitH, thick, gap) {
    // 7-segment bitmask: [top, topRight, botRight, bottom, botLeft, topLeft, middle]
    const SEG_MAP = {
      '0': [1, 1, 1, 1, 1, 1, 0],
      '1': [0, 1, 1, 0, 0, 0, 0],
      '2': [1, 1, 0, 1, 1, 0, 1],
      '3': [1, 1, 1, 1, 0, 0, 1],
      '4': [0, 1, 1, 0, 0, 1, 1],
      '5': [1, 0, 1, 1, 0, 1, 1],
      '6': [1, 0, 1, 1, 1, 1, 1],
      '7': [1, 1, 1, 0, 0, 0, 0],
      '8': [1, 1, 1, 1, 1, 1, 1],
      '9': [1, 1, 1, 1, 0, 1, 1],
      '-': [0, 0, 0, 0, 0, 0, 1]
    };

    let curX = startX;
    const halfH = digitH * 0.5;
    const outline = Math.max(1.4, thick * 0.48);

    // Pass 1: Black outlines for all segments so adjacent segments merge cleanly
    // Pass 2: White fills for all segments
    for (let pass = 0; pass < 2; pass++) {
      let x = startX;
      const isOutline = pass === 0;
      ctx.fillStyle = isOutline ? '#000000' : '#FFFFFF';
      const pad = isOutline ? outline : 0;

      for (let i = 0; i < str.length; i++) {
        const ch = str[i];
        if (ch === '.') {
          const dotSize = thick * 1.15;
          ctx.fillRect(
            x - pad,
            topY + digitH - dotSize - pad,
            dotSize + pad * 2,
            dotSize + pad * 2
          );
          x += dotSize + gap * 0.85;
          continue;
        }
        if (ch === ' ') {
          x += digitW * 0.65 + gap;
          continue;
        }

        const mask = SEG_MAP[ch];
        if (mask) {
          // 0: Top horizontal
          if (mask[0]) {
            ctx.fillRect(x - pad, topY - pad, digitW + pad * 2, thick + pad * 2);
          }
          // 1: Top-Right vertical
          if (mask[1]) {
            ctx.fillRect(x + digitW - thick - pad, topY - pad, thick + pad * 2, halfH + thick * 0.5 + pad * 2);
          }
          // 2: Bottom-Right vertical
          if (mask[2]) {
            ctx.fillRect(x + digitW - thick - pad, topY + halfH - thick * 0.5 - pad, thick + pad * 2, halfH + thick * 0.5 + pad * 2);
          }
          // 3: Bottom horizontal
          if (mask[3]) {
            ctx.fillRect(x - pad, topY + digitH - thick - pad, digitW + pad * 2, thick + pad * 2);
          }
          // 4: Bottom-Left vertical
          if (mask[4]) {
            ctx.fillRect(x - pad, topY + halfH - thick * 0.5 - pad, thick + pad * 2, halfH + thick * 0.5 + pad * 2);
          }
          // 5: Top-Left vertical
          if (mask[5]) {
            ctx.fillRect(x - pad, topY - pad, thick + pad * 2, halfH + thick * 0.5 + pad * 2);
          }
          // 6: Middle horizontal
          if (mask[6]) {
            ctx.fillRect(x - pad, topY + halfH - thick * 0.5 - pad, digitW + pad * 2, thick + pad * 2);
          }
        }
        x += digitW + gap;
      }
      curX = x;
    }

    return curX - startX;
  }

  /**
   * Measures the pixel width of a 7-segment string before drawing.
   */
  _measureSevenSegmentString(str, digitW, thick, gap) {
    let w = 0;
    const dotSize = thick * 1.15;
    for (let i = 0; i < str.length; i++) {
      const ch = str[i];
      if (ch === '.') w += dotSize + gap * 0.85;
      else if (ch === ' ') w += digitW * 0.65 + gap;
      else w += digitW + gap;
    }
    return Math.max(0, w - gap);
  }

  /**
   * 1. Top-Left: Signal Bars Icon + Link Quality ("98")
   */
  _drawSignalAndRSSI(ctx, x, y, rssiStr, scale) {
    const dW = 19 * scale;
    const dH = 34 * scale;
    const thick = 3.2 * scale;
    const gap = 6 * scale;

    // 4 ascending signal bars aligned to bottom of digits
    const barW = 3.5 * scale;
    const barGap = 2.5 * scale;
    const baseY = y + dH;
    const barHeights = [6 * scale, 10 * scale, 15 * scale, 21 * scale];

    for (let i = 0; i < 4; i++) {
      const bx = x + i * (barW + barGap);
      const bh = barHeights[i];
      this._drawOutlinedRect(ctx, bx, baseY - bh, barW, bh, 1.4 * scale);
    }

    const numStartX = x + 4 * (barW + barGap) + 6 * scale;
    this._drawSevenSegmentString(ctx, rssiStr, numStartX, y, dW, dH, thick, gap);
  }

  /**
   * 2. Top-Center: Spaced uppercase "A R M E D" (flashes "I N   R A N G E" within 15m of target)
   */
  _drawTopCenterStatus(ctx, cx, baselineY, inRange, scale) {
    if (inRange) {
      // Flash at ~6 Hz when within 15m lethal range
      const flashOn = Math.floor(performance.now() / 160) % 2 === 0;
      if (flashOn) {
        this._drawOutlinedText(ctx, 'I N   R A N G E', cx, baselineY, 22 * scale, 'center');
      }
    } else {
      this._drawOutlinedText(ctx, 'A R M E D', cx, baselineY, 22 * scale, 'center');
    }
  }

  /**
   * 3. Top-Right: Solid Battery Icon + Real-time 6S Voltage ("21.5 v")
   */
  _drawTopRightBattery(ctx, rightX, y, voltage, scale) {
    const vStr = voltage.toFixed(1);
    const dW = 19 * scale;
    const dH = 34 * scale;
    const thick = 3.2 * scale;
    const gap = 6 * scale;

    const unitW = 16 * scale;
    const numW = this._measureSevenSegmentString(vStr, dW, thick, gap);
    const numStartX = rightX - unitW - numW;

    // Draw battery icon to the left of voltage digits
    const batW = 13 * scale;
    const batH = 22 * scale;
    const batX = numStartX - batW - 10 * scale;
    const batY = y + dH - batH;

    // Battery top terminal nub
    const nubW = 6 * scale;
    const nubH = 3.5 * scale;
    this._drawOutlinedRect(ctx, batX + (batW - nubW) * 0.5, batY - nubH, nubW, nubH, 1.4 * scale);
    // Battery main body
    this._drawOutlinedRect(ctx, batX, batY, batW, batH, 1.5 * scale);

    // Draw 7-segment voltage number
    this._drawSevenSegmentString(ctx, vStr, numStartX, y, dW, dH, thick, gap);

    // Draw small 'v' unit at bottom right
    this._drawOutlinedText(ctx, 'v', rightX, y + dH, 17 * scale, 'right');
  }

  /**
   * 4. Center: Minimalist Diamond Reticle with 4 Dots (· ◊ ·) +
   *    Artificial Horizon made ONLY of a horizontal row of spaced white dots (·  ·  ·  ·  ·)
   *    that tilts with roll and moves vertically with pitch.
   */
  _drawCenterReticleAndDottedHorizon(ctx, cx, cy, pitchDeg, rollDeg, scale) {
    ctx.save();
    ctx.translate(cx, cy);

    // A) Fixed Center Diamond Reticle with surrounding dots (matches reference photo)
    const diamR = 6.5 * scale;

    // Black outline pass for diamond
    ctx.strokeStyle = '#000000';
    ctx.lineWidth = 4.2 * scale;
    ctx.beginPath();
    ctx.moveTo(0, -diamR);
    ctx.lineTo(diamR, 0);
    ctx.lineTo(0, diamR);
    ctx.lineTo(-diamR, 0);
    ctx.closePath();
    ctx.stroke();

    // White foreground pass for diamond
    ctx.strokeStyle = '#FFFFFF';
    ctx.lineWidth = 1.8 * scale;
    ctx.stroke();

    // Reticle dots around diamond: top, bottom, inner-left, outer-left, inner-right, outer-right
    const dotS = 3.0 * scale;
    const reticleDots = [
      [0, -13 * scale],
      [0, 13 * scale],
      [-13 * scale, 0],
      [-21 * scale, 0],
      [13 * scale, 0],
      [21 * scale, 0]
    ];
    for (let i = 0; i < reticleDots.length; i++) {
      const [dx, dy] = reticleDots[i];
      this._drawOutlinedRect(ctx, dx - dotS * 0.5, dy - dotS * 0.5, dotS, dotS, 1.3 * scale);
    }

    // B) Dotted Artificial Horizon (ONLY a horizontal row of spaced white dots)
    const rollRad = -rollDeg * DEG2RAD;
    const pitchPixelsPerDeg = 4.0 * scale;
    const horizonY = clamp(pitchDeg * pitchPixelsPerDeg, -140 * scale, 140 * scale);

    ctx.rotate(rollRad);

    const hDotW = 4.2 * scale;
    const hDotH = 3.2 * scale;
    const dotSpacing = 36 * scale;

    // 8 spaced horizon dots (-4, -3, -2, -1 and +1, +2, +3, +4)
    for (let idx = -4; idx <= 4; idx++) {
      if (idx === 0) continue;
      const hx = idx * dotSpacing;
      this._drawOutlinedRect(
        ctx,
        hx - hDotW * 0.5,
        horizonY - hDotH * 0.5,
        hDotW,
        hDotH,
        1.4 * scale
      );
    }

    ctx.restore();
  }

  /**
   * 5. Middle-Right (Stacked):
   *    Upper: Altitude ("3179 Alt/m")
   *    Lower: Vertical Speed ("▲ 6.8 m/s")
   */
  _drawMiddleRightAltAndVSI(ctx, rightX, topY, altM, vsiMs, scale) {
    const dW = 18 * scale;
    const dH = 32 * scale;
    const thick = 3.1 * scale;
    const gap = 6 * scale;
    const unitColW = 30 * scale;

    // --- Upper Row: Altitude ---
    const altStr = String(altM);
    const altNumW = this._measureSevenSegmentString(altStr, dW, thick, gap);
    const altStartX = rightX - unitColW - altNumW;

    this._drawSevenSegmentString(ctx, altStr, altStartX, topY, dW, dH, thick, gap);

    // Stacked "Alt" / "m" label on the right of the altitude digits
    const unitCenterX = rightX - unitColW * 0.42;
    this._drawOutlinedText(ctx, 'Alt', unitCenterX, topY + 14 * scale, 14 * scale, 'center');
    this._drawOutlinedText(ctx, 'm', unitCenterX, topY + 30 * scale, 14 * scale, 'center');

    // --- Lower Row: Vertical Speed ---
    const vsiY = topY + dH + 14 * scale;
    const vsiStr = Math.abs(vsiMs).toFixed(1);
    const vsiNumW = this._measureSevenSegmentString(vsiStr, dW, thick, gap);
    const vsiStartX = rightX - unitColW - vsiNumW;

    this._drawSevenSegmentString(ctx, vsiStr, vsiStartX, vsiY, dW, dH, thick, gap);

    // Double stacked vertical speed chevron arrows (▲ over ▲ or ▼ over ▼) to the left of VSI digits
    const arrowCenterX = vsiStartX - 13 * scale;
    const isClimbing = vsiMs >= -0.05;
    this._drawDoubleVSIArrow(ctx, arrowCenterX, vsiY + dH * 0.5, isClimbing, scale);

    // Stacked fractional "m / s" on the right of VSI digits
    this._drawOutlinedText(ctx, 'm', unitCenterX, vsiY + 13 * scale, 14 * scale, 'center');
    this._drawOutlinedRect(ctx, unitCenterX - 7 * scale, vsiY + 16.5 * scale, 14 * scale, 2.0 * scale, 1.2 * scale);
    this._drawOutlinedText(ctx, 's', unitCenterX, vsiY + 31 * scale, 14 * scale, 'center');
  }

  _drawDoubleVSIArrow(ctx, cx, midY, isUp, scale) {
    const drawTriangle = (ty, dir) => {
      const hw = 7.5 * scale;
      const hh = 5.5 * scale;
      ctx.save();
      ctx.beginPath();
      if (dir > 0) {
        // Pointing UP (▲)
        ctx.moveTo(cx, ty - hh);
        ctx.lineTo(cx + hw, ty + hh);
        ctx.lineTo(cx - hw, ty + hh);
      } else {
        // Pointing DOWN (▼)
        ctx.moveTo(cx, ty + hh);
        ctx.lineTo(cx + hw, ty - hh);
        ctx.lineTo(cx - hw, ty - hh);
      }
      ctx.closePath();
      ctx.strokeStyle = '#000000';
      ctx.lineWidth = 3.2 * scale;
      ctx.lineJoin = 'miter';
      ctx.stroke();
      ctx.fillStyle = '#FFFFFF';
      ctx.fill();
      ctx.restore();
    };

    const dir = isUp ? 1 : -1;
    drawTriangle(midY - 7.5 * scale, dir);
    drawTriangle(midY + 7.5 * scale, dir);
  }

  /**
   * 6. Bottom-Left (Stacked):
   *    Upper: Flight Mode "F B W A"
   *    Lower: Stacked "Air / spd" + 7-segment speed ("130") + fractional "km / h"
   */
  _drawBottomLeftModeAndAirspeed(ctx, leftX, bottomY, speedKmh, scale) {
    const dW = 19 * scale;
    const dH = 34 * scale;
    const thick = 3.2 * scale;
    const gap = 6 * scale;

    const speedTopY = bottomY - dH;

    // Upper line: Spaced uppercase "F B W A"
    this._drawOutlinedText(
      ctx,
      'F B W A',
      leftX + 36 * scale,
      speedTopY - 14 * scale,
      21 * scale,
      'left'
    );

    // Lower line left: Stacked "Air" over "spd"
    this._drawOutlinedText(ctx, 'Air', leftX, speedTopY + 14 * scale, 15 * scale, 'left');
    this._drawOutlinedText(ctx, 'spd', leftX, speedTopY + 31 * scale, 15 * scale, 'left');

    // Lower line center: 7-segment Airspeed digits ("130")
    const numStartX = leftX + 64 * scale;
    const spdStr = String(speedKmh);
    const numW = this._drawSevenSegmentString(ctx, spdStr, numStartX, speedTopY, dW, dH, thick, gap);

    // Lower line right: Stacked fractional "km / h"
    const unitX = numStartX + numW + 14 * scale;
    this._drawOutlinedText(ctx, 'km', unitX, speedTopY + 13 * scale, 14 * scale, 'center');
    this._drawOutlinedRect(ctx, unitX - 9 * scale, speedTopY + 16.5 * scale, 18 * scale, 2.0 * scale, 1.2 * scale);
    this._drawOutlinedText(ctx, 'h', unitX, speedTopY + 31 * scale, 14 * scale, 'center');
  }

  /**
   * 7. Bottom-Right: Throttle Percentage ("66 %")
   */
  _drawBottomRightThrottle(ctx, rightX, bottomY, throttlePct, scale) {
    const dW = 19 * scale;
    const dH = 34 * scale;
    const thick = 3.2 * scale;
    const gap = 6 * scale;

    const topY = bottomY - dH;
    const thrStr = String(clamp(throttlePct, 0, 100));
    const pctWidth = 22 * scale;
    const numW = this._measureSevenSegmentString(thrStr, dW, thick, gap);
    const numStartX = rightX - pctWidth - numW;

    this._drawSevenSegmentString(ctx, thrStr, numStartX, topY, dW, dH, thick, gap);
    this._drawOutlinedText(ctx, '%', rightX, bottomY - 3 * scale, 19 * scale, 'right');
  }
}
