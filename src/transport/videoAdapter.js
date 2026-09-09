/**
 * transport/videoAdapter.js
 *
 * 把 <video id="songVideo"> 包成統一的 transport 介面。
 *
 * ═══ 介面（規格書 §5.2）═══
 *
 *   kind / play / pause / isPlaying / getCurrentTime / getDuration /
 *   seekTo / setVolume / getVolume / mute / unMute / isMuted /
 *   setPlaybackRate / getPlaybackRate / supportsRate / destroy / on
 *
 *   額外提供 load(url) —— songSession 需要等 loadedmetadata 才能建立版面。
 *
 * ═══ 兩個容易踩的點 ═══
 *
 * 1. "playing" 綁的是 video 的 playing 事件，不是 play。
 *    play 只代表「呼叫了播放」，playing 才是播放真正開始的時刻，
 *    也自然涵蓋 seek 後恢復與緩衝回復。引導音的錨定必須綁在後者。
 *
 * 2. supportsRate = true（變速已支援）。
 *    對齊本身不受倍速影響 —— getCurrentTime() 回傳的是「媒體時間」
 *    （video.currentTime），譜面 onset、syncBlock、barGrid、HUD 全在
 *    同一條媒體時間軸上比較，倍速只改變它前進的快慢，不改變刻度。
 *    唯一需要換算的是 cueTrack 把「媒體時間差」排到 AudioContext 牆鐘
 *    的那一步：媒體時間差 Δ 在 r 倍速下只佔 Δ / r 的牆鐘時間，
 *    故 cueTrack.anchor() 會除以 getPlaybackRate()。
 *    "ratechange" 事件讓 songSession 在前奏 count-in 期間變速時重新錨定。
 */

export function createVideoAdapter({ videoEl }) {
  /** @type {Map<string, Set<Function>>} */
  const handlers = new Map();
  /** 實際掛在 DOM 上的原生監聽器，destroy 時要逐一移除 */
  const nativeBindings = [];
  let destroyed = false;

  function emit(event) {
    const set = handlers.get(event);
    if (!set) return;
    for (const cb of set) {
      try {
        cb();
      } catch (err) {
        console.error(`[videoAdapter] ${event} handler error:`, err);
      }
    }
  }

  function bindNative(event, fn) {
    videoEl.addEventListener(event, fn);
    nativeBindings.push([event, fn]);
  }

  // 原生事件 → 統一事件
  bindNative("playing", () => emit("playing"));
  bindNative("pause", () => emit("pause"));
  bindNative("seeking", () => emit("seeking"));
  bindNative("ended", () => emit("ended"));
  bindNative("ratechange", () => emit("ratechange"));

  return {
    kind: "local",
    supportsRate: true,

    /**
     * 設定來源並等到 metadata 就緒。
     *
     * ⚠ 必須等 loadedmetadata，否則 getDuration() 會是 NaN，
     *   進度條與時間顯示會在第一秒閃爛。
     */
    load(url) {
      return new Promise((resolve, reject) => {
        const onMeta = () => {
          cleanup();
          resolve();
        };
        const onErr = () => {
          cleanup();
          reject(new Error("影片載入失敗，請確認檔名與路徑"));
        };
        const cleanup = () => {
          videoEl.removeEventListener("loadedmetadata", onMeta);
          videoEl.removeEventListener("error", onErr);
        };
        videoEl.addEventListener("loadedmetadata", onMeta);
        videoEl.addEventListener("error", onErr);
        // ⚠ 中文 / 空格檔名必須 encodeURI
        videoEl.src = encodeURI(url);
        videoEl.load();
      });
    },

    on(event, cb) {
      if (!handlers.has(event)) handlers.set(event, new Set());
      handlers.get(event).add(cb);
    },

    play() {
      if (destroyed) return;
      videoEl.play().catch((err) => {
        console.warn("[videoAdapter] play rejected:", err.message);
      });
    },

    pause() {
      if (!destroyed) videoEl.pause();
    },

    isPlaying() {
      return !destroyed && !videoEl.paused && !videoEl.ended;
    },

    getCurrentTime() {
      return destroyed ? 0 : videoEl.currentTime;
    },

    getDuration() {
      if (destroyed) return 0;
      return Number.isFinite(videoEl.duration) ? videoEl.duration : 0;
    },

    seekTo(sec) {
      if (!destroyed) videoEl.currentTime = sec;
    },

    setVolume(v) {
      if (destroyed) return;
      videoEl.volume = Math.min(1, Math.max(0, v / 100));
      if (v > 0) videoEl.muted = false;
    },

    getVolume() {
      return destroyed ? 0 : Math.round(videoEl.volume * 100);
    },

    mute() {
      if (!destroyed) videoEl.muted = true;
    },

    unMute() {
      if (!destroyed) videoEl.muted = false;
    },

    isMuted() {
      return destroyed ? false : videoEl.muted;
    },

    /**
     * 設定播放倍速。
     *
     * ⚠ 同時寫 defaultPlaybackRate —— 否則之後任何 load()／換 src
     *   都會把 playbackRate 重置回 1.0，使用者選的倍速會無聲無息失效。
     */
    setPlaybackRate(r) {
      if (destroyed) return;
      const rate = Number(r);
      if (!Number.isFinite(rate) || rate <= 0) return;
      videoEl.defaultPlaybackRate = rate;
      videoEl.playbackRate = rate;
    },

    getPlaybackRate() {
      return destroyed ? 1 : videoEl.playbackRate;
    },

    destroy() {
      if (destroyed) return;
      destroyed = true;

      // ⚠ 先移除監聽器再清 src。
      //   removeAttribute + load() 會觸發 emptied / error，
      //   若監聽器還在會誤觸發 exit 流程。
      for (const [event, fn] of nativeBindings) {
        videoEl.removeEventListener(event, fn);
      }
      nativeBindings.length = 0;
      handlers.clear();

      try {
        videoEl.pause();
        videoEl.removeAttribute("src");
        videoEl.load();
      } catch {
        /* 已卸載 */
      }
    },
  };
}
