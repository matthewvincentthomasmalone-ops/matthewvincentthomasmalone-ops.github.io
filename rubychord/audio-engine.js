import { INTERVALS, strumNotes } from "./omnichord-controls.js";
import { synthVoice, synthDrum } from "./fallback-synth.js";

export class SampleEngine {
  constructor(report = () => {}) {
    this.report = report;
    this.ctx = null;
    this.buffers = new Map();
    this.voices = new Set();
    this.chordVoices = [];
    this.midiVoices = new Map();
    this.samples = [];
    this.powered = false;
    this.generation = 0;
    this.chord = null;
    this.chordActive = false;
    this.rhythmTimer = null;
    this.step = 0;
    this.ready = null;
    this.settings = {
      master: 0.65,
      chord: 0.5,
      strum: 0.65,
      sub: 0.35,
      rhythm: 0.4,
      sustain: 1,
      tempo: 112,
      voice: "omni1",
      pattern: "rock1",
      auto: false,
      hold: false,
      sync: true,
      keyboard: false,
    };
  }
  async power(on) {
    this.powered = on;
    if (!on) {
      this.stopAll();
      if (this.ctx) await this.ctx.suspend();
      return;
    }
    if (!this.ctx) this.buildGraph();
    await this.ctx.resume();
    if (!this.ready) this.ready = this.load();
    await this.ready;
  }
  buildGraph() {
    this.ctx = new (window.AudioContext || window.webkitAudioContext)({
      latencyHint: "interactive",
    });
    const c = this.ctx;
    this.master = c.createGain();
    this.drive = c.createWaveShaper();
    this.limiter = c.createDynamicsCompressor();
    Object.assign(this.limiter.threshold, { value: -2 });
    this.limiter.knee.value = 2;
    this.limiter.ratio.value = 20;
    this.limiter.attack.value = 0.001;
    this.limiter.release.value = 0.08;
    this.buses = {};
    for (const name of ["chord", "strum", "sub", "rhythm"]) {
      const g = c.createGain();
      g.connect(this.master);
      this.buses[name] = g;
    }
    this.master.connect(this.drive);
    this.drive.connect(this.limiter);
    this.limiter.connect(c.destination);
    this.update({});
  }
  update(settings) {
    Object.assign(this.settings, settings);
    if (!this.ctx) return;
    const t = this.ctx.currentTime,
      s = this.settings;
    this.master.gain.setTargetAtTime(s.master, t, 0.01);
    for (const name of Object.keys(this.buses))
      this.buses[name].gain.setTargetAtTime(s[name] * 0.65, t, 0.01);
    // Unity slope at ordinary levels; only the highest master range adds mild compression.
    const amount = Math.max(0, (s.master - 0.75) / 0.25) * 0.25;
    if (this.driveAmount !== amount) {
      this.driveAmount = amount;
      this.drive.curve =
        amount === 0
          ? null
          : Float32Array.from({ length: 2049 }, (_, i) => {
              const x = i / 1024 - 1;
              return Math.tanh(x * amount) / amount;
            });
    }
  }
  async load() {
    this.report("Loading local Omni-84 2.1.0 recordings…");
    let failed = 0;
    try {
      const response = await fetch("sample-manifest.json");
      if (!response.ok) throw Error("manifest unavailable");
      this.samples = (await response.json()).samples;
      let cursor = 0,
        done = 0;
      const worker = async () => {
        while (cursor < this.samples.length) {
          const entry = this.samples[cursor++];
          try {
            const r = await fetch(
              entry.source.split("/").map(encodeURIComponent).join("/"),
            );
            if (!r.ok) throw Error("missing sample");
            const buffer = await this.ctx.decodeAudioData(
              await r.arrayBuffer(),
            );
            if (entry.loopStart !== undefined) this.prepareLoop(buffer, entry);
            this.buffers.set(entry.source, buffer);
          } catch {
            failed++;
          }
          done++;
          if (done % 30 === 0)
            this.report(`Loading Omni-84: ${done}/${this.samples.length}`);
        }
      };
      await Promise.all(Array.from({ length: 6 }, worker));
    } catch {
      failed++;
    }
    this.report(
      this.buffers.size
        ? `Omni-84 2.1.0 · ${this.buffers.size} recordings ready${failed ? " · missing sounds use fallback" : ""}`
        : "Local samples unavailable · temporary synthesized fallback",
    );
    this.loadResult = { loaded: this.buffers.size, failed };
  }
  prepareLoop(buffer, entry) {
    // Blend the tail into the pre-loop segment. At the wrap both value and phase follow the source.
    const start = Math.round(entry.loopStart * buffer.sampleRate),
      end = Math.round(entry.loopEnd * buffer.sampleRate);
    const count = Math.min(
      start,
      Math.round(entry.crossfade * buffer.sampleRate),
      end - start,
    );
    for (let c = 0; c < buffer.numberOfChannels; c++) {
      const d = buffer.getChannelData(c);
      for (let i = 0; i < count; i++) {
        const mix = (i + 1) / count;
        d[end - count + i] =
          d[end - count + i] * (1 - mix) + d[start - count + i] * mix;
      }
    }
  }
  async ensure() {
    if (!this.powered) return false;
    if (this.ready) await this.ready;
    return this.powered;
  }
  find(group, midi) {
    const available = this.samples.filter(
      (s) => s.group === group && this.buffers.has(s.source),
    );
    return available.reduce(
      (best, s) =>
        !best || Math.abs(s.rootMidi - midi) < Math.abs(best.rootMidi - midi)
          ? s
          : best,
      null,
    );
  }
  track(voice, role) {
    voice.role = role;
    this.voices.add(voice);
    let remaining = voice.sources.length;
    voice.sources.forEach(
      (source) =>
        (source.onended = () => {
          source.disconnect();
          if (--remaining === 0) {
            voice.gain.disconnect();
            voice.extra?.forEach((n) => n.disconnect());
            this.voices.delete(voice);
            this.chordVoices = this.chordVoices.filter((v) => v !== voice);
          }
        }),
    );
    return voice;
  }
  play(
    entry,
    bus,
    velocity = 1,
    when = this.ctx.currentTime,
    { midi, loop = false, duration } = {},
  ) {
    if (!entry || !this.buffers.has(entry.source)) return null;
    const source = this.ctx.createBufferSource(),
      gain = this.ctx.createGain();
    source.buffer = this.buffers.get(entry.source);
    source.playbackRate.value =
      midi === undefined ? 1 : 2 ** ((midi - entry.rootMidi) / 12);
    source.detune.value = entry.tuningCents;
    source.loop = loop && entry.loopStart !== undefined;
    if (source.loop) {
      source.loopStart = entry.loopStart;
      source.loopEnd = entry.loopEnd;
    }
    source.connect(gain);
    gain.connect(this.buses[bus]);
    gain.gain.setValueAtTime(0, when);
    gain.gain.linearRampToValueAtTime(velocity * entry.gain, when + 0.002);
    const voice = this.track({ gain, sources: [source] }, bus);
    source.start(when);
    if (duration !== undefined) {
      const end = when + duration;
      gain.gain.setTargetAtTime(
        0.00001,
        Math.max(when + 0.01, end - 0.08),
        0.025,
      );
      source.stop(end + 0.03);
    }
    return voice;
  }
  note(
    midi,
    bus = "strum",
    velocity = 0.7,
    sustained = false,
    when = this.ctx.currentTime,
    group = "strings1",
  ) {
    const entry = this.find(group, midi);
    const duration = sustained
      ? undefined
      : 0.12 + this.settings.sustain * 2.88;
    // Outside a bank, limit transposition to an octave; never stretch one sample across the keyboard.
    if (entry && Math.abs(entry.rootMidi - midi) <= 12)
      return this.play(entry, bus, velocity, when, {
        midi,
        loop: sustained,
        duration,
      });
    return this.track(
      synthVoice(
        this.ctx,
        midi,
        this.buses[bus],
        velocity,
        when,
        sustained ? Infinity : duration,
        this.settings.voice,
      ),
      bus,
    );
  }
  release(voice, seconds = 0.025) {
    if (!voice || !this.ctx || voice.released) return;
    voice.released = true;
    const now = this.ctx.currentTime,
      param = voice.gain.gain;
    if (param.cancelAndHoldAtTime) param.cancelAndHoldAtTime(now);
    else {
      param.cancelScheduledValues(now);
      param.setValueAtTime(param.value, now);
    }
    param.setTargetAtTime(0, now, seconds / 4);
    voice.sources.forEach((s) => {
      try {
        s.stop(now + seconds);
      } catch {}
    });
  }
  stopChord() {
    this.chordVoices.forEach((v) => this.release(v));
    this.chordVoices = [];
  }
  chordLayer(when = this.ctx.currentTime, short = false) {
    if (!this.chord || !this.chordActive) return;
    const { root, quality } = this.chord;
    const entry = this.samples.find(
      (s) => s.role === "chords" && s.rootPC === root && s.quality === quality,
    );
    const voice = this.play(entry, "chord", 0.75, when, {
      loop: !short,
      duration: short ? 0.2 : undefined,
    });
    if (voice) this.chordVoices.push(voice);
    else
      this.chordVoices.push(
        ...INTERVALS[quality].map((n) =>
          this.note(
            48 + ((root + n) % 12),
            "chord",
            0.35,
            !short,
            when,
            "keyboard",
          ),
        ),
      );
  }
  async selectChord(chord) {
    const token = ++this.generation;
    this.chord = chord;
    this.chordActive = true;
    if (!(await this.ensure()) || token !== this.generation) return;
    this.stopChord();
    if (!this.settings.auto) this.chordLayer();
    if (this.settings.sync && !this.rhythmTimer) this.startRhythm();
  }
  releaseChord() {
    if (this.settings.hold) return;
    this.chordActive = false;
    this.generation++;
    for (const voice of this.voices)
      if (voice.role === "chord") this.release(voice);
    this.stopChord();
    if (this.settings.sync) this.stopRhythm();
  }
  async strum(index) {
    const token = this.generation;
    if (!(await this.ensure()) || token !== this.generation || !this.chord)
      return;
    if (!Number.isInteger(index) || index < 0 || index > 12) return;
    const midi = strumNotes(this.chord.root, this.chord.quality)[index],
      s = this.settings;
    if (s.voice === "omni1" || s.voice === "omni2") {
      this.note(midi, "strum", 0.75, false, this.ctx.currentTime, "strings2");
      this.note(
        midi,
        "sub",
        0.65,
        false,
        this.ctx.currentTime,
        s.voice === "omni1" ? "strings1" : "keyboard",
      );
    } else {
      this.track(
        synthVoice(
          this.ctx,
          midi,
          this.buses.strum,
          0.75,
          this.ctx.currentTime,
          0.15 + s.sustain * 2.85,
          s.voice,
        ),
        "strum",
      );
      this.note(midi, "sub", 0.35, false, this.ctx.currentTime, "keyboard");
    }
  }
  async midiNoteOn(midi, velocity = 1) {
    if (
      !Number.isFinite(midi) ||
      midi < 0 ||
      midi > 127 ||
      !Number.isFinite(velocity)
    )
      return;
    const token = this.generation;
    this.midiNoteOff(midi);
    const pending = {};
    this.midiVoices.set(midi, pending);
    if (
      !(await this.ensure()) ||
      token !== this.generation ||
      this.midiVoices.get(midi) !== pending
    )
      return;
    this.midiVoices.set(
      midi,
      this.note(
        midi,
        "strum",
        Math.max(0, Math.min(1, velocity)),
        true,
        this.ctx.currentTime,
        "keyboard",
      ),
    );
  }
  midiNoteOff(midi) {
    const v = this.midiVoices.get(midi);
    if (v?.gain) this.release(v, 0.08);
    this.midiVoices.delete(midi);
  }
  drum(kind, when, velocity = 0.8) {
    const candidates = this.samples.filter(
      (s) => s.drum === kind && this.buffers.has(s.source),
    );
    const entry = candidates[0]; // Preserve the fixed hardware hit rather than normalize variants.
    if (!this.play(entry, "rhythm", velocity, when))
      this.track(
        synthDrum(this.ctx, kind, this.buses.rhythm, when, velocity),
        "rhythm",
      );
  }
  pattern() {
    const patterns = {
      rock1: {
        kick: [0, 8],
        snare: [4, 12],
        hihat: [0, 2, 4, 6, 8, 10, 12, 14],
      },
      rock2: {
        kick: [0, 6, 8, 11],
        snare: [4, 12],
        hihat: [0, 2, 4, 6, 8, 10, 12, 14],
      },
      "slow rock": {
        length: 12,
        division: 6,
        kick: [0, 6],
        snare: [3, 9],
        hihat: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
      },
      country: {
        kick: [0, 8],
        snare: [4, 12],
        hihat: [0, 2, 4, 6, 8, 10, 12, 14],
        clave: [6, 14],
      },
      swing: {
        length: 12,
        division: 3,
        kick: [0, 6],
        snare: [3, 9],
        hihat: [0, 2, 3, 5, 6, 8, 9, 11],
      },
      disco: { kick: [0, 4, 8, 12], snare: [4, 12], hihat: [2, 6, 10, 14] },
      "hip hop": {
        kick: [0, 7, 10],
        snare: [4, 12],
        hihat: [0, 2, 4, 6, 8, 10, 12, 13, 14, 15],
      },
      funk: {
        kick: [0, 3, 6, 10],
        snare: [4, 12, 15],
        hihat: [0, 2, 4, 6, 8, 10, 12, 14],
      },
      bossanova: {
        kick: [0, 6, 8, 14],
        snare: [4, 12],
        hihat: [0, 2, 4, 6, 8, 10, 12, 14],
        clave: [0, 3, 6, 10, 12],
      },
      waltz: {
        length: 12,
        kick: [0],
        snare: [4, 8],
        hihat: [0, 2, 4, 6, 8, 10],
      },
    };
    return patterns[this.settings.pattern] || patterns.rock1;
  }
  startRhythm() {
    if (this.rhythmTimer || !this.powered) return;
    this.step = 0;
    this.nextTime = this.ctx.currentTime + 0.015;
    this.rhythmTimer = setInterval(() => this.schedule(), 25);
    this.schedule();
  }
  schedule() {
    const pattern = this.pattern();
    if (this.nextTime < this.ctx.currentTime - 0.2)
      this.nextTime = this.ctx.currentTime;
    while (this.nextTime < this.ctx.currentTime + 0.08) {
      const step = this.step % (pattern.length || 16),
        when = this.nextTime;
      for (const kind of ["kick", "snare", "hihat", "clave"])
        if (pattern[kind]?.includes(step))
          this.drum(kind, when, kind === "hihat" ? 0.5 : 0.8);
      if (this.settings.auto && this.chord && this.chordActive) {
        const beat = pattern.division || 4;
        if (step % beat === 0) {
          let midi =
            36 + this.chord.root + (Math.floor(step / beat) % 2 ? 7 : 0);
          while (midi > 54) midi -= 12;
          this.note(midi, "chord", 0.7, false, when, "bass");
        }
        if (step % beat === Math.floor(beat / 2)) this.chordLayer(when, true);
      }
      this.nextTime += 60 / this.settings.tempo / (pattern.division || 4);
      this.step++;
    }
  }
  stopRhythm() {
    clearInterval(this.rhythmTimer);
    this.rhythmTimer = null;
    for (const v of this.voices)
      if (v.role === "rhythm" || (this.settings.auto && v.role === "chord"))
        this.release(v);
  }
  stopAll() {
    this.generation++;
    this.stopRhythm();
    for (const v of this.voices) this.release(v);
    this.chordVoices = [];
    this.midiVoices.clear();
    this.chord = null;
    this.chordActive = false;
  }
}
