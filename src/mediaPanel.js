/**
 * mediaPanel.js
 *
 * ═══ 本次重構（規格書 §5）═══
 *
 * ⚠ 原本 controls-bar 的所有事件監聽器都綁在 onPlayerReady() 內。
 *   player 只建立一次時沒問題，但歌曲模式要 destroy 並重建 YT player，
 *   onPlayerReady 會再跑一次 → playPauseBtn 被重複 addEventListener
 *   → 按一下觸發兩次 toggle，看起來像沒反應。
 *
 * 改為：
 *   1. bindTransportControls() 在 initYouTube() 時呼叫「一次」
 *   2. 所有 handler 對 activeTransport 操作
 *   3. 切換播放器就是換 adapter 實例，DOM 與監聽器都不動
 *
 * 同時，歌曲模式需要的 getCurrentTime() 從此有統一來源。
 *
 * initMidiLibraryPicker 完全未改動。
 */

import { createYtAdapter } from "./transport/ytAdapter.js";

const MIDI_LIBRARY_API = "https://imuse.ncnu.edu.tw/Midi-library/api";
const SEARCH_DEBOUNCE_MS = 300;

function debounce(fn, delay) {
  let timerId = null;

  return (...args) => {
    window.clearTimeout(timerId);
    timerId = window.setTimeout(() => fn(...args), delay);
  };
}

function buildSearchUrl({ query, category }) {
  const url = new URL(`${MIDI_LIBRARY_API}/midis`);
  url.searchParams.set("page", "1");
  url.searchParams.set("limit", "1000");
  url.searchParams.set("sort", "uploaded_at");
  url.searchParams.set("order", "desc");

  if (query) {
    url.searchParams.set("q", query);
  }

  if (category) {
    url.searchParams.set("category", category);
  }

  return url.toString();
}

function normalizeCategories(payload) {
  if (!payload) return [];

  const source = Array.isArray(payload)
    ? payload
    : Array.isArray(payload.items)
      ? payload.items
      : Array.isArray(payload.data)
        ? payload.data
        : [];

  return source
    .map((item) => {
      if (typeof item === "string") return item.trim();
      if (item && typeof item === "object") {
        return (
          item.name ||
          item.title ||
          item.category ||
          item.categories_text ||
          item.label ||
          ""
        ).trim();
      }
      return "";
    })
    .filter(Boolean);
}

function extractItemCategories(item) {
  const categories = [];

  if (Array.isArray(item.categories)) {
    categories.push(...item.categories);
  }

  if (typeof item.categories_text === "string") {
    categories.push(...item.categories_text.split(/[\u3001,/]/));
  }

  return categories.map((category) => category.trim()).filter(Boolean);
}

function formatSongOption(item) {
  const composer = item.composer ? ` - ${item.composer}` : "";
  return `${item.title || "\u672a\u547d\u540d\u6b4c\u66f2"}${composer}`;
}

function renderCategoryOptions(selectEl, categories, selectedValue) {
  selectEl.replaceChildren();

  const defaultOption = document.createElement("option");
  defaultOption.value = "";
  defaultOption.textContent = "\u5168\u90e8\u985e\u5225";
  selectEl.append(defaultOption);

  categories.forEach((category) => {
    const option = document.createElement("option");
    option.value = category;
    option.textContent = category;
    option.selected = category === selectedValue;
    selectEl.append(option);
  });
}

function renderSongOptions(
  selectEl,
  items,
  placeholder = "\u8acb\u9078\u64c7\u6b4c\u66f2",
) {
  selectEl.replaceChildren();

  const defaultOption = document.createElement("option");
  defaultOption.value = "";
  defaultOption.textContent = placeholder;
  selectEl.append(defaultOption);

  items.forEach((item) => {
    const option = document.createElement("option");
    option.value = item.id;
    option.textContent = formatSongOption(item);
    selectEl.append(option);
  });
}

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
    },
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  return response.json();
}

