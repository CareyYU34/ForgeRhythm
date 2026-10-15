/**
 * transport/clockTransport.js
 *
 * 分部模式（partSession）用的「純時鐘」transport —— 沒有影片，時間軸直接
 * 來自 AudioContext 的牆鐘（audioEngine.now）。介面與 videoAdapter / ytAdapter
 * 對齊，所以 mediaPanel 的控制列、songSession 家族的 syncBlock、barGrid、HUD
 * 全部不需要知道「這次沒有影片」。
 *
 * ═══ 介面 ═══
 *
 *   kind / play / pause / isPlaying / getCurrentTime / getDuration /
 *   seekTo / setVolume / getVolume / mute / unMute / isMuted /
 *   setPlaybackRate / getPlaybackRate / supportsRate / destroy / on
 *
 * ═══ 時間模型 ═══
 *
 *   媒體時間（秒）= 播放中：audioNow() - anchor
 *                   暫停中：凍結的 offset
 *
 *   play() 時把 anchor 設成「audioNow() - 要接續的媒體秒數」，於是
 *   getCurrentTime() 立刻連續。這與 videoAdapter 的 video.currentTime
 *   在同一條語意上（媒體時間），syncBlock / barGrid / cueTrack 一律拿它比較。
 *
 * ⚠ supportsRate = false（鎖 1.0）。理由同 videoAdapter 早期版本：
 *   變速會讓 cueTrack 的媒體時間→牆鐘換算複雜化，本模式不需要變速。
 *
 * ⚠ 音量：沒有影片音軌，setVolume/mute 轉呼叫注入的 onVolume（0–1），
 *   由 partSession 接到 audioEngine 的 backingGain。
 */

export function createClockTransport({
  audioNow,
  durationSec = 0,
  initialTime = 0,
  onVolume,
} = {}) {
  /** @type {Map<string, Set<Function>>} */
  const handlers = new Map();
  let destroyed = false;

  let playing = false;
  /** 播放中的錨點：媒體時間 = audioNow() - anchor */
  let anchor = 0;
  /**
   * 暫停 / 尚未開始時凍結的媒體時間（秒）。
   * ⚠ 可為負：分部模式的前導預覽讓時鐘從 origin 之前起跑，
   *   getCurrentTime 於預覽期回傳負值，跨過 0 後接回正式譜面。
   */
  let offset = initialTime;

  let volume = 100; // 0–100，對齊控制列
  let muted = false;

  function emit(event) {
    const set = handlers.get(event);
    if (!set) return;
    for (const cb of set) {
      try {
        cb();
      } catch (err) {
        console.error(`[clockTransport] ${event} handler error:`, err);
      }
    }
  }

  /** 把當前音量（考慮靜音）推到 backingGain */
  function applyVolume() {
    if (typeof onVolume === "function") {
      onVolume(muted ? 0 : Math.min(1, Math.max(0, volume / 100)));
    }
  }

  return {
    kind: "clock",
    supportsRate: false,

    on(event, cb) {
      if (!handlers.has(event)) handlers.set(event, new Set());
      handlers.get(event).add(cb);
    },

    play() {
      if (destroyed || playing) return;
      // 從凍結的 offset 接續：anchor 設成「現在 - 已播秒數」
      anchor = audioNow() - offset;
      playing = true;
      emit("playing");
    },

    pause() {
      if (destroyed || !playing) return;
      offset = audioNow() - anchor; // 凍結當前媒體時間
      playing = false;
      emit("pause");
    },

    isPlaying() {
      return !destroyed && playing;
    },

    getCurrentTime() {
      if (destroyed) return 0;
      return playing ? audioNow() - anchor : offset;
    },

    getDuration() {
      return destroyed ? 0 : durationSec;
    },

    seekTo(sec) {
      if (destroyed) return;
      const t = Math.max(0, Math.min(durationSec || Infinity, Number(sec) || 0));
      offset = t;
      if (playing) anchor = audioNow() - t; // 播放中 seek：重設錨點
      emit("seeking");
    },

    setVolume(v) {
      if (destroyed) return;
      volume = Math.min(100, Math.max(0, Number(v) || 0));
      if (volume > 0) muted = false;
      applyVolume();
    },

    getVolume() {
      return destroyed ? 0 : Math.round(volume);
    },

    mute() {
      if (destroyed) return;
      muted = true;
      applyVolume();
    },

    unMute() {
      if (destroyed) return;
      muted = false;
      applyVolume();
    },

    isMuted() {
      return destroyed ? false : muted;
    },

    // 鎖 1.0：控制列在 supportsRate=false 時會 disable 倍速選單。
    setPlaybackRate() {},
    getPlaybackRate() {
      return 1;
    },

    /** 播放位置抵達尾端時由 partSession 呼叫，統一走 transport 的 ended 事件 */
    signalEnded() {
      if (destroyed) return;
      playing = false;
      emit("ended");
    },

    destroy() {
      if (destroyed) return;
      destroyed = true;
      playing = false;
      handlers.clear();
    },
  };
}
