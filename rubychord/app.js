(() => {
  "use strict";

  const ROOTS = ["C", "C#", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"];
  const ROOT_MIDI = { C: 60, "C#": 61, D: 62, Eb: 63, E: 64, F: 65, "F#": 66, G: 67, Ab: 68, A: 69, Bb: 70, B: 71 };
  const KEY_ROOTS = ["Eb", "Bb", "F", "C", "G", "D", "A", "E", "B"];
  const KEY_ROWS = ["qwertyuio", "asdfghjkl", "zxcvbnm,."];
  const QUALITIES = ["major", "minor", "seventh"];
  const SUFFIX = { major: "", minor: "m", seventh: "7" };
  const INTERVALS = { major: [0, 4, 7], minor: [0, 3, 7], seventh: [0, 4, 7, 10] };
  const STRUM_KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "0", "-", "="];

  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => [...document.querySelectorAll(selector)];
  const ui = {
    grid: $("#chordGrid"), strumplate: $("#strumplate"), status: $("#statusText"), light: $("#powerLight"),
    rhythmStart: $("#rhythmStart"), chordHold: $("#chordHold"), autoBass: $("#autoBass"), midiButton: $("#midiButton"),
    midiStatus: $("#midiStatus"), pattern: $("#pattern"), voice: $("#voice"), serialButton: $("#serialButton")
  };

  class RubyEngine {
    constructor() {
      this.context = null;
      this.master = null;
      this.filter = null;
      this.drive = null;
      this.chordBus = null;
      this.strumBus = null;
      this.rhythmBus = null;
      this.activeChord = null;
      this.chordVoices = [];
      this.midiVoices = new Map();
      this.rhythmTimer = null;
      this.nextStepTime = 0;
      this.step = 0;
      this.tapTimes = [];
    }

    async ensure() {
      if (!this.context) this.buildGraph();
      if (this.context.state !== "running") await this.context.resume();
      ui.light.classList.add("on");
    }

    buildGraph() {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      this.context = new AudioCtx();
      this.master = this.context.createGain();
      this.filter = this.context.createBiquadFilter();
      this.drive = this.context.createWaveShaper();
      this.chordBus = this.context.createGain();
      this.strumBus = this.context.createGain();
      this.rhythmBus = this.context.createGain();
      const compressor = this.context.createDynamicsCompressor();
      compressor.threshold.value = -14; compressor.knee.value = 18; compressor.ratio.value = 4; compressor.attack.value = .004; compressor.release.value = .18;
      this.chordBus.connect(this.filter); this.strumBus.connect(this.filter); this.rhythmBus.connect(this.filter);
      this.filter.connect(this.drive); this.drive.connect(compressor); compressor.connect(this.master); this.master.connect(this.context.destination);
      this.updateControls();
    }

    updateControls() {
      if (!this.context) return;
      const now = this.context.currentTime;
      this.master.gain.setTargetAtTime(Number($("#master").value), now, .02);
      this.chordBus.gain.setTargetAtTime(Number($("#chord").value) * .55, now, .02);
      this.strumBus.gain.setTargetAtTime(Number($("#strum").value) * .72, now, .02);
      this.rhythmBus.gain.setTargetAtTime(Number($("#rhythm").value) * .8, now, .02);
      const tone = Number($("#tone").value);
      this.filter.type = "lowpass";
      this.filter.frequency.setTargetAtTime(700 + tone * 7600, now, .02);
      this.filter.Q.value = .55 + tone * .5;
      this.drive.curve = this.makeDriveCurve(1 + Number($("#preamp").value) * 34);
      this.drive.oversample = "4x";
    }

    makeDriveCurve(amount) {
      const points = 1024, curve = new Float32Array(points);
      for (let i = 0; i < points; i++) { const x = i * 2 / points - 1; curve[i] = ((3 + amount) * x * 20 * Math.PI / 180) / (Math.PI + amount * Math.abs(x)); }
      return curve;
    }

    frequency(midi) { return 440 * 2 ** ((midi - 69) / 12); }

    createVoice(midi, destination, velocity = .75, sustained = false, when = this.context.currentTime) {
      const voice = $("#voice").value;
      const gain = this.context.createGain();
      const partial = this.context.createGain();
      const osc1 = this.context.createOscillator();
      const osc2 = this.context.createOscillator();
      osc1.type = voice === "organ" ? "sine" : (voice === "omni2" ? "square" : "sawtooth");
      osc2.type = voice === "omni2" ? "triangle" : "sine";
      osc1.frequency.value = this.frequency(midi);
      osc2.frequency.value = this.frequency(midi + 12);
      osc2.detune.value = voice === "organ" ? 2 : -5;
      partial.gain.value = voice === "organ" ? .42 : .15;
      osc1.connect(gain); osc2.connect(partial); partial.connect(gain); gain.connect(destination);
      gain.gain.setValueAtTime(.0001, when);
      gain.gain.exponentialRampToValueAtTime(Math.max(.0002, velocity * .18), when + .014);
      osc1.start(when); osc2.start(when);
      if (!sustained) {
        const release = Number($("#sustain").value);
        gain.gain.exponentialRampToValueAtTime(.0001, when + .08 + release);
        osc1.stop(when + .12 + release); osc2.stop(when + .12 + release);
      }
      return { gain, oscillators: [osc1, osc2] };
    }

    releaseVoice(voice, release = .08) {
      if (!voice || !this.context) return;
      const now = this.context.currentTime;
      voice.gain.gain.cancelScheduledValues(now);
      voice.gain.gain.setTargetAtTime(.0001, now, release / 3);
      voice.oscillators.forEach((osc) => { try { osc.stop(now + release + .04); } catch (_) {} });
    }

    async selectChord(root, quality) {
      await this.ensure();
      this.stopChord();
      this.activeChord = { root, quality };
      const rootMidi = ROOT_MIDI[root];
      const notes = [...INTERVALS[quality], ...INTERVALS[quality].map((n) => n + 12)];
      this.chordVoices = notes.map((interval, index) => this.createVoice(rootMidi + interval, this.chordBus, .64 / Math.sqrt(notes.length), true, this.context.currentTime + index * .007));
      $$(".chord-button").forEach((button) => button.classList.toggle("active", button.dataset.root === root && button.dataset.quality === quality));
      ui.status.textContent = `${root}${SUFFIX[quality]} SELECTED`;
    }

    stopChord(clear = false) {
      this.chordVoices.forEach((voice) => this.releaseVoice(voice, .06));
      this.chordVoices = [];
      if (clear) {
        this.activeChord = null;
        $$(".chord-button.active").forEach((button) => button.classList.remove("active"));
      }
    }

    chordScale() {
      const chord = this.activeChord || { root: "C", quality: "major" };
      const intervals = INTERVALS[chord.quality];
      const notes = [];
      for (let octave = 0; notes.length < 12; octave++) intervals.forEach((n) => { if (notes.length < 12) notes.push(ROOT_MIDI[chord.root] + n + octave * 12); });
      return notes.sort((a, b) => a - b);
    }

    async strum(index) {
      await this.ensure();
      const midi = this.chordScale()[index];
      this.createVoice(midi, this.strumBus, .82, false);
      const key = $(`.strum-key[data-index="${index}"]`);
      key?.classList.add("active"); setTimeout(() => key?.classList.remove("active"), 95);
    }

    async midiNoteOn(note, velocity) {
      await this.ensure();
      if (this.midiVoices.has(note)) this.releaseVoice(this.midiVoices.get(note));
      this.midiVoices.set(note, this.createVoice(note, this.strumBus, velocity, true));
    }

    midiNoteOff(note) { this.releaseVoice(this.midiVoices.get(note), .12); this.midiVoices.delete(note); }

    stopAll() {
      this.stopChord(true);
      this.midiVoices.forEach((voice) => this.releaseVoice(voice));
      this.midiVoices.clear();
      ui.status.textContent = "ALL NOTES OFF";
    }

    kick(when, velocity = 1) {
      const osc = this.context.createOscillator(), gain = this.context.createGain();
      osc.frequency.setValueAtTime(145, when); osc.frequency.exponentialRampToValueAtTime(43, when + .12);
      gain.gain.setValueAtTime(.65 * velocity, when); gain.gain.exponentialRampToValueAtTime(.001, when + .24);
      osc.connect(gain); gain.connect(this.rhythmBus); osc.start(when); osc.stop(when + .25);
    }

    noise(when, kind, velocity = 1) {
      const duration = kind === "hat" ? .055 : .16;
      const buffer = this.context.createBuffer(1, this.context.sampleRate * duration, this.context.sampleRate);
      const data = buffer.getChannelData(0); for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
      const source = this.context.createBufferSource(), filter = this.context.createBiquadFilter(), gain = this.context.createGain();
      source.buffer = buffer; filter.type = kind === "hat" ? "highpass" : "bandpass"; filter.frequency.value = kind === "hat" ? 6500 : 1550; filter.Q.value = kind === "hat" ? .4 : .8;
      gain.gain.setValueAtTime((kind === "hat" ? .14 : .32) * velocity, when); gain.gain.exponentialRampToValueAtTime(.001, when + duration);
      source.connect(filter); filter.connect(gain); gain.connect(this.rhythmBus); source.start(when);
    }

    bass(when, step) {
      if (!ui.autoBass.classList.contains("is-on") || !this.activeChord) return;
      const midi = ROOT_MIDI[this.activeChord.root] - 24 + (step % 8 >= 4 ? 7 : 0);
      this.createVoice(midi, this.rhythmBus, .65, false, when);
    }

    patternData(name) {
      const patterns = {
        "ROCK I": { kick:[0,8], snare:[4,12], hat:[0,2,4,6,8,10,12,14] },
        "ROCK II": { kick:[0,6,8,11], snare:[4,12], hat:[0,2,4,6,8,10,12,14] },
        DISCO: { kick:[0,4,8,12], snare:[4,12], hat:[2,6,10,14] },
        WALTZ: { length:12, kick:[0,6], snare:[4,10], hat:[0,2,4,6,8,10] },
        SWING: { length:12, kick:[0,7], snare:[4,10], hat:[0,3,4,7,8,11] },
        BOSSA: { kick:[0,3,7,10], snare:[4,12], hat:[0,2,4,6,8,10,12,14] },
        MARCH: { kick:[0,4,8,12], snare:[2,6,10,14], hat:[0,2,4,6,8,10,12,14] },
        "SLOW ROCK": { kick:[0,7,8], snare:[4,12], hat:[0,2,4,6,8,10,12,14] }
      };
      return patterns[name] || patterns["ROCK I"];
    }

    scheduleRhythm() {
      if (!this.context) return;
      const data = this.patternData(ui.pattern.value), length = data.length || 16;
      while (this.nextStepTime < this.context.currentTime + .1) {
        const step = this.step % length;
        if (data.kick.includes(step)) { this.kick(this.nextStepTime); this.bass(this.nextStepTime, step); }
        if (data.snare.includes(step)) this.noise(this.nextStepTime, "snare");
        if (data.hat.includes(step)) this.noise(this.nextStepTime, "hat", step % 4 === 0 ? 1 : .68);
        const bpm = Number($("#tempo").value), swing = ui.pattern.value === "SWING" && step % 2 ? .28 : 0;
        this.nextStepTime += (60 / bpm / 4) * (1 + swing);
        this.step = (this.step + 1) % length;
      }
    }

    async toggleRhythm() {
      await this.ensure();
      if (this.rhythmTimer) this.stopRhythm(); else {
        this.step = 0; this.nextStepTime = this.context.currentTime + .04;
        this.rhythmTimer = setInterval(() => this.scheduleRhythm(), 25);
        ui.rhythmStart.textContent = "RHYTHM STOP"; ui.rhythmStart.classList.add("is-on");
        ui.status.textContent = `${ui.pattern.value} RHYTHM`;
      }
    }

    stopRhythm() { clearInterval(this.rhythmTimer); this.rhythmTimer = null; ui.rhythmStart.textContent = "RHYTHM START"; ui.rhythmStart.classList.remove("is-on"); }
  }

  const engine = new RubyEngine();
  let lastStrum = -1, pointerDown = false, midiAccess = null, serialPort = null, learnTarget = null;
  const midiMap = JSON.parse(localStorage.getItem("rubychord-midi-map") || "{}");

  function buildChordGrid() {
    QUALITIES.forEach((quality, row) => {
      const label = document.createElement("span"); label.className = "row-label"; label.textContent = ["MAJOR", "MINOR", "7TH"][row]; ui.grid.append(label);
      ROOTS.forEach((root) => {
        const button = document.createElement("button");
        const mappedIndex = KEY_ROOTS.indexOf(root), key = mappedIndex >= 0 ? KEY_ROWS[row][mappedIndex] : "";
        button.className = "chord-button"; button.dataset.root = root; button.dataset.quality = quality; button.dataset.midiControl = `chord:${root}:${quality}`;
        button.innerHTML = `${root}${SUFFIX[quality]}${key ? `<b>${key.toUpperCase()}</b>` : ""}`;
        button.setAttribute("aria-label", `${root} ${quality} chord${key ? `, keyboard ${key}` : ""}`);
        button.addEventListener("pointerdown", (event) => { event.preventDefault(); engine.selectChord(root, quality); });
        button.addEventListener("pointerup", () => { if (!ui.chordHold.classList.contains("is-on")) engine.stopChord(); });
        ui.grid.append(button);
      });
    });
  }

  function buildStrumplate() {
    STRUM_KEYS.forEach((key, index) => {
      const button = document.createElement("button"); button.className = "strum-key"; button.dataset.index = index; button.dataset.midiControl = `strum:${index}`;
      button.setAttribute("aria-label", `Strum note ${index + 1}, keyboard ${key}`);
      button.addEventListener("pointerenter", () => { if (pointerDown && index !== lastStrum) { lastStrum = index; engine.strum(index); } });
      button.addEventListener("pointerdown", (event) => { event.preventDefault(); pointerDown = true; lastStrum = index; engine.strum(index); button.setPointerCapture?.(event.pointerId); });
      button.addEventListener("pointerup", () => { pointerDown = false; lastStrum = -1; });
      ui.strumplate.append(button);
    });
  }

  function updateKnob(input) {
    const min = Number(input.min), max = Number(input.max), ratio = (Number(input.value) - min) / (max - min);
    input.closest(".knob").style.setProperty("--turn", `${-125 + ratio * 250}deg`);
    const output = input.closest(".knob-control").querySelector("output"); output.value = input.id === "tempo" ? Math.round(input.value) : Number(input.value).toFixed(2);
    const knob = input.closest(".knob");
    knob?.setAttribute("aria-valuenow", String(input.value));
    knob?.setAttribute("aria-valuetext", output.value);
    engine.updateControls();
  }

  function configureKnob(input) {
    const knob = input.closest(".knob"), min = Number(input.min), max = Number(input.max), range = max - min;
    const step = input.step === "any" ? range / 100 : Number(input.step || range / 100);
    knob.tabIndex = 0; knob.setAttribute("role", "slider"); knob.setAttribute("aria-label", input.id); knob.setAttribute("aria-valuemin", String(min)); knob.setAttribute("aria-valuemax", String(max));
    knob.dataset.midiControl = input.id;
    const setValue = (value) => {
      const precision = step < 1 ? Math.max(0, String(step).split(".")[1]?.length || 0) : 0;
      input.value = Math.max(min, Math.min(max, Math.round(value / step) * step)).toFixed(precision);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    };
    let drag = null;
    knob.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      event.preventDefault(); knob.focus(); knob.setPointerCapture(event.pointerId); knob.classList.add("dragging");
      drag = { x:event.clientX, y:event.clientY, value:Number(input.value), pointerId:event.pointerId };
    });
    knob.addEventListener("pointermove", (event) => {
      if (!drag || event.pointerId !== drag.pointerId) return;
      const travel = (drag.y - event.clientY) + (event.clientX - drag.x) * .25;
      const fine = event.shiftKey ? .2 : 1;
      setValue(drag.value + travel / 180 * range * fine);
    });
    const finishDrag = (event) => {
      if (!drag || event.pointerId !== drag.pointerId) return;
      knob.classList.remove("dragging"); drag = null;
    };
    knob.addEventListener("pointerup", finishDrag); knob.addEventListener("pointercancel", finishDrag);
    knob.addEventListener("wheel", (event) => { event.preventDefault(); setValue(Number(input.value) + (event.deltaY < 0 ? 1 : -1) * step * (event.shiftKey ? 1 : 2)); }, { passive:false });
    knob.addEventListener("keydown", (event) => {
      const direction = { ArrowUp:1, ArrowRight:1, ArrowDown:-1, ArrowLeft:-1 }[event.key];
      if (direction) { event.preventDefault(); setValue(Number(input.value) + direction * step); }
      else if (event.key === "Home") { event.preventDefault(); setValue(min); }
      else if (event.key === "End") { event.preventDefault(); setValue(max); }
      else if (event.key === "PageUp") { event.preventDefault(); setValue(Number(input.value) + range / 10); }
      else if (event.key === "PageDown") { event.preventDefault(); setValue(Number(input.value) - range / 10); }
    });
  }

  function toggle(button) { const on = !button.classList.contains("is-on"); button.classList.toggle("is-on", on); button.setAttribute("aria-pressed", String(on)); return on; }

  function tapTempo() {
    const now = performance.now(); engine.tapTimes = engine.tapTimes.filter((time) => now - time < 2200); engine.tapTimes.push(now);
    if (engine.tapTimes.length > 1) {
      const gaps = engine.tapTimes.slice(1).map((time, i) => time - engine.tapTimes[i]);
      $("#tempo").value = Math.max(60, Math.min(180, Math.round(60000 / (gaps.reduce((a,b) => a+b, 0) / gaps.length)))); updateKnob($("#tempo"));
    }
  }

  async function enableMidi() {
    if (!("requestMIDIAccess" in navigator)) { ui.midiStatus.textContent = "WEB MIDI NOT AVAILABLE"; return; }
    try {
      midiAccess = await navigator.requestMIDIAccess();
      midiAccess.inputs.forEach(bindMidiInput); midiAccess.onstatechange = () => midiAccess.inputs.forEach(bindMidiInput);
      ui.midiButton.classList.add("is-on"); ui.midiButton.textContent = "MIDI ON"; ui.midiStatus.textContent = `${midiAccess.inputs.size || 0} MIDI INPUT${midiAccess.inputs.size === 1 ? "" : "S"}`;
    } catch (_) { ui.midiStatus.textContent = "MIDI ACCESS DECLINED"; }
  }

  function bindMidiInput(input) { input.onmidimessage = onMidiMessage; }

  function onMidiMessage(event) {
    const [status, data1, data2] = event.data, command = status & 0xf0;
    if (command === 0xb0) {
      if (learnTarget) {
        midiMap[data1] = learnTarget; localStorage.setItem("rubychord-midi-map", JSON.stringify(midiMap));
        ui.status.textContent = `CC ${data1} → ${learnTarget}`; learnTarget = null; $("#instrument").classList.remove("learning"); return;
      }
      const target = midiMap[data1]; if (target) applyMidiControl(target, data2 / 127); return;
    }
    if (command === 0x90 && data2 > 0) engine.midiNoteOn(data1, data2 / 127);
    if (command === 0x80 || (command === 0x90 && data2 === 0)) engine.midiNoteOff(data1);
  }

  async function enableSerial() {
    if (!("serial" in navigator)) { ui.midiStatus.textContent = "WEB SERIAL NOT AVAILABLE"; return; }
    try {
      serialPort = await navigator.serial.requestPort();
      await serialPort.open({ baudRate: 115200 });
      ui.serialButton.classList.add("is-on"); ui.serialButton.textContent = "SERIAL ON"; ui.midiStatus.textContent = "SERIAL 115200 BAUD";
      readSerial(serialPort);
    } catch (error) { if (error.name !== "NotFoundError") ui.midiStatus.textContent = "SERIAL CONNECTION FAILED"; }
  }

  async function readSerial(port) {
    const decoder = new TextDecoder(); let pending = "";
    while (port.readable) {
      const reader = port.readable.getReader();
      try {
        while (true) {
          const { value, done } = await reader.read(); if (done) break;
          pending += decoder.decode(value, { stream: true });
          const lines = pending.split(/\r?\n/); pending = lines.pop(); lines.forEach(handleSerialCommand);
        }
      } catch (_) { ui.midiStatus.textContent = "SERIAL DISCONNECTED"; }
      finally { reader.releaseLock(); }
    }
  }

  function handleSerialCommand(line) {
    const parts = line.trim().split(/\s+/), command = (parts.shift() || "").toUpperCase();
    if (command === "CHORD") {
      const root = ROOTS.find((item) => item.toLowerCase() === (parts[0] || "").toLowerCase());
      const quality = ({ M:"major", MAJOR:"major", MIN:"minor", MINOR:"minor", "7":"seventh", SEVENTH:"seventh" })[(parts[1] || "MAJOR").toUpperCase()];
      if (root && quality) engine.selectChord(root, quality);
    } else if (command === "STRUM") engine.strum(Math.max(0, Math.min(11, Number(parts[0]) - 1)));
    else if (command === "NOTE") engine.midiNoteOn(Number(parts[0]), Math.max(0, Math.min(1, Number(parts[1] || 100) / 127)));
    else if (command === "NOTEOFF") engine.midiNoteOff(Number(parts[0]));
    else if (command === "CC") applyMidiControl(midiMap[Number(parts[0])] || "", Number(parts[1]) / 127);
    else if (command === "OFF") { engine.stopAll(); engine.stopRhythm(); }
    else if (command === "RHYTHM" && (parts[0] || "").toUpperCase() === "START" && !engine.rhythmTimer) engine.toggleRhythm();
    else if (command === "RHYTHM" && (parts[0] || "").toUpperCase() === "STOP") engine.stopRhythm();
  }

  function applyMidiControl(target, value) {
    if (target.startsWith("chord:")) { const [,root,quality] = target.split(":"); if (value > .5) engine.selectChord(root, quality); return; }
    if (target.startsWith("strum:")) { if (value > .5) engine.strum(Number(target.split(":")[1])); return; }
    const input = document.getElementById(target); if (input?.type === "range") { input.value = Number(input.min) + value * (Number(input.max) - Number(input.min)); updateKnob(input); }
  }

  buildChordGrid(); buildStrumplate();

  ui.strumplate.addEventListener("pointermove", (event) => {
    if (!pointerDown) return;
    const bounds = ui.strumplate.getBoundingClientRect();
    const index = Math.max(0, Math.min(11, Math.floor((event.clientY - bounds.top) / bounds.height * 12)));
    if (index !== lastStrum) { lastStrum = index; engine.strum(index); }
  });

  $$("input[type=range]").forEach((input) => { input.dataset.midiControl = input.id; input.addEventListener("input", () => updateKnob(input)); configureKnob(input); updateKnob(input); });
  ui.chordHold.addEventListener("click", () => toggle(ui.chordHold));
  ui.autoBass.addEventListener("click", () => toggle(ui.autoBass));
  ui.rhythmStart.addEventListener("click", () => engine.toggleRhythm());
  $("#instantOff").addEventListener("click", () => { engine.stopAll(); engine.stopRhythm(); });
  $("#hostSync").addEventListener("click", tapTempo);
  ui.midiButton.addEventListener("click", enableMidi);
  ui.serialButton.addEventListener("click", enableSerial);
  ui.pattern.addEventListener("change", () => { if (engine.rhythmTimer) { engine.step = 0; ui.status.textContent = `${ui.pattern.value} RHYTHM`; } });
  $("#helpToggle").addEventListener("click", (event) => { const panel = $("#helpPanel"), open = panel.hidden; panel.hidden = !open; event.currentTarget.setAttribute("aria-expanded", String(open)); });

  document.addEventListener("dblclick", (event) => {
    const control = event.target.closest("[data-midi-control]"); if (!control) return;
    event.preventDefault(); learnTarget = control.dataset.midiControl; $("#instrument").classList.add("learning"); ui.status.textContent = `MOVE A MIDI CC FOR ${learnTarget.toUpperCase()}`;
  });

  window.addEventListener("keydown", (event) => {
    if (event.repeat || /INPUT|SELECT|TEXTAREA/.test(event.target.tagName)) return;
    const key = event.key.toLowerCase();
    for (let row = 0; row < KEY_ROWS.length; row++) {
      const index = KEY_ROWS[row].indexOf(key);
      if (index >= 0) { event.preventDefault(); engine.selectChord(KEY_ROOTS[index], QUALITIES[row]); return; }
    }
    const strumIndex = STRUM_KEYS.indexOf(event.key);
    if (strumIndex >= 0) { event.preventDefault(); engine.strum(strumIndex); return; }
    if (event.code === "Space") { event.preventDefault(); engine.stopAll(); engine.stopRhythm(); }
  });

  window.addEventListener("keyup", (event) => {
    const key = event.key.toLowerCase();
    if (!ui.chordHold.classList.contains("is-on") && KEY_ROWS.some((row) => row.includes(key))) engine.stopChord();
  });

  window.addEventListener("pointerup", () => { pointerDown = false; lastStrum = -1; });
})();