export function initMidiLibraryPicker() {
  const songQueryEl = document.getElementById("midiSongQuery");
  const categoryEl = document.getElementById("midiCategory");
  const songSelectEl = document.getElementById("midiSongSelect");
  const ytUrlEl = document.getElementById("ytUrl");

  if (!songQueryEl || !categoryEl || !songSelectEl || !ytUrlEl) {
    return;
  }

  const state = {
    items: [],
    categorySet: new Set(),
    requestToken: 0,
  };

  const syncCategoriesFromItems = (items) => {
    items.forEach((item) => {
      extractItemCategories(item).forEach((category) =>
        state.categorySet.add(category),
      );
    });

    const sortedCategories = [...state.categorySet].sort((a, b) =>
      a.localeCompare(b, "zh-Hant"),
    );
    renderCategoryOptions(categoryEl, sortedCategories, categoryEl.value);
  };

  const searchSongs = async () => {
    const currentToken = ++state.requestToken;
    const query = songQueryEl.value.trim();
    const category = categoryEl.value.trim();

    songSelectEl.disabled = true;
    renderSongOptions(songSelectEl, [], "\u641c\u5c0b\u4e2d...");

    try {
      const payload = await fetchJson(buildSearchUrl({ query, category }));

      if (currentToken !== state.requestToken) {
        return;
      }

      state.items = Array.isArray(payload.items) ? payload.items : [];
      syncCategoriesFromItems(state.items);
      renderSongOptions(
        songSelectEl,
        state.items,
        state.items.length
          ? "\u8acb\u9078\u64c7 API \u6b4c\u66f2"
          : "\u627e\u4e0d\u5230\u7b26\u5408\u689d\u4ef6\u7684\u6b4c\u66f2",
      );
      songSelectEl.disabled = state.items.length === 0;
    } catch (error) {
      if (currentToken !== state.requestToken) {
        return;
      }

      state.items = [];
      renderSongOptions(songSelectEl, [], "API \u8b80\u53d6\u5931\u6557");
      songSelectEl.disabled = true;
      console.error("Failed to fetch midi library songs:", error);
    }
  };

  const debouncedSearch = debounce(searchSongs, SEARCH_DEBOUNCE_MS);

  const loadCategories = async () => {
    const endpoints = [
      `${MIDI_LIBRARY_API}/categories`,
      `${MIDI_LIBRARY_API}/midis/categories`,
      `${MIDI_LIBRARY_API}/public/categories`,
    ];

    for (const endpoint of endpoints) {
      try {
        const payload = await fetchJson(endpoint);
        const categories = normalizeCategories(payload);

        if (!categories.length) {
          continue;
        }

        categories.forEach((category) => state.categorySet.add(category));
        syncCategoriesFromItems([]);
        return;
      } catch (error) {
        console.warn(`Failed to load categories from ${endpoint}:`, error);
      }
    }
  };

  songQueryEl.addEventListener("input", debouncedSearch);
  categoryEl.addEventListener("change", searchSongs);

  songSelectEl.addEventListener("change", () => {
    const selectedId = songSelectEl.value;
    const selectedSong = state.items.find((item) => item.id === selectedId);

    if (!selectedSong) {
      return;
    }

    ytUrlEl.value = (selectedSong.description || "").trim();
  });

  loadCategories().finally(() => {
    searchSongs();
  });
}

// ─── Transport 管理 ─────────────────────────────────────────────────────────

/**
 * 當前作用中的播放器 adapter。
 *
 * ⚠ 這是 controls-bar 與歌曲模式共同的唯一時間來源。
 *   任何需要 currentTime 的程式碼都應該走 getActiveTransport()，
 *   不要直接摸 YT.Player 或 <video> 元素。
 */
let activeTransport = null;

let lastVolume = 100;
let progressTimer = null;
let controlsBound = false;
let isYouTubeApiReady = false;

export function getActiveTransport() {
  return activeTransport;
}

export function setActiveTransport(transport) {
  activeTransport = transport;

  const speedEl = document.getElementById("playbackSpeed");
  const seekBar = document.getElementById("seekBar");
  const volumeSlider = document.getElementById("volumeSlider");

  // 變速：本機影片第一版鎖 1.0x
  if (speedEl) {
    speedEl.disabled = !transport?.supportsRate;
    if (transport && !transport.supportsRate) speedEl.value = "1";
  }

  if (!transport) {
    if (seekBar) {
      seekBar.value = 0;
      updateSilderFill(seekBar);
    }
    setText("currentTime", "0:00");
    setText("duration", "0:00");
    syncPlayIcon(false);
    return;
  }

  // 把目前 UI 上的音量推給新的 transport（跨播放器保留使用者設定）
  if (volumeSlider) transport.setVolume(Number(volumeSlider.value));

  transport.on("ready", () => {
    setText("duration", formatTime(transport.getDuration()));
  });
  transport.on("playing", () => syncPlayIcon(true));
  transport.on("pause", () => syncPlayIcon(false));
  transport.on("ended", () => syncPlayIcon(false));
}

