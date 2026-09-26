// Explicit approximation only: missing libraries and the eight unsampled digital voices.
export function synthVoice(
  ctx,
  midi,
  destination,
  velocity,
  when,
  duration,
  voice = "omni1",
) {
  const gain = ctx.createGain(),
    osc = ctx.createOscillator(),
    partial = ctx.createOscillator(),
    mix = ctx.createGain();
  const frequency = 440 * 2 ** ((midi - 69) / 12);
  osc.type =
    voice === "organ" ? "sine" : voice === "banjo" ? "triangle" : "triangle";
  osc.frequency.value = frequency;
  partial.frequency.value = frequency * (voice === "FM piano" ? 3 : 2);
  partial.type = "sine";
  mix.gain.value = voice === "celeste" || voice === "vibes" ? 0.35 : 0.12;
  osc.connect(gain);
  partial.connect(mix);
  mix.connect(gain);
  gain.connect(destination);
  gain.gain.setValueAtTime(0, when);
  gain.gain.linearRampToValueAtTime(velocity * 0.22, when + 0.004);
  if (Number.isFinite(duration))
    gain.gain.exponentialRampToValueAtTime(
      0.00001,
      when + Math.max(0.02, duration),
    );
  osc.start(when);
  partial.start(when);
  const sources = [osc, partial];
  if (Number.isFinite(duration))
    sources.forEach((s) => s.stop(when + duration + 0.02));
  return { gain, sources, extra: [mix] };
}
export function synthDrum(ctx, kind, destination, when, velocity) {
  const duration = kind === "kick" ? 0.2 : 0.09,
    gain = ctx.createGain();
  let source;
  if (kind === "kick") {
    source = ctx.createOscillator();
    source.frequency.setValueAtTime(125, when);
    source.frequency.exponentialRampToValueAtTime(45, when + 0.15);
  } else {
    source = ctx.createBufferSource();
    const b = ctx.createBuffer(
      1,
      Math.ceil(ctx.sampleRate * duration),
      ctx.sampleRate,
    );
    const d = b.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    source.buffer = b;
  }
  gain.gain.setValueAtTime(velocity * 0.15, when);
  gain.gain.exponentialRampToValueAtTime(0.00001, when + duration);
  source.connect(gain);
  gain.connect(destination);
  source.start(when);
  source.stop(when + duration);
  return { gain, sources: [source] };
}
