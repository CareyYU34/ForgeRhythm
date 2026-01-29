let player;
let duration = 0;
let lastVolume = 100;

let seekBar;
let volumeSlier; // 你原本就叫這個（雖然拼字怪，但先不改大）

// ====== 入口：YouTube Iframe API 會呼叫這個 ======
function onYouTubeIframeAPIReady() {
  const ytPanel = document.getElementById("ytPanel");
  const ytUrl = document.getElementById("ytUrl");
  const ytLoadBtn = document.getElementById("ytLoadBtn");

  // 進來先隱藏（保險：就算你HTML漏加 is-hidden 也會隱藏）
  ytPanel.classList.add("is-hidden");

  // 按下載入：解析連結→建立/切換影片→顯示面板
  ytLoadBtn.addEventListener("click", () => {
    const url = ytUrl.value.trim();
    const id = extractYouTubeId(url);
    if (!id) {
      alert("無法解析 YouTube 連結，請貼上 watch?v=... 或 youtu.be/... 的網址");
      return;
    }

    // 顯示面板
    ytPanel.classList.remove("is-hidden");

    // 第一次才建立 player
    if (!player) {
      createPlayer(id);
    } else {
      player.loadVideoById(id);
    }
  });

  // Enter 也可載入
  ytUrl.addEventListener("keydown", (e) => {
    if (e.key === "Enter") ytLoadBtn.click();
  });
}

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

  // 修 typo：你原本寫 volumdeSlier 會直接噴錯
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

  // 修：你原本監聽 handlePlaybackSpeed 但函式叫 handleSpeedChange
  document
    .getElementById("playbackSpeed")
    .addEventListener("change", handlePlaybackSpeed);

  document
    .getElementById("fullscreenBtn")
    .addEventListener("click", toggleFullscreen);

  setInterval(updateProgress, 250);
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

/** 解析各種YouTube網址 → 11字元 videoId */
function extractYouTubeId(url) {
  if (!url) return null;

  // 允許直接輸入 11 字元 ID
  if (/^[a-zA-Z0-9_-]{11}$/.test(url)) return url;

  try {
    const u = new URL(url);

    // https://www.youtube.com/watch?v=VIDEOID
    const v = u.searchParams.get("v");
    if (v && /^[a-zA-Z0-9_-]{11}$/.test(v)) return v;

    // https://youtu.be/VIDEOID
    if (u.hostname.includes("youtu.be")) {
      const id = u.pathname.split("/").filter(Boolean)[0];
      if (id && /^[a-zA-Z0-9_-]{11}$/.test(id)) return id;
    }

    // /shorts/VIDEOID 或 /embed/VIDEOID
    const parts = u.pathname.split("/").filter(Boolean);
    const idx = parts.findIndex((p) => p === "shorts" || p === "embed");
    if (
      idx !== -1 &&
      parts[idx + 1] &&
      /^[a-zA-Z0-9_-]{11}$/.test(parts[idx + 1])
    ) {
      return parts[idx + 1];
    }
  } catch (_) {}

  return null;
}
