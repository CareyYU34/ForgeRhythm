/**
 * transport/ytAdapter.js
 *
 * 把 YT.Player 包成與 videoAdapter 相同的 transport 介面。
 *
 * ═══ 為什麼要包（規格書 §5.1）═══
 *
 * 原本的 mediaPanel 把 controls-bar 的事件監聽器綁在 onPlayerReady() 內。
 * player 只建立一次時沒問題，但歌曲模式要 destroy 並重建 YT player，
 * onPlayerReady 會再跑一次 → playPauseBtn 被重複 addEventListener
 * → 按一下觸發兩次 toggle。
 *
 * 抽成 adapter 之後，controls-bar 只綁一次事件並指向 activeTransport，
 * 切換播放器就是換 adapter 實例，DOM 與監聽器都不動。
 *
 * ═══ destroy 的陷阱 ═══
 *
 * ⚠ YT.Player 會用 iframe「取代」你給它的 div。
 *   destroy() 之後那個 div 就不存在了，直接再 new 一次會失敗。
 *   因此本 adapter 接收的是「宿主容器」，每次建立時自己生一個新的子 div。
 */

let seq = 0;

export function createYtAdapter({ hostEl, videoId }) {
  /** @type {Map<string, Set<Function>>} */
  const handlers = new Map();
  let player = null;
  let ready = false;
  let destroyed = false;

  /** ready 之前收到的音量設定，ready 後補套用 */
  let pendingVolume = null;

  function emit(event) {
    const set = handlers.get(event);
    if (!set) return;
    for (const cb of set) {
      try {
        cb();
      } catch (err) {
        console.error(`[ytAdapter] ${event} handler error:`, err);
      }
    }
  }

  // ⚠ 每次都建立全新的子 div。destroy 後舊的已被 iframe 取代並移除。
  hostEl.replaceChildren();
  const mount = document.createElement("div");
  mount.className = "player";
  mount.id = `ytPlayer_${++seq}`;
  hostEl.appendChild(mount);

  player = new YT.Player(mount.id, {
    videoId,
    playerVars: {
      controls: 0,
      modestbranding: 0,
      rel: 0,
      showinfo: 0,
    },
    events: {
      onReady: () => {
        if (destroyed) return;
        ready = true;
        if (pendingVolume !== null) {
          player.setVolume(pendingVolume);
          pendingVolume = null;
        }
        emit("ready");
      },
      onStateChange: (e) => {
        if (destroyed) return;
        if (e.data === YT.PlayerState.PLAYING) emit("playing");
        else if (e.data === YT.PlayerState.PAUSED) emit("pause");
        else if (e.data === YT.PlayerState.ENDED) emit("ended");
      },
    },
  });

  const alive = () => !destroyed && ready && player;

  return {
    kind: "youtube",
    supportsRate: true,

    on(event, cb) {
      if (!handlers.has(event)) handlers.set(event, new Set());
      handlers.get(event).add(cb);
    },

    loadVideoById(id) {
      if (alive()) player.loadVideoById(id);
    },

    play() {
      if (alive()) player.playVideo();
    },

    pause() {
      if (alive()) player.pauseVideo();
    },

    isPlaying() {
      return alive() && player.getPlayerState() === YT.PlayerState.PLAYING;
    },

    getCurrentTime() {
      return alive() ? player.getCurrentTime() : 0;
    },

    getDuration() {
      return alive() ? player.getDuration() : 0;
    },

    seekTo(sec) {
      if (alive()) player.seekTo(sec, true);
    },

    setVolume(v) {
      if (alive()) {
        player.setVolume(v);
        if (v > 0) player.unMute();
      } else {
        pendingVolume = v;
      }
    },

    getVolume() {
      return alive() ? player.getVolume() : (pendingVolume ?? 100);
    },

    mute() {
      if (alive()) player.mute();
    },

    unMute() {
      if (alive()) player.unMute();
    },

    isMuted() {
      return alive() ? player.isMuted() : false;
    },

    setPlaybackRate(r) {
      if (alive()) player.setPlaybackRate(r);
    },

    destroy() {
      if (destroyed) return;
      destroyed = true;
      handlers.clear();
      try {
        player?.destroy();
      } catch {
        /* 已銷毀 */
      }
      player = null;
      hostEl.replaceChildren();
    },
  };
}
