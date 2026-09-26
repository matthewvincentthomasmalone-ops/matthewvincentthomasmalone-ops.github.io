const roots = [3, 10, 5, 0, 7, 2, 9, 4, 11, 6];
const rowKeys = ["qwertyuiop", "asdfghjkl;", "zxcvbnm,./"];
const qualities = ["major", "minor", "seventh"];
const rootNames = ["E♭", "B♭", "F", "C", "G", "D", "A", "E", "B", "F♯"];
export function chordForKey(key) {
  if (!key || key.length !== 1) return null;
  key = key.toLowerCase();
  if (key === ":") key = ";";
  if (key === "?") key = "/";
  for (let row = 0; row < rowKeys.length; row++) {
    const column = rowKeys[row].indexOf(key);
    if (column >= 0) return { root: roots[column], quality: qualities[row] };
  }
  return null;
}
export function strumIndex(key) {
  return [
    "1",
    "2",
    "3",
    "4",
    "5",
    "6",
    "7",
    "8",
    "9",
    "0",
    "-",
    "=",
    "+",
  ].indexOf(key);
}
const key = (code, label, value = "", width = 1, shifted = "") => ({
  code,
  label,
  value,
  width,
  shifted,
});
const letterKeys = (row) =>
  [...rowKeys[row]].map((value, column) => ({
    ...key(
      value === ";"
        ? "Semicolon"
        : value === ","
          ? "Comma"
          : value === "."
            ? "Period"
            : value === "/"
              ? "Slash"
              : `Key${value.toUpperCase()}`,
      value.toUpperCase(),
      value,
    ),
    chord: rootNames[column] + ["", "m", "7"][row],
    shifted: value === ";" ? ":" : value === "/" ? "?" : "",
  }));
const rows = [
  [
    key("Backquote", "~\n`"),
    ...[..."1234567890"].map((value, i) =>
      key(
        `Digit${value}`,
        ["!", "@", "#", "$", "%", "^", "&", "*", "(", ")"][i] + "\n" + value,
        value,
      ),
    ),
    key("Minus", "_\n−", "-"),
    key("Equal", "+\n=", "=", 1, "+"),
    key("Backspace", "backspace", "", 2.25),
  ],
  [
    key("Tab", "tab", "", 1.5),
    ...letterKeys(0),
    key("BracketLeft", "{\n["),
    key("BracketRight", "}\n]"),
    key("Backslash", "|\n\\", "", 1.75),
  ],
  [
    key("CapsLock", "caps lock", "", 1.8),
    ...letterKeys(1),
    key("Quote", "\"\n'"),
    key("Enter", "return", "", 2.45),
  ],
  [
    key("ShiftLeft", "shift", "", 2.2),
    ...letterKeys(2),
    key("ShiftRight", "shift", "", 2.05),
    key("PageUp", "PgUp"),
  ],
  [
    key("Space", "space", " ", 11.25),
    key("Home", "Home"),
    key("PageDown", "PgDn"),
    key("End", "End"),
  ],
];

