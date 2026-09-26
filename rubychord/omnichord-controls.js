export const ROOTS = [
  "C",
  "C#",
  "D",
  "Eb",
  "E",
  "F",
  "F#",
  "G",
  "Ab",
  "A",
  "Bb",
  "B",
];
export const PANEL_ROOTS = [1, 8, 3, 10, 5, 0, 7, 2, 9, 4, 11, 6];
export const LABELS = [
  "C",
  "D♭",
  "D",
  "E♭",
  "E",
  "F",
  "F♯",
  "G",
  "A♭",
  "A",
  "B♭",
  "B",
];
export const QUALITIES = ["major", "minor", "seventh"];
export const SUFFIX = {
  major: "",
  minor: "m",
  seventh: "7",
  major7: "M7",
  minor7: "m7",
  augmented: "aug",
  diminished: "dim",
  sus4: "sus4",
  add9: "add9",
};
// OM-108 triads: no fifth in seventh chords; diminished uses root/minor third/sixth.
export const INTERVALS = {
  major: [0, 4, 7],
  minor: [0, 3, 7],
  seventh: [0, 4, 10],
  major7: [0, 4, 11],
  minor7: [0, 3, 10],
  augmented: [0, 4, 8],
  diminished: [0, 3, 9],
  sus4: [0, 5, 7],
  add9: [0, 2, 7],
};
export const VOICES = [
  "omni1",
  "omni2",
  "harp",
  "celeste",
  "A.piano",
  "guitar",
  "FM piano",
  "organ",
  "vibes",
  "banjo",
];
export const PATTERNS = [
  "rock1",
  "rock2",
  "slow rock",
  "country",
  "swing",
  "disco",
  "hip hop",
  "funk",
  "bossanova",
  "waltz",
];
export function resolveChord(buttons) {
  if (!buttons.length) return null;
  const major = buttons.find((b) => b.quality === "major");
  if (major) {
    const fourth = (major.root + 5) % 12;
    if (buttons.some((b) => b.root === fourth && b.quality === "seventh"))
      return { root: major.root, quality: "sus4" };
    if (buttons.some((b) => b.root === fourth && b.quality === "minor"))
      return { root: major.root, quality: "add9" };
  }
  const root = buttons[buttons.length - 1].root;
  const q = new Set(
    buttons.filter((b) => b.root === root).map((b) => b.quality),
  );
  return {
    root,
    quality:
      q.size === 3
        ? "augmented"
        : q.has("major") && q.has("minor")
          ? "diminished"
          : q.has("major") && q.has("seventh")
            ? "major7"
            : q.has("minor") && q.has("seventh")
              ? "minor7"
              : [...q][0],
  };
}
// Manual p49: root/third/fifth within F#3–F4, repeated across four octaves.
// This deliberately preserves the inversion (e.g. C4,E4,G3), not an ascending C scale.
export function strumNotes(root, quality) {
  const base = INTERVALS[quality].map((n) => 54 + ((root + n - 6 + 12) % 12));
  return Array.from(
    { length: 13 },
    (_, i) => base[i % 3] + Math.floor(i / 3) * 12,
  );
}
export function chordButtons() {
  return QUALITIES.flatMap((quality, row) =>
    (row === 0 ? PANEL_ROOTS : [6, ...PANEL_ROOTS]).map((root, column) => ({
      root,
      quality,
      row,
      column,
    })),
  );
}
