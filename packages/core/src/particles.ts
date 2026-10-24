import { PARTICLE_FIELDS, resolveFields, type ParticleSpec } from "./components.ts";

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  gravity: number;
  life: number;
  maxLife: number;
  size: number;
  color: string;
}

/**
 * Visual-only particles. They use their own seeded random numbers so the
 * same run always looks the same, and they never touch the simulation.
 */
export class ParticleSystem {
  private particles: Particle[] = [];
  private seed: number;

  constructor(seed = 1) {
    this.seed = seed;
  }

  get count(): number {
    return this.particles.length;
  }

  clear(): void {
    this.particles = [];
  }

  /** Emits `count` particles (or `spec.count`) at a point. `spec` may be raw scene JSON; defaults fill the gaps. */
  burst(x: number, y: number, raw: Record<string, unknown>, count?: number): void {
    const spec = resolveFields<ParticleSpec>(PARTICLE_FIELDS, raw);
    const n = count ?? spec.count;
    for (let i = 0; i < n; i++) {
      const angle = ((spec.direction + (this.random() - 0.5) * spec.spread) * Math.PI) / 180;
      const speed = spec.speed * (0.5 + this.random() * 0.5);
      this.particles.push({
        x,
        y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        gravity: spec.gravity,
        life: spec.life,
        maxLife: spec.life,
        size: spec.size,
        color: spec.color,
      });
    }
  }

  update(dt: number): void {
    for (const p of this.particles) {
      p.vy += p.gravity * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.life -= dt;
    }
    this.particles = this.particles.filter((p) => p.life > 0);
  }

  draw(ctx: CanvasRenderingContext2D): void {
    for (const p of this.particles) {
      const t = p.maxLife > 0 ? p.life / p.maxLife : 0;
      const size = Math.max(0.5, p.size * t);
      ctx.globalAlpha = Math.min(1, t * 1.5);
      ctx.fillStyle = p.color;
      ctx.fillRect(p.x - size / 2, p.y - size / 2, size, size);
    }
    ctx.globalAlpha = 1;
  }

  /** mulberry32 */
  random(): number {
    this.seed = (this.seed + 0x6d2b79f5) | 0;
    let t = this.seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
}
