export const SOUND_LIBRARY = [
  {
    id: "snare",
    label: "小鼓 Snare",
    url: "./sounds/38_Standard Snare 1_v1.wav",
  },
  {
    id: "kick",
    label: "大鼓 Kick",
    url: "./sounds/36_Standard Kick 3.wav",
  },
  {
    id: "hihat",
    label: "Hi-hat",
    url: "./sounds/42_Hi-Hat Closed Soft.wav",
  },
];

export const ZONES = [
  { id: "outer", label: "大腿外側" },
  { id: "front", label: "大腿正面" },
  // { id: "inner", label: "大腿內側" },
  { id: "heel", label: "腳跟" },
];

export function createDefaultZoneSound() {
  const zoneSound = {};
  for (const side of ["left", "right"]) {
    for (const z of ZONES) {
      const key = `${side}_${z.id}`;
      if (z.id === "front") zoneSound[key] = "hihat";
      if (z.id === "outer") zoneSound[key] = "snare";
      if (z.id === "inner") zoneSound[key] = "kick";
      if (z.id === "heel") zoneSound[key] = "kick";
    }
  }
  return zoneSound;
}

export function createAudioEngine(soundLibrary = SOUND_LIBRARY) {
  let audioCtx = null;
  const buffers = new Map();
  let masterGain = null;

  async function loadBuffer(id, url) {
    const res = await fetch(url);
    const arr = await res.arrayBuffer();
    const buf = await audioCtx.decodeAudioData(arr);
    buffers.set(id, buf);
  }

  async function initAudio() {
    if (!audioCtx) {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)({
        latencyHint: "interactive",
      });
      masterGain = audioCtx.createGain();
      masterGain.gain.value = 1; //fallback value
      masterGain.connect(audioCtx.destination);
    }

    if (audioCtx.state === "suspended") {
      await audioCtx.resume().catch(() => {});
    }

    await Promise.all(soundLibrary.map((s) => loadBuffer(s.id, s.url)));
  }

  function playZone(side, zoneId, zoneSound) {
    if (!audioCtx || !masterGain) return;
    const key = `${side}_${zoneId}`;
    const id = zoneSound[key];
    const buf = buffers.get(id);
    if (!buf) return;

    const src = audioCtx.createBufferSource();
    src.buffer = buf;
    src.connect(masterGain);
    src.start(audioCtx.currentTime);
  }

  function setOutputVolume(gainValue = 1) {
    if (!masterGain) return;
    masterGain.gain.value = Math.max(0, gainValue);
  }

  return { initAudio, playZone, setOutputVolume };
}
