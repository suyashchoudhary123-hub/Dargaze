export class Ambience {
  private context: AudioContext | null = null;
  private master: GainNode | null = null;
  private rumbleGain: GainNode | null = null;
  private windGain: GainNode | null = null;
  private heartbeatTimer = 0;
  private heartbeatLevel = 0;
  private muted = false;
  private started = false;

  start(): void {
    if (this.started) { void this.context?.resume(); return; }
    const AudioContextCtor = window.AudioContext;
    if (!AudioContextCtor) return;
    this.started = true;
    this.context = new AudioContextCtor();
    const context = this.context;
    this.master = context.createGain(); this.master.gain.value = this.muted ? 0 : 0.22; this.master.connect(context.destination);

    const rumble = context.createOscillator(); rumble.type = 'sine'; rumble.frequency.value = 41;
    const rumbleFilter = context.createBiquadFilter(); rumbleFilter.type = 'lowpass'; rumbleFilter.frequency.value = 110;
    this.rumbleGain = context.createGain(); this.rumbleGain.gain.value = 0.14;
    rumble.connect(rumbleFilter); rumbleFilter.connect(this.rumbleGain); this.rumbleGain.connect(this.master); rumble.start();

    const buffer = context.createBuffer(1, context.sampleRate * 2, context.sampleRate);
    const channel = buffer.getChannelData(0);
    for (let i = 0; i < channel.length; i++) channel[i] = (Math.random() * 2 - 1) * (0.4 + Math.sin(i / 2600) * 0.2);
    const noise = context.createBufferSource(); noise.buffer = buffer; noise.loop = true;
    const windFilter = context.createBiquadFilter(); windFilter.type = 'lowpass'; windFilter.frequency.value = 520;
    this.windGain = context.createGain(); this.windGain.gain.value = 0.09;
    noise.connect(windFilter); windFilter.connect(this.windGain); this.windGain.connect(this.master); noise.start();
    void context.resume();
  }

  setMuted(value: boolean): void {
    this.muted = value;
    if (this.master && this.context) this.master.gain.setTargetAtTime(value ? 0 : 0.22, this.context.currentTime, 0.15);
  }
  get isMuted(): boolean { return this.muted; }

  /** Slow the breath and add a heartbeat while the party is close to the Black Shadow. */
  setEnemyProximity(distance: number): void {
    if (!this.context || !this.master || !this.rumbleGain || !this.windGain || this.muted) return;
    const intensity = Math.max(0, Math.min(1, (14 - distance) / 14));
    const now = this.context.currentTime;
    this.rumbleGain.gain.setTargetAtTime(0.1 + intensity * 0.24, now, 0.4);
    this.windGain.gain.setTargetAtTime(0.07 + intensity * 0.05, now, 0.6);
    if (intensity > 0.08) {
      this.heartbeatLevel = intensity;
      if (!this.heartbeatTimer) this.heartbeatTimer = window.setInterval(() => this.beat(), Math.max(450, 880 - this.heartbeatLevel * 300));
    } else if (this.heartbeatTimer) { window.clearInterval(this.heartbeatTimer); this.heartbeatTimer = 0; }
  }

  private beat(): void {
    if (!this.context || !this.master || this.muted) return;
    const context = this.context; const now = context.currentTime;
    for (const offset of [0, 0.16]) {
      const oscillator = context.createOscillator(); const gain = context.createGain();
      oscillator.type = 'sine'; oscillator.frequency.setValueAtTime(offset === 0 ? 58 : 48, now + offset);
      gain.gain.setValueAtTime(0.0001, now + offset); gain.gain.exponentialRampToValueAtTime(0.055 * this.heartbeatLevel, now + offset + 0.035); gain.gain.exponentialRampToValueAtTime(0.0001, now + offset + 0.22);
      oscillator.connect(gain); gain.connect(this.master); oscillator.start(now + offset); oscillator.stop(now + offset + 0.24);
    }
  }

  dispose(): void {
    if (this.heartbeatTimer) window.clearInterval(this.heartbeatTimer);
    void this.context?.close(); this.context = null; this.started = false;
  }
}
