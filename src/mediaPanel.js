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

let player;
let duration = 0;
let lastVolume = 100;

let seekBar;
let volumeSlier;
let progressTimer = null;
let isYouTubeApiReady = false;

function createPlayer(videoId) {
  player = new YT.Player("player", {
    videoId,
    playerVars: {
      controls: 0,
      modestbranding: 0,
      rel: 0,
      showinfo: 0,
    },
    events: {
      onReady: onPlayerReady,
      onStateChange: onPlayerStateChange,
    },
  });
}

function onPlayerReady() {
  duration = player.getDuration();
  document.getElementById("duration").textContent = formatTime(duration);

  seekBar = document.getElementById("seekBar");
  volumeSlier = document.getElementById("volumeSlider");

  volumeSlier.value = player.getVolume();

  updateSilderFill(seekBar);
  updateSilderFill(volumeSlier);

  document
    .getElementById("playPauseBtn")
    .addEventListener("click", togglePlayPause);
  document
    .getElementById("overlayPlay")
    .addEventListener("click", togglePlayPause);
  document.getElementById("muteBtn").addEventListener("click", toggleMute);

  volumeSlier.addEventListener("input", handleVolume);
  seekBar.addEventListener("input", handleSeek);

  document
    .getElementById("playbackSpeed")
    .addEventListener("change", handlePlaybackSpeed);

  document
    .getElementById("fullscreenBtn")
    .addEventListener("click", toggleFullscreen);

  if (progressTimer) clearInterval(progressTimer);
  progressTimer = setInterval(updateProgress, 250);
}

function togglePlayPause() {
  const state = player.getPlayerState();
  const overlay = document.getElementById("overlayPlay");
  const btn = document.getElementById("playPauseBtn");

  if (state === YT.PlayerState.PLAYING) {
    player.pauseVideo();
    overlay.style.display = "flex";
    btn.innerHTML = '<i class="fas fa-play"></i>';
  } else {
    player.playVideo();
    overlay.style.display = "none";
    btn.innerHTML = '<i class="fas fa-pause"></i>';
  }
}

function toggleMute() {
  const btn = document.getElementById("muteBtn");
  if (player.isMuted()) {
    player.unMute();
    btn.innerHTML = '<i class="fas fa-volume-high"></i>';
    volumeSlier.value = lastVolume;
    player.setVolume(lastVolume);
  } else {
    lastVolume = player.getVolume();
    player.mute();
    btn.innerHTML = '<i class="fas fa-volume-xmark"></i>';
    volumeSlier.value = 0;
  }
  updateSilderFill(volumeSlier);
}

function handleVolume(e) {
  const newVolume = parseInt(e.target.value, 10);
  if (newVolume === 0) {
    player.mute();
    document.getElementById("muteBtn").innerHTML =
      '<i class="fas fa-volume-xmark"></i>';
  } else {
    player.unMute();
    player.setVolume(newVolume);
    document.getElementById("muteBtn").innerHTML =
      '<i class="fas fa-volume-high"></i>';
  }
  lastVolume = newVolume;
  updateSilderFill(volumeSlier);
}

function handleSeek(e) {
  if (!duration) return;
  player.seekTo((e.target.value / 100) * duration, true);
  updateSilderFill(seekBar);
}

function handlePlaybackSpeed(e) {
  player.setPlaybackRate(parseFloat(e.target.value));
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
  if (!player || !duration) return;
  const current = player.getCurrentTime();
  document.getElementById("currentTime").textContent = formatTime(current);
  seekBar.value = (current / duration) * 100;
  updateSilderFill(seekBar);
}

function updateSilderFill(slider) {
  const percentage =
    ((slider.value - slider.min) / (slider.max - slider.min)) * 100;
  slider.style.background = `linear-gradient(to right, #f90000 ${percentage}%, rgba(255, 255, 255, 0.1) ${percentage}%)`;
}

function onPlayerStateChange(event) {
  const playPauseBtn = document.getElementById("playPauseBtn");
  const overlayPlay = document.getElementById("overlayPlay");

  if (event.data === YT.PlayerState.PLAYING) {
    playPauseBtn.innerHTML = '<i class="fas fa-pause"></i>';
    overlayPlay.style.display = "none";
  } else if (event.data === YT.PlayerState.PAUSED) {
    playPauseBtn.innerHTML = '<i class="fas fa-play"></i>';
    overlayPlay.style.display = "flex";
  }
}

function formatTime(seconds) {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60)
    .toString()
    .padStart(2, "0");
  return `${mins}:${secs}`;
}

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

function bindInputControls() {
  const ytPanel = document.getElementById("ytPanel");
  const ytUrl = document.getElementById("ytUrl");
  const ytLoadBtn = document.getElementById("ytLoadBtn");

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

    ytPanel.classList.remove("is-hidden");

    if (!player) {
      createPlayer(id);
    } else {
      player.loadVideoById(id);
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

export function initYouTube() {
  bindInputControls();
  window.onYouTubeIframeAPIReady = () => {
    isYouTubeApiReady = true;
  };
  if (window.YT && typeof window.YT.Player === "function") {
    isYouTubeApiReady = true;
  }
  loadYouTubeIframeApi();
}