export function connectDevices({
  engine,
  selectChord,
  applyControl,
  status,
  learnStatus,
}) {
  let mapping = {};
  try {
    mapping = JSON.parse(localStorage.getItem("rubychord-midi-map") || "{}");
  } catch {}
  let learning = null,
    port = null,
    midi = null;
  const save = () => {
    try {
      localStorage.setItem("rubychord-midi-map", JSON.stringify(mapping));
    } catch {}
  };
  const cc = (number, value) => {
    if (learning) {
      mapping[number] = learning;
      save();
      learnStatus(`CC ${number} assigned to ${learning}`);
      learning = null;
      return;
    }
    if (mapping[number])
      applyControl(mapping[number], Math.max(0, Math.min(1, value)));
  };
  const handleMidi = ({ data }) => {
    const [status, n, v] = data,
      command = status & 240;
    if (command === 176) cc(n, v / 127);
    else if (command === 144 && v > 0) engine.midiNoteOn(n, v / 127);
    else if (command === 128 || (command === 144 && v === 0))
      engine.midiNoteOff(n);
  };
  const serialLine = (line) => {
    const [command, ...args] = line.trim().split(/\s+/);
    const n = Number(args[0]);
    const roots = [
      "C",
      "C#",
      "D",
      "EB",
      "E",
      "F",
      "F#",
      "G",
      "AB",
      "A",
      "BB",
      "B",
    ];
    switch (command?.toUpperCase()) {
      case "CHORD": {
        const root = roots.indexOf((args[0] || "").toUpperCase()),
          quality = {
            M: "major",
            MAJOR: "major",
            MIN: "minor",
            MINOR: "minor",
            7: "seventh",
            SEVENTH: "seventh",
            M7: "major7",
            MIN7: "minor7",
            AUG: "augmented",
            DIM: "diminished",
            SUS4: "sus4",
            ADD9: "add9",
          }[(args[1] || "MAJOR").toUpperCase()];
        if (root >= 0 && quality) selectChord({ root, quality });
        break;
      }
      case "STRUM":
        if (Number.isInteger(n) && n >= 1 && n <= 13) engine.strum(n - 1);
        break;
      case "NOTE":
        engine.midiNoteOn(n, Number(args[1] || 100) / 127);
        break;
      case "NOTEOFF":
        engine.midiNoteOff(n);
        break;
      case "CC":
        if (Number.isFinite(n) && Number.isFinite(Number(args[1])))
          cc(n, Number(args[1]) / 127);
        break;
      case "OFF":
        engine.stopAll();
        break;
      case "RHYTHM":
        if (args[0]?.toUpperCase() === "STOP") engine.stopRhythm();
        else if (args[0]?.toUpperCase() === "START")
          engine.ensure().then((ok) => {
            if (ok) engine.startRhythm();
          });
        break;
    }
  };
  return {
    learn(target) {
      learning = target;
      learnStatus(`Move a MIDI CC to assign ${target}`);
    },
    clear() {
      mapping = {};
      save();
      learning = null;
      status("MIDI assignments cleared");
    },
    async midi() {
      if (!navigator.requestMIDIAccess) {
        status("Web MIDI is not available in this browser");
        return;
      }
      try {
        midi = await navigator.requestMIDIAccess();
        const bind = () => {
          midi.inputs.forEach((i) => (i.onmidimessage = handleMidi));
          status(`${midi.inputs.size} MIDI input(s) connected`);
        };
        bind();
        midi.onstatechange = bind;
      } catch {
        status("MIDI access declined");
      }
    },
    async serial() {
      if (!navigator.serial) {
        status("Web Serial is not available in this browser");
        return;
      }
      if (port) {
        status("Serial is already connected");
        return;
      }
      try {
        const chosen = await navigator.serial.requestPort();
        await chosen.open({ baudRate: 115200 });
        port = chosen;
        status("Serial connected · 115200 baud");
        const decoder = new TextDecoder();
        let pending = "";
        const reader = port.readable.getReader();
        try {
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            pending += decoder.decode(value, { stream: true });
            const lines = pending.split(/\r?\n/);
            pending = lines.pop().slice(-4096);
            lines.forEach(serialLine);
          }
        } finally {
          reader.releaseLock();
          await port.close();
          port = null;
          status("Serial disconnected");
        }
      } catch (error) {
        port = null;
        status(
          error.name === "NotFoundError"
            ? "Serial connection cancelled"
            : "Serial connection failed",
        );
      }
    },
  };
}