function setText(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}

function syncPlayIcon(playing) {
  const btn = document.getElementById("playPauseBtn");
  const overlay = document.getElementById("overlayPlay");
  if (btn) {
    btn.innerHTML = playing
      ? '<i class="fas fa-pause"></i>'
      : '<i class="fas fa-play"></i>';
  }
  // 歌曲模式下 songUI 會把 overlay 設成 display:none，
  // 這裡不覆寫它的 none，只在自由模式切換 flex。
  if (overlay && overlay.style.display !== "none") {
    overlay.style.display = playing ? "none" : "flex";
  }
}

function togglePlayPause() {
  if (!activeTransport) return;
  if (activeTransport.isPlaying()) activeTransport.pause();
  else activeTransport.play();
}

function toggleMute() {
  if (!activeTransport) return;
  const btn = document.getElementById("muteBtn");
  const volumeSlider = document.getElementById("volumeSlider");

  if (activeTransport.isMuted()) {
    activeTransport.unMute();
    if (btn) btn.innerHTML = '<i class="fas fa-volume-high"></i>';
    if (volumeSlider) volumeSlider.value = lastVolume;
    activeTransport.setVolume(lastVolume);
  } else {
    lastVolume = activeTransport.getVolume();
    activeTransport.mute();
    if (btn) btn.innerHTML = '<i class="fas fa-volume-xmark"></i>';
    if (volumeSlider) volumeSlider.value = 0;
  }
  if (volumeSlider) updateSilderFill(volumeSlider);
}

function handleVolume(e) {
  const newVolume = parseInt(e.target.value, 10);
  const btn = document.getElementById("muteBtn");

  if (activeTransport) {
    if (newVolume === 0) {
      activeTransport.mute();
      if (btn) btn.innerHTML = '<i class="fas fa-volume-xmark"></i>';
    } else {
      activeTransport.unMute();
      activeTransport.setVolume(newVolume);
      if (btn) btn.innerHTML = '<i class="fas fa-volume-high"></i>';
    }
  }

  lastVolume = newVolume;
  updateSilderFill(e.target);
}

function handleSeek(e) {
  if (!activeTransport) return;
  const duration = activeTransport.getDuration();
  if (!duration) return;
  activeTransport.seekTo((e.target.value / 100) * duration);
  updateSilderFill(e.target);
}

function handlePlaybackSpeed(e) {
  activeTransport?.setPlaybackRate(parseFloat(e.target.value));
}

function toggleFullscreen() {
  const elem = document.querySelector(".video-wrapper");
  const btn = document.getElementById("fullscreenBtn");

  if (!document.fullscreenElement) {
    elem.requestFullscreen().then(() => {
      btn.innerHTML = '<i class="fas fa-compress"></i>';
    });
  } else {
    document.exitFullscreen().then(() => {
      btn.innerHTML = '<i class="fas fa-expand"></i>';
    });
  }
}

function updateProgress() {
  if (!activeTransport) return;
  const duration = activeTransport.getDuration();
  if (!duration) return;

  const current = activeTransport.getCurrentTime();
  const seekBar = document.getElementById("seekBar");

  setText("currentTime", formatTime(current));
  setText("duration", formatTime(duration));

  if (seekBar && !seekBar.dataset.dragging) {
    seekBar.value = (current / duration) * 100;
    updateSilderFill(seekBar);
  }
}

function updateSilderFill(slider) {
  const percentage =
    ((slider.value - slider.min) / (slider.max - slider.min)) * 100;
  slider.style.background = `linear-gradient(to right, #f90000 ${percentage}%, rgba(255, 255, 255, 0.1) ${percentage}%)`;
}

function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60)
    .toString()
    .padStart(2, "0");
  return `${mins}:${secs}`;
}

/**
 * controls-bar 的事件綁定。
 *
 * ⚠ 全程只呼叫一次。這是本次重構的重點 ——
 *   原本綁在 onPlayerReady 內，重建 player 就會重複綁定。
 */
