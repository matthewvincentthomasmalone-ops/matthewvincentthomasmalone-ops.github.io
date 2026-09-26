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
    this.powerGeneration = 0;
    this.rhythmGeneration = 0;
    this.chord = null;
    this.chordActive = false;
    this.rhythmTimer = null;
    this.step = 0;
    this.ready = null;
    this.loadingAll = null;
    this.pendingSamples = new Map();
    this.failedSamples = new Set();
    this.playable = false;
    this.chordReady = null;
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
      sync: false,
      keyboard: false,
    };
  }
  async power(on) {
    this.powered = on;
    this.powerGeneration++;
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
    this.report("Loading the first Omni-84 sounds…", { phase: "loading" });
    try {
      const response = await fetch("sample-manifest.json?v=20260926-cream");
      if (!response.ok) throw Error("manifest unavailable");
      this.samples = (await response.json()).samples;
      const essential = this.chordEntries({ root: 0, quality: "major" });
      this.startupCount = essential.length;
      await this.loadEntries(essential, 4);
      this.playable = true;
      this.loadResult.essential = this.buffers.size;
      this.report(
        this.buffers.size
          ? "Omni-84 ready to play · other sounds load in the background"
          : "Samples unavailable · temporary synthesized fallback",
        { phase: "ready" },
      );
      // Ready resolves as soon as the first chord, strings, bass and drum hits are usable.
      this.loadingAll = this.loadEntries(this.samples, 2).then(() => {
        this.report(
          `Omni-84 2.1.0 · ${this.buffers.size} recordings ready${this.failedSamples.size ? " · missing sounds use fallback" : ""}`,
          { phase: "background" },
        );
      });
    } catch {
      this.playable = true;
      this.loadResult = { loaded: 0, failed: 1, essential: 0 };
      this.loadingAll = Promise.resolve();
      this.report("Samples unavailable · temporary synthesized fallback", {
        phase: "ready",
      });
    }
  }
  updateLoadStats() {
    this.loadResult = {
      ...this.loadResult,
      loaded: this.buffers.size,
      failed: this.failedSamples.size,
    };
    if (!this.playable && this.startupCount)
      this.report(
        `Loading the first Omni-84 sounds: ${this.buffers.size}/${this.startupCount}`,
        { phase: "loading" },
      );
  }
  async loadEntry(entry) {
    if (!entry || this.buffers.has(entry.source)) return true;
    if (this.pendingSamples.has(entry.source))
      return this.pendingSamples.get(entry.source);
    const loading = (async () => {
      const paths = [
        ...new Set([entry.deliverySource, entry.source].filter(Boolean)),
      ];
      for (const path of paths) {
        try {
          const response = await fetch(
            path.split("/").map(encodeURIComponent).join("/"),
          );
          if (!response.ok) throw Error("missing sample");
          const buffer = await this.ctx.decodeAudioData(
            await response.arrayBuffer(),
          );
          if (entry.loopStart !== undefined) this.prepareLoop(buffer, entry);
          this.buffers.set(entry.source, buffer);
          this.updateLoadStats();
          return true;
        } catch {
          /* Try the original WAV if this browser cannot decode FLAC. */
        }
      }
      this.failedSamples.add(entry.source);
      this.updateLoadStats();
      return false;
    })();
    this.pendingSamples.set(entry.source, loading);
    return loading;
  }
  async loadEntries(entries, concurrency = 4) {
    let cursor = 0;
    const worker = async () => {
      while (cursor < entries.length) {
        await this.loadEntry(entries[cursor++]);
      }
    };
    await Promise.all(Array.from({ length: concurrency }, worker));
  }
  closest(group, midi) {
    return this.samples
      .filter((s) => s.group === group)
      .reduce(
        (best, entry) =>
          !best ||
          Math.abs(entry.rootMidi - midi) < Math.abs(best.rootMidi - midi)
            ? entry
            : best,
        null,
      );
  }
  chordEntries(chord) {
    const entries = new Set();
    const add = (entry) => {
      if (entry) entries.add(entry);
    };
    const sampledChord = this.samples.find(
      (s) =>
        s.role === "chords" &&
        s.rootPC === chord.root &&
        s.quality === chord.quality,
    );
    add(sampledChord);
    if (!sampledChord)
      for (const n of INTERVALS[chord.quality])
        add(this.closest("keyboard", 48 + ((chord.root + n) % 12)));
    for (const midi of strumNotes(chord.root, chord.quality)) {
      add(this.closest("strings2", midi));
      add(
        this.closest(
          this.settings.voice === "omni2" ? "keyboard" : "strings1",
          midi,
        ),
      );
    }
    for (const kind of ["kick", "snare", "hihat", "clave"])
      add(this.samples.find((s) => s.drum === kind));
    for (const midi of [36 + chord.root, 43 + chord.root])
      add(this.closest("bass", midi));
    add(this.closest("keyboard", 60));
    return [...entries];
  }
  async warmChord(chord) {
    await this.loadEntries(this.chordEntries(chord));
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
  async triggerSyncRhythm() {
    if (!this.powered || !this.settings.sync) return;
    const token = this.powerGeneration;
    const rhythmToken = this.rhythmGeneration;
    if (await this.ensure()) {
      if (
        token === this.powerGeneration &&
        rhythmToken === this.rhythmGeneration &&
        this.settings.sync
      )
        this.startRhythm();
    }
  }
  async selectChord(chord, { triggerRhythm = true } = {}) {
    // A brief press starts drums even if its chord recording is still loading.
    if (triggerRhythm) this.triggerSyncRhythm();
    const token = ++this.generation;
    this.chord = chord;
    this.chordActive = true;
    this.chordReady = (async () => {
      if (!(await this.ensure())) return false;
      await this.warmChord(chord);
      return this.powered;
    })();
    if (!(await this.chordReady) || token !== this.generation) return;
    this.stopChord();
    if (!this.settings.auto) this.chordLayer();
  }
  releaseChord() {
    if (this.settings.hold) return;
    this.chordActive = false;
    this.generation++;
    for (const voice of this.voices)
      if (voice.role === "chord") this.release(voice);
    this.stopChord();
  }
  async strum(index) {
    const token = this.generation;
    if (!(await this.ensure())) return;
    if (this.chordReady) await this.chordReady;
    if (token !== this.generation || !this.chord || !this.powered) return;
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
    this.triggerSyncRhythm();
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
    await this.loadEntry(this.closest("keyboard", midi));
    if (
      !this.powered ||
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
    this.report("Rhythm playing", { phase: "rhythm", playing: true });
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
    this.rhythmGeneration++;
    clearInterval(this.rhythmTimer);
    this.rhythmTimer = null;
    for (const v of this.voices)
      if (v.role === "rhythm" || (this.settings.auto && v.role === "chord"))
        this.release(v);
    this.report("Rhythm stopped", { phase: "rhythm", playing: false });
  }
  stopAll() {
    this.stopRhythm();
    this.stopNotes();
  }
  stopNotes() {
    this.generation++;
    for (const v of this.voices) if (v.role !== "rhythm") this.release(v);
    this.chordVoices = [];
    this.midiVoices.clear();
    this.chord = null;
    this.chordActive = false;
  }
}