export function mountKeyboard({
  chordDown,
  chordUp,
  strum,
  stop,
  visibilityChanged,
}) {
  const panel = document.querySelector("#keyboardOverlay");
  const board = document.querySelector("#computerKeyboard");
  const toggle = document.querySelector("#keyboardToggle");
  const buttons = new Map(),
    sources = new Map(),
    pointers = new Map();
  let open = false;
  const highlight = (code, source, active) => {
    const held = sources.get(code) || new Set();
    if (active) held.add(source);
    else held.delete(source);
    if (held.size) sources.set(code, held);
    else sources.delete(code);
    const button = buttons.get(code);
    button?.classList.toggle("key-active", held.size > 0);
    button?.setAttribute("aria-pressed", String(held.size > 0));
  };
  const down = (definition, id, shifted) => {
    const value =
      shifted && definition.shifted ? definition.shifted : definition.value;
    const chord = chordForKey(value);
    if (chord) chordDown(id, chord);
    else if (strumIndex(value) >= 0) strum(strumIndex(value));
    else if (definition.code === "Space") stop();
  };
  for (const row of rows) {
    const host = document.createElement("div");
    host.className = "computer-key-row";
    for (const definition of row) {
      const button = document.createElement("button");
      button.type = "button";
      button.className =
        "computer-key" + (definition.chord ? " mapped-key" : "");
      button.style.setProperty("--key-width", definition.width);
      button.dataset.code = definition.code;
      button.setAttribute("aria-pressed", "false");
      button.setAttribute(
        "aria-label",
        `${definition.label.replaceAll("\n", " ")}${definition.chord ? `: ${definition.chord}` : definition.code === "Space" ? ": all notes off" : ""}`,
      );
      const label = document.createElement("span");
      label.className = "key-label";
      label.textContent = definition.label;
      button.append(label);
      if (definition.chord) {
        const chord = document.createElement("small");
        chord.textContent = definition.chord;
        button.append(chord);
      }
      buttons.set(definition.code, button);
      button.addEventListener("pointerdown", (event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        button.setPointerCapture(event.pointerId);
        const id = `virtual-${event.pointerId}`;
        pointers.set(event.pointerId, {
          code: definition.code,
          id,
          chord: !!definition.chord,
        });
        highlight(definition.code, id, true);
        down(
          definition,
          id,
          event.shiftKey ||
            sources.has("ShiftLeft") ||
            sources.has("ShiftRight"),
        );
      });
      const release = (event) => {
        const held = pointers.get(event.pointerId);
        if (!held) return;
        pointers.delete(event.pointerId);
        highlight(held.code, held.id, false);
        if (held.chord) chordUp(held.id);
      };
      for (const type of ["pointerup", "pointercancel", "lostpointercapture"])
        button.addEventListener(type, release);
      button.addEventListener("click", (event) => {
        if (event.detail !== 0) return;
        const id = `accessible-${definition.code}`;
        highlight(definition.code, id, true);
        down(definition, id, event.shiftKey);
        setTimeout(() => {
          if (definition.chord) chordUp(id);
          highlight(definition.code, id, false);
        }, 150);
      });
      host.append(button);
    }
    board.append(host);
  }
  function releasePointers() {
    for (const held of pointers.values()) {
      if (held.chord) chordUp(held.id);
      highlight(held.code, held.id, false);
    }
    pointers.clear();
  }
  const clearHighlights = () => {
    releasePointers();
    sources.clear();
    for (const button of buttons.values()) {
      button.classList.remove("key-active");
      button.setAttribute("aria-pressed", "false");
    }
  };
  function show(value) {
    open = value;
    if (!open) {
      releasePointers();
      if (panel.contains(document.activeElement)) toggle.focus();
    }
    panel.inert = !open;
    panel.setAttribute("aria-hidden", String(!open));
    toggle.setAttribute("aria-expanded", String(open));
    toggle.setAttribute("aria-pressed", String(open));
    document.body.classList.toggle("keyboard-open", open);
    visibilityChanged();
  }
  toggle.addEventListener("click", () => show(!open));
  window.addEventListener("keydown", (event) =>
    highlight(event.code, `physical-${event.code}`, true),
  );
  window.addEventListener("keyup", (event) =>
    highlight(event.code, `physical-${event.code}`, false),
  );
  window.addEventListener("blur", clearHighlights);
  window.addEventListener("keydown", (event) => {
    if (
      event.key === "Escape" &&
      open &&
      document.querySelector("#helpPanel").hidden
    )
      show(false);
  });
  const observer = new ResizeObserver(() => {
    document.documentElement.style.setProperty(
      "--keyboard-height",
      `${Math.ceil(panel.getBoundingClientRect().height)}px`,
    );
    visibilityChanged();
  });
  observer.observe(panel);
  return { clearHighlights, show };
}
