/** Presentation budgets only. Never use these values to change the simulation. */
export type QualityLevel = 'low' | 'balanced' | 'high';
export type QualityPreference = 'auto' | QualityLevel;

export const QUALITY_BUDGETS = {
  low: { dpr: 1, pixels: 900_000, particles: 100 },
  balanced: { dpr: 1.5, pixels: 1_800_000, particles: 240 },
  high: { dpr: 2, pixels: 3_200_000, particles: 600 },
} as const;

/** Sustained load drops quality quickly; eight healthy seconds permit a probe
 * upward even on a 60Hz screen. A failed probe backs off to prevent cycling. */
export class QualityGovernor {
  level: QualityLevel;
  private samples: number[] = [];
  private head = 0;
  private slow = 0;
  private healthy = 0;
  private sinceChange = 3000;
  private recoveryMs = 8000;
  private probing = false;

  constructor(initial: QualityLevel = 'high') { this.level = initial; }

  resetSamples(): void {
    this.samples.length = 0; this.head = 0; this.slow = 0; this.healthy = 0;
    this.sinceChange = 0;
  }

  sample(ms: number): boolean {
    if (!(ms > 0) || !Number.isFinite(ms) || ms > 250) {
      this.resetSamples();
      return false;
    }
    this.sinceChange += ms;
    this.healthy = ms <= 19 ? this.healthy + ms : Math.max(0, this.healthy - ms * 4);
    if (this.samples.length === 90) {
      if (this.samples[this.head] > 22) this.slow--;
    }
    this.samples[this.head] = ms;
    if (ms > 22) this.slow++;
    this.head = (this.head + 1) % 90;
    if (this.samples.length < 90 || this.sinceChange < 3000) return false;
    if (this.slow >= 18 && this.level !== 'low') {
      this.level = this.level === 'high' ? 'balanced' : 'low';
      if (this.probing) this.recoveryMs = Math.min(120_000, this.recoveryMs * 2);
      this.probing = false;
    } else if (this.healthy >= this.recoveryMs && this.level !== 'high') {
      this.level = this.level === 'low' ? 'balanced' : 'high';
      this.probing = true;
    } else return false;
    this.resetSamples();
    return true;
  }
}