function bindTransportControls() {
  if (controlsBound) return;
  controlsBound = true;

  document
    .getElementById("playPauseBtn")
    ?.addEventListener("click", togglePlayPause);
  document
    .getElementById("overlayPlay")
    ?.addEventListener("click", togglePlayPause);
  document.getElementById("muteBtn")?.addEventListener("click", toggleMute);

  const volumeSlider = document.getElementById("volumeSlider");
  if (volumeSlider) {
    volumeSlider.addEventListener("input", handleVolume);
    updateSilderFill(volumeSlider);
  }

  const seekBar = document.getElementById("seekBar");
  if (seekBar) {
    seekBar.addEventListener("input", handleSeek);
    // 拖曳期間不要被 updateProgress 覆寫
    seekBar.addEventListener("pointerdown", () => {
      seekBar.dataset.dragging = "1";
    });
    const endDrag = () => delete seekBar.dataset.dragging;
    seekBar.addEventListener("pointerup", endDrag);
    seekBar.addEventListener("change", endDrag);
    updateSilderFill(seekBar);
  }

  document
    .getElementById("playbackSpeed")
    ?.addEventListener("change", handlePlaybackSpeed);
  document
    .getElementById("fullscreenBtn")
    ?.addEventListener("click", toggleFullscreen);

  if (progressTimer) clearInterval(progressTimer);
  progressTimer = setInterval(updateProgress, 250);
}

// ─── YouTube ────────────────────────────────────────────────────────────────

function extractYouTubeId(url) {
  if (!url) return null;

  if (/^[a-zA-Z0-9_-]{11}$/.test(url)) return url;

  try {
    const u = new URL(url);

    const v = u.searchParams.get("v");
    if (v && /^[a-zA-Z0-9_-]{11}$/.test(v)) return v;

    if (u.hostname.includes("youtu.be")) {
      const id = u.pathname.split("/").filter(Boolean)[0];
      if (id && /^[a-zA-Z0-9_-]{11}$/.test(id)) return id;
    }

    const parts = u.pathname.split("/").filter(Boolean);
    const idx = parts.findIndex((p) => p === "shorts" || p === "embed");
    if (
      idx !== -1 &&
      parts[idx + 1] &&
      /^[a-zA-Z0-9_-]{11}$/.test(parts[idx + 1])
    ) {
      return parts[idx + 1];
    }
  } catch (_) {
    return null;
  }

  return null;
}

function bindInputControls({ beforeLoad } = {}) {
  const ytPanel = document.getElementById("ytPanel");
  const ytUrl = document.getElementById("ytUrl");
  const ytLoadBtn = document.getElementById("ytLoadBtn");
  const playerHost = document.getElementById("playerHost");

  ytPanel.classList.add("is-hidden");

  ytLoadBtn.addEventListener("click", () => {
    if (!isYouTubeApiReady) {
      alert("YouTube 播放器仍在載入，請稍後再試。");
      return;
    }

    const url = ytUrl.value.trim();
    const id = extractYouTubeId(url);

    if (!id) {
      alert("請輸入有效的 YouTube 連結，例如 watch?v=... 或 youtu.be/...");
      return;
    }

    // 歌曲模式優先度較低：載入 YT 時先退出歌曲模式
    beforeLoad?.();

    ytPanel.classList.remove("is-hidden");
    playerHost.classList.remove("is-hidden");

    const existing = getActiveTransport();
    if (existing && existing.kind === "youtube") {
      existing.loadVideoById(id);
    } else {
      existing?.destroy();
      setActiveTransport(createYtAdapter({ hostEl: playerHost, videoId: id }));
    }
  });

  ytUrl.addEventListener("keydown", (e) => {
    if (e.key === "Enter") ytLoadBtn.click();
  });
}

function loadYouTubeIframeApi() {
  if (window.YT && typeof window.YT.Player === "function") {
    if (typeof window.onYouTubeIframeAPIReady === "function") {
      window.onYouTubeIframeAPIReady();
    }
    return;
  }

  if (document.querySelector("script[data-yt-iframe-api]")) {
    return;
  }

  const script = document.createElement("script");
  script.src = "https://www.youtube.com/iframe_api";
  script.async = true;
  script.dataset.ytIframeApi = "true";
  document.head.appendChild(script);
}

/**
 * @param {Object}   [opts]
 * @param {Function} [opts.beforeLoad] 按下 YT「載入」前呼叫，用來退出歌曲模式
 */
export function initYouTube(opts = {}) {
  bindInputControls(opts);
  bindTransportControls();

  window.onYouTubeIframeAPIReady = () => {
    isYouTubeApiReady = true;
  };
  if (window.YT && typeof window.YT.Player === "function") {
    isYouTubeApiReady = true;
  }
  loadYouTubeIframeApi();
}
