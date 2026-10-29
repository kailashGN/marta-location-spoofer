/* Tiny spring animator in Apple's (dampingRatio, response) parameterisation.
 * Interruptible: retargeting keeps the current value AND velocity, so a sheet grabbed mid-flight
 * never jumps or hits a "brick wall". Honours prefers-reduced-motion by settling instantly.
 * Author: kailash-hubspire
 */
(function (global) {
  'use strict';

  const reduceMotion = () => global.matchMedia && global.matchMedia('(prefers-reduced-motion: reduce)').matches;

  class Spring {
    /**
     * @param {object} o
     * @param {number} [o.value=0]         initial value
     * @param {number} [o.damping=1]       damping ratio (1 = critically damped, <1 overshoots)
     * @param {number} [o.response=0.35]   seconds — roughly the time to reach the target
     * @param {(v:number)=>void} o.onUpdate
     * @param {()=>void} [o.onRest]
     */
    constructor(o) {
      this.value = o.value ?? 0;
      this.target = this.value;
      this.velocity = 0;
      this.damping = o.damping ?? 1;
      this.response = o.response ?? 0.35;
      this.onUpdate = o.onUpdate;
      this.onRest = o.onRest;
      this._raf = 0;
      this._last = 0;
      this.restDelta = o.restDelta ?? 0.05;
      this.restSpeed = o.restSpeed ?? 0.5;
    }

    /** Snap to a value without animating (e.g. while the finger is down — 1:1 tracking). */
    set(v) {
      this.stop();
      this.value = this.target = v;
      this.velocity = 0;
      this.onUpdate(v);
    }

    /** Animate to a target, starting from the *presentation* value with optional initial velocity. */
    to(target, { velocity, damping, response } = {}) {
      this.target = target;
      if (velocity !== undefined) this.velocity = velocity;
      if (damping !== undefined) this.damping = damping;
      if (response !== undefined) this.response = response;
      if (reduceMotion()) { this.set(target); this.onRest && this.onRest(); return; }
      if (!this._raf) {
        this._last = performance.now();
        this._raf = requestAnimationFrame((t) => this._tick(t));
      }
    }

    stop() {
      if (this._raf) cancelAnimationFrame(this._raf);
      this._raf = 0;
    }

    get animating() { return this._raf !== 0; }

    _tick(now) {
      let dt = Math.min(0.064, (now - this._last) / 1000);
      this._last = now;
      // Apple's mapping: response → angular frequency; damping ratio → damping coefficient.
      const omega = (2 * Math.PI) / Math.max(0.01, this.response);
      const k = omega * omega;                 // stiffness (mass = 1)
      const c = 2 * this.damping * omega;      // damping
      // Semi-implicit Euler in small sub-steps keeps stiff springs stable.
      const steps = Math.max(1, Math.ceil(dt / 0.008));
      const h = dt / steps;
      for (let i = 0; i < steps; i++) {
        const a = -k * (this.value - this.target) - c * this.velocity;
        this.velocity += a * h;
        this.value += this.velocity * h;
      }
      const done = Math.abs(this.value - this.target) < this.restDelta && Math.abs(this.velocity) < this.restSpeed;
      if (done) {
        this.value = this.target; this.velocity = 0; this._raf = 0;
        this.onUpdate(this.value);
        this.onRest && this.onRest();
        return;
      }
      this.onUpdate(this.value);
      this._raf = requestAnimationFrame((t) => this._tick(t));
    }
  }

  /** Apple's momentum projection (Designing Fluid Interfaces). velocity in px/s. */
  function project(velocity, decelerationRate = 0.998) {
    return (velocity / 1000) * decelerationRate / (1 - decelerationRate);
  }

  /** Progressive resistance past a boundary. */
  function rubberband(overshoot, dimension, constant = 0.55) {
    return (overshoot * dimension * constant) / (dimension + constant * Math.abs(overshoot));
  }

  /** Velocity tracker: keep the last ~100 ms of pointer samples. */
  class VelocityTracker {
    constructor() { this.samples = []; }
    reset() { this.samples.length = 0; }
    push(v, t = performance.now()) {
      this.samples.push({ v, t });
      while (this.samples.length && t - this.samples[0].t > 100) this.samples.shift();
    }
    /** px/s */
    get velocity() {
      if (this.samples.length < 2) return 0;
      const a = this.samples[0], b = this.samples[this.samples.length - 1];
      const dt = (b.t - a.t) / 1000;
      return dt > 0 ? (b.v - a.v) / dt : 0;
    }
  }

  global.Spring = Spring;
  global.SpringUtil = { project, rubberband, VelocityTracker, reduceMotion };
})(window);
