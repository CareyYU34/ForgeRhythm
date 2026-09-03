/**
 * transport/videoAdapter.js
 *
 * 把 <video id="songVideo"> 包成統一的 transport 介面。
 *
 * ═══ 介面（規格書 §5.2）═══
 *
 *   kind / play / pause / isPlaying / getCurrentTime / getDuration /
 *   seekTo / setVolume / getVolume / mute / unMute / isMuted /
 *   setPlaybackRate / supportsRate / destroy / on
 *
 *   額外提供 load(url) —— songSession 需要等 loadedmetadata 才能建立版面。
 *
 * ═══ 兩個容易踩的點 ═══
 *
 * 1. "playing" 綁的是 video 的 playing 事件，不是 play。
 *    play 只代表「呼叫了播放」，playing 才是播放真正開始的時刻，
 *    也自然涵蓋 seek 後恢復與緩衝回復。引導音的錨定必須綁在後者。
 *
 * 2. supportsRate = false。
 *    第一版鎖 1.0x —— 變速會讓 cueTrack 的 (c.t - t0) / 1000 換算失效，
 *    必須除以 playbackRate。留給 L5。
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

  return {
    kind: "local",
    supportsRate: false,

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

    /** 第一版鎖 1.0x，本方法刻意為空實作 */
    setPlaybackRate() {},

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
