import {
  chordForKey,
  strumIndex,
  mountKeyboard,
} from "./keyboard-view.js?v=20260926-overlay";
import { SampleEngine } from "./audio-engine.js?v=20260926-defaultoff";
import {
  ROOTS,
  PANEL_ROOTS,
  LABELS,
  SUFFIX,
  VOICES,
  PATTERNS,
  resolveChord,
  chordButtons,
} from "./omnichord-controls.js";
import { connectDevices } from "./connections.js?v=20260926-rhythm";
const $ = (s) => document.querySelector(s),
  $$ = (s) => [...document.querySelectorAll(s)];
const engine = new SampleEngine((text, state = {}) => {
  if (state.phase === "rhythm") {
    refreshRhythm();
    return;
  }
  $("#sampleStatus").textContent = text;
});
const pressed = new Map(),
  latched = new Map(),
  pointers = new Map();
let fit = false,
  powerBusy = false,
  rhythmBusy = false,
  startOnPower = false;
function refreshPlayingDisplay() {
  $("#powerPlaque").hidden = engine.powered;
  const notes = engine.settings.keyboard
    ? [
        ...new Set(
          [...pressed.values()].map(
            ({ note }) => `${LABELS[note % 12]}${Math.floor(note / 12) - 1}`,
          ),
        ),
      ].join(" · ")
    : engine.chordActive && engine.chord
      ? `${LABELS[engine.chord.root]}${SUFFIX[engine.chord.quality]}`
      : "";
  $("#statusText").textContent = engine.powered ? notes : "";
  $("#statusText").hidden = !engine.powered || !notes;
}
function setPressed(id, on) {
  $(id).setAttribute("aria-pressed", String(on));
}
function light(id, on) {
  $(id).classList.toggle("on", on);
}
function refreshRhythm() {
  const playing = !!engine.rhythmTimer;
  setPressed("#rhythmStart", playing || rhythmBusy || startOnPower);
  light("#startLight", playing || rhythmBusy || startOnPower);
  light("#syncLight", engine.settings.sync);
  setPressed("#syncStart", engine.settings.sync);
  const label =
    playing || rhythmBusy || startOnPower ? "Stop rhythm" : "Start rhythm";
  $("#rhythmStart").setAttribute("aria-label", label);
  $("#rhythmStart").title = label;
}
function stop({ keepRhythm = false } = {}) {
  pressed.clear();
  latched.clear();
  pointers.clear();
  if (keepRhythm) engine.stopNotes();
  else {
    rhythmBusy = false;
    startOnPower = false;
    engine.stopAll();
  }
  $$(".chord-button").forEach((b) => {
    b.classList.remove("active");
    b.setAttribute("aria-pressed", "false");
  });
  refreshPlayingDisplay();
}
async function power() {
  if (powerBusy) return;
  powerBusy = true;
  const on = !engine.powered;
  setPressed("#power", on);
  light("#powerLight", on);
  try {
    if (!on) stop();
    const change = engine.power(on);
    refreshPlayingDisplay();
    await change;
    if (on && startOnPower) {
      startOnPower = false;
      engine.startRhythm();
    }
  } catch (error) {
    $("#sampleStatus").textContent = `Audio could not start: ${error.message}`;
    engine.powered = false;
    setPressed("#power", false);
    light("#powerLight", false);
  } finally {
    powerBusy = false;
    refreshPlayingDisplay();
  }
}
$("#power").addEventListener("pointerdown", (event) => event.preventDefault());
$("#power").addEventListener("click", power);
function knob(parent, id, label, min, max, value, step) {
  const wrapper = document.createElement("label");
  wrapper.className = "knob-control";
  wrapper.innerHTML = `<span class="knob" role="slider" tabindex="0" aria-label="${label}" aria-valuemin="${min}" aria-valuemax="${max}" data-midi-control="${id}"><input id="${id}" type="range" tabindex="-1" aria-hidden="true" min="${min}" max="${max}" value="${value}" step="${step}"></span><span>${label}</span>`;
  $(parent).append(wrapper);
  const input = wrapper.querySelector("input"),
    dial = wrapper.querySelector(".knob");
  const update = (v) => {
    input.value = String(
      Math.max(min, Math.min(max, Math.round(v / step) * step)),
    );
    const value = Number(input.value);
    dial.style.setProperty(
      "--turn",
      `${-135 + ((value - min) / (max - min)) * 270}deg`,
    );
    dial.setAttribute("aria-valuenow", String(value));
    dial.setAttribute(
      "aria-valuetext",
      id === "tempo"
        ? `${Math.round(value)} beats per minute`
        : `${Math.round(((value - min) / (max - min)) * 100)} percent`,
    );
    engine.update({ [id]: value });
  };
  let drag = null;
  input.addEventListener("input", () => update(Number(input.value)));
  dial.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    dial.focus();
    dial.setPointerCapture(e.pointerId);
    drag = {
      id: e.pointerId,
      y: e.clientY,
      x: e.clientX,
      value: Number(input.value),
    };
  });
  dial.addEventListener("pointermove", (e) => {
    if (!drag || drag.id !== e.pointerId) return;
    update(
      drag.value +
        ((drag.y - e.clientY + (e.clientX - drag.x) * 0.2) / 160) *
          (max - min) *
          (e.shiftKey ? 0.2 : 1),
    );
  });
  for (const type of ["pointerup", "pointercancel", "lostpointercapture"])
    dial.addEventListener(type, () => (drag = null));
  dial.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      update(
        Number(input.value) +
          (e.deltaY < 0 ? 1 : -1) * step * (e.shiftKey ? 1 : 2),
      );
    },
    { passive: false },
  );
  dial.addEventListener("keydown", (e) => {
    const d = {
      ArrowUp: 1,
      ArrowRight: 1,
      ArrowDown: -1,
      ArrowLeft: -1,
      PageUp: 10,
      PageDown: -10,
    }[e.key];
    if (d) {
      e.preventDefault();
      e.stopPropagation();
      update(Number(input.value) + d * step);
    } else if (e.key === "Home" || e.key === "End") {
      e.preventDefault();
      update(e.key === "Home" ? min : max);
    }
  });
  update(value);
}
knob("#masterControl", "master", "Master Volume", 0, 1, 0.65, 0.01);
knob("#stringControls", "sustain", "Sustain", 0, 1, 1, 0.01);
knob("#stringControls", "strum", "Main Volume", 0, 1, 0.65, 0.01);
knob("#stringControls", "sub", "Sub Volume", 0, 1, 0.35, 0.01);
knob("#rhythmControls", "tempo", "Tempo", 40, 200, 112, 1);
knob("#rhythmControls", "rhythm", "Volume", 0, 1, 0.4, 0.01);
knob("#chordControls", "chord", "Volume", 0, 1, 0.5, 0.01);
$("#rhythm").parentElement.setAttribute("aria-label", "Rhythm Volume");
$("#chord").parentElement.setAttribute("aria-label", "Chord Volume");
function selectors(container, values, setting) {
  let bank = 0,
    column = 0;
  const host = $(container);
  const bankEl = document.createElement("div");
  bankEl.className = "selector bank";
  bankEl.innerHTML =
    '<i class="led on"></i><button class="physical yellow" aria-pressed="false"></button><i class="led"></i>';
  host.append(bankEl);
  const bankButton = bankEl.querySelector("button");
  bankButton.setAttribute("aria-label", `${setting} upper/lower bank`);
  const buttons = Array.from({ length: 5 }, (_, i) => {
    const el = document.createElement("div");
    el.className = "selector";
    el.innerHTML = `<i class="led"></i><span class="upper">${values[i]}</span><button class="physical"></button><span class="lower">${values[i + 5]}</span>`;
    host.append(el);
    const button = el.querySelector("button");
    button.addEventListener("click", () => {
      column = i;
      update();
    });
    return button;
  });
  function update() {
    const value = values[bank * 5 + column];
    engine.update({ [setting]: value });
    if (setting === "voice" && engine.playable && engine.chord) {
      engine.chordReady = engine.warmChord(engine.chord);
    }
    bankButton.setAttribute("aria-pressed", String(bank === 1));
    [...bankEl.querySelectorAll(".led")].forEach((l, i) =>
      l.classList.toggle("on", i === bank),
    );
    buttons.forEach((button, i) => {
      button.setAttribute("aria-label", `${setting}: ${values[bank * 5 + i]}`);
      button.setAttribute("aria-pressed", String(i === column));
      button.parentElement
        .querySelector(".led")
        .classList.toggle("on", i === column);
    });
  }
  bankButton.addEventListener("click", () => {
    bank = 1 - bank;
    update();
  });
  update();
}
selectors("#voiceSelectors", VOICES, "voice");
selectors("#patternSelectors", PATTERNS, "pattern");
function selected(chord, options = {}) {
  if (!engine.powered) return;
  engine.selectChord(chord, options);
  $$(".chord-button").forEach((b) => {
    const on =
      Number(b.dataset.root) === chord.root &&
      (b.dataset.quality === chord.quality ||
        [...pressed.values(), ...latched.values()].some(
          (v) =>
            v.root === Number(b.dataset.root) &&
            v.quality === b.dataset.quality,
        ));
    b.classList.toggle("active", on);
    b.setAttribute("aria-pressed", String(on));
  });
  refreshPlayingDisplay();
}
function selectHeld(triggerRhythm = true) {
  const values = [...latched.values(), ...pressed.values()];
  if (values.length) selected(resolveChord(values), { triggerRhythm });
  else {
    engine.releaseChord();
    refreshPlayingDisplay();
  }
}
function begin(key, descriptor) {
  if (!engine.powered) return;
  pressed.set(key, descriptor);
  if (engine.settings.keyboard) {
    engine.midiNoteOn(descriptor.note, 0.85);
    refreshPlayingDisplay();
    return;
  }
  selectHeld();
}
function end(key) {
  const descriptor = pressed.get(key);
  pressed.delete(key);
  if (engine.settings.keyboard) {
    if (descriptor) engine.midiNoteOff(descriptor.note);
    refreshPlayingDisplay();
    return;
  }
  if (pressed.size || latched.size) selectHeld(false);
  else {
    engine.releaseChord();
    if (!engine.settings.hold)
      $$(".chord-button").forEach((b) => {
        b.classList.remove("active");
        b.setAttribute("aria-pressed", "false");
      });
    refreshPlayingDisplay();
  }
}
const descriptors = chordButtons().map((d, i) => ({ ...d, note: 48 + i }));
for (const [i, root] of PANEL_ROOTS.entries()) {
  const label = document.createElement("span");
  label.className = "root-label";
  label.style.left = `${54 + i * 31}px`;
  label.textContent = LABELS[root];
  $("#chordGrid").append(label);
}
for (const [row, name] of ["MAJOR", "MINOR", "7th"].entries()) {
  const label = document.createElement("span");
  label.className = "row-label";
  label.style.top = `${29 + row * 42}px`;
  label.textContent = name;
  $("#chordGrid").append(label);
}
for (const descriptor of descriptors) {
  const { root, quality, row, column } = descriptor;
  const button = document.createElement("button");
  button.className = "chord-button";
  if (
    row === 0 ||
    (row === 1 ? [0, 1, 4, 8, 11] : [0, 4, 7, 10]).includes(column)
  )
    button.classList.add("grey");
  button.style.left = `${(row === 0 ? 54 : row === 1 ? 37 : 54) + column * 31}px`;
  button.style.top = `${18 + row * 42}px`;
  button.dataset.root = root;
  button.dataset.quality = quality;
  button.dataset.midiControl = `chord:${ROOTS[root]}:${quality}`;
  button.setAttribute("aria-label", `${LABELS[root]} ${quality} chord`);
  button.setAttribute("aria-pressed", "false");
  button.title = `${LABELS[root]} ${quality}`;
  button.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    button.focus();
    button.setPointerCapture(e.pointerId);
    if (e.shiftKey && !engine.settings.keyboard) {
      const id = `${root}:${quality}`;
      if (latched.has(id)) latched.delete(id);
      else latched.set(id, descriptor);
      selectHeld();
    } else begin(`p${e.pointerId}`, descriptor);
  });
  for (const type of ["pointerup", "pointercancel", "lostpointercapture"])
    button.addEventListener(type, (e) => {
      if (pressed.has(`p${e.pointerId}`)) end(`p${e.pointerId}`);
    });
  button.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      e.stopPropagation();
      if (!e.repeat) begin("focused", descriptor);
    }
  });
  button.addEventListener("keyup", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      e.stopPropagation();
      end("focused");
    }
  });
  // Assistive-technology activation does not generate pointer events.
  button.addEventListener("click", (e) => {
    if (e.detail === 0 && !pressed.has("focused")) {
      begin("accessible", descriptor);
      setTimeout(() => end("accessible"), 200);
    }
  });
  $("#chordGrid").append(button);
}
function strum(index) {
  if (engine.settings.keyboard) {
    if (engine.powered && engine.loadResult)
      engine.drum(
        ["kick", "snare", "hihat", "clave"][index % 4],
        engine.ctx.currentTime,
      );
  } else engine.strum(index);
  const flash = document.createElement("span");
  flash.className = "strum-flash";
  flash.style.top = `${((12 - index) / 13) * 100}%`;
  $("#strumplate").append(flash);
  setTimeout(() => flash.remove(), 90);
  $("#strumplate").setAttribute("aria-valuenow", String(index + 1));
}
const plate = $("#strumplate");
const zone = (e) => {
  const r = plate.getBoundingClientRect();
  return (
    12 -
    Math.max(0, Math.min(12, Math.floor(((e.clientY - r.top) / r.height) * 13)))
  );
};
plate.addEventListener("pointerdown", (e) => {
  e.preventDefault();
  plate.setPointerCapture(e.pointerId);
  const index = zone(e);
  pointers.set(e.pointerId, index);
  strum(index);
});
plate.addEventListener("pointermove", (e) => {
  if (!pointers.has(e.pointerId)) return;
  const samples = e.getCoalescedEvents?.() || [e];
  for (const point of samples.length ? samples : [e]) {
    const next = zone(point),
      last = pointers.get(e.pointerId);
    if (next === last) continue;
    const dir = Math.sign(next - last);
    for (let i = last + dir; i !== next + dir; i += dir) strum(i);
    pointers.set(e.pointerId, next);
  }
});
for (const type of ["pointerup", "pointercancel", "lostpointercapture"])
  plate.addEventListener(type, (e) => pointers.delete(e.pointerId));
plate.addEventListener("keydown", (e) => {
  if (["ArrowUp", "ArrowDown", "Enter"].includes(e.key)) {
    e.preventDefault();
    e.stopPropagation();
    let i = Number(plate.getAttribute("aria-valuenow")) - 1;
    if (e.key !== "Enter")
      i = Math.max(0, Math.min(12, i + (e.key === "ArrowUp" ? 1 : -1)));
    strum(i);
  }
});
$("#chordHold").addEventListener("click", () => {
  engine.update({ hold: !engine.settings.hold });
  setPressed("#chordHold", engine.settings.hold);
  light("#holdLight", engine.settings.hold);
  if (!engine.settings.hold && !pressed.size && !latched.size)
    engine.releaseChord();
  refreshPlayingDisplay();
});
$("#autoBass").addEventListener("click", () => {
  const auto = !engine.settings.auto;
  engine.update({ auto });
  setPressed("#autoBass", auto);
  light("#manualLight", !auto);
  light("#autoLight", auto);
  if (engine.chord && engine.chordActive)
    selected(engine.chord, { triggerRhythm: false });
});
$("#rhythmStart").addEventListener("click", async () => {
  if (engine.rhythmTimer || rhythmBusy || startOnPower) {
    rhythmBusy = false;
    startOnPower = false;
    engine.update({ sync: false });
    engine.stopRhythm();
    refreshRhythm();
    return;
  }
  // Before Power, select immediate Start without loading audio.
  if (!engine.powered) {
    startOnPower = true;
    engine.update({ sync: false });
    refreshRhythm();
    return;
  }
  engine.update({ sync: false });
  rhythmBusy = true;
  refreshRhythm();
  const token = engine.rhythmGeneration;
  try {
    if ((await engine.ensure()) && token === engine.rhythmGeneration)
      engine.startRhythm();
  } finally {
    if (token === engine.rhythmGeneration) rhythmBusy = false;
    refreshRhythm();
  }
});
$("#syncStart").addEventListener("click", () => {
  const sync = !engine.settings.sync;
  rhythmBusy = false;
  startOnPower = false;
  engine.update({ sync });
  engine.stopRhythm();
  refreshRhythm();
});
$("#keyboard").addEventListener("click", () => {
  stop({ keepRhythm: true });
  const keyboard = !engine.settings.keyboard;
  engine.update({ keyboard });
  setPressed("#keyboard", keyboard);
  light("#keyboardLight", keyboard);
  refreshPlayingDisplay();
});
window.addEventListener("keydown", (e) => {
  if (
    e.repeat ||
    e.ctrlKey ||
    e.metaKey ||
    e.altKey ||
    e.target.closest("#helpPanel") ||
    e.target.matches("input,select,textarea") ||
    e.defaultPrevented
  )
    return;
  if (e.code === "Space") {
    if (e.target.matches("button")) return;
    e.preventDefault();
    stop();
    return;
  }
  const key = e.key.toLowerCase();
  const index = strumIndex(key);
  if (index >= 0) {
    e.preventDefault();
    strum(index);
    return;
  }
  const chord = chordForKey(key);
  if (chord) {
    e.preventDefault();
    begin(
      `k${e.code}`,
      descriptors.find(
        (d) => d.root === chord.root && d.quality === chord.quality,
      ),
    );
  }
});
window.addEventListener("keyup", (e) => {
  if (pressed.has(`k${e.code}`)) end(`k${e.code}`);
});
window.addEventListener("blur", () => {
  pressed.clear();
  latched.clear();
  pointers.clear();
  if (engine.ctx) stop({ keepRhythm: true });
});
const devices = connectDevices({
  engine,
  selectChord: selected,
  status: (text) => ($("#midiStatus").textContent = text),
  learnStatus: (text) => ($("#midiStatus").textContent = text),
  applyControl: (target, value) => {
    if (target.startsWith("chord:")) {
      const [, root, quality] = target.split(":");
      if (value > 0.5 && ROOTS.includes(root))
        selected({ root: ROOTS.indexOf(root), quality });
      else if (value <= 0.5) {
        engine.releaseChord();
        refreshPlayingDisplay();
      }
    } else if (target.startsWith("strum:")) {
      if (value > 0.5) strum(Number(target.split(":")[1]));
    } else {
      const input = document.getElementById(target);
      if (input?.type === "range") {
        input.value =
          Number(input.min) + value * (Number(input.max) - Number(input.min));
        input.dispatchEvent(new Event("input"));
      }
    }
  },
});
$("#midiButton").addEventListener("click", () => devices.midi());
$("#serialButton").addEventListener("click", () => devices.serial());
$("#clearMidi").addEventListener("click", () => devices.clear());
document.addEventListener("dblclick", (e) => {
  const control = e.target.closest("[data-midi-control]");
  if (control) devices.learn(control.dataset.midiControl);
  else if (e.target.closest("#strumplate")) devices.learn(`strum:${zone(e)}`);
});
function drawer(open) {
  $("#helpPanel").hidden = !open;
  $("#helpToggle").setAttribute("aria-expanded", String(open));
  if (open) $("#helpClose").focus();
  else $("#helpToggle").focus();
}
$("#helpToggle").addEventListener("click", () =>
  drawer($("#helpPanel").hidden),
);
$("#helpClose").addEventListener("click", () => drawer(false));
window.addEventListener("keydown", (e) => {
  if (e.key === "Escape") drawer(false);
});
function resize() {
  const width = $(".stage").clientWidth;
  const keyboardSpace = document.body.classList.contains("keyboard-open")
    ? $("#keyboardOverlay").offsetHeight + 28
    : 0;
  const scale =
    fit || (keyboardSpace > 0 && width < 700)
      ? Math.min(1.45, (width - 20) / 1100)
      : Math.min(
          1.45,
          width >= 700
            ? Math.max(0.5, (window.innerHeight - 230 - keyboardSpace) / 600)
            : 1.45,
          Math.max(width < 700 ? 0.88 : 0.5, (width - 20) / 1100),
        );
  const wrap = $(".instrument-wrap");
  wrap.style.width = `${1100 * scale}px`;
  wrap.style.height = `${600 * scale}px`;
  $("#instrument").style.transform = `scale(${scale})`;
}
$("#fitToggle").addEventListener("click", () => {
  fit = !fit;
  setPressed("#fitToggle", fit);
  $("#fitToggle").textContent = fit ? "Playing size" : "Fit instrument";
  resize();
});
mountKeyboard({
  chordDown: (key, chord) =>
    begin(
      key,
      descriptors.find(
        (d) => d.root === chord.root && d.quality === chord.quality,
      ),
    ),
  chordUp: end,
  strum,
  stop,
  visibilityChanged: resize,
});
new ResizeObserver(resize).observe($(".stage"));
resize();

window.addEventListener("resize", resize);
