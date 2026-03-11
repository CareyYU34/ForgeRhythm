let player;
let duration = 0;
let lastVolume = 100;

let seekBar;
let volumeSlier;
let progressTimer = null;
let isYouTubeApiReady = false;

function createPlayer(videoId) {
  player = new YT.Player('player', {
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
  document.getElementById('duration').textContent = formatTime(duration);

  seekBar = document.getElementById('seekBar');
  volumeSlier = document.getElementById('volumeSlider');

  volumeSlier.value = player.getVolume();

  updateSilderFill(seekBar);
  updateSilderFill(volumeSlier);

  document.getElementById('playPauseBtn').addEventListener('click', togglePlayPause);
  document.getElementById('overlayPlay').addEventListener('click', togglePlayPause);
  document.getElementById('muteBtn').addEventListener('click', toggleMute);

  volumeSlier.addEventListener('input', handleVolume);
  seekBar.addEventListener('input', handleSeek);

  document
    .getElementById('playbackSpeed')
    .addEventListener('change', handlePlaybackSpeed);

  document
    .getElementById('fullscreenBtn')
    .addEventListener('click', toggleFullscreen);

  if (progressTimer) clearInterval(progressTimer);
  progressTimer = setInterval(updateProgress, 250);
}

function togglePlayPause() {
  const state = player.getPlayerState();
  const overlay = document.getElementById('overlayPlay');
  const btn = document.getElementById('playPauseBtn');

  if (state === YT.PlayerState.PLAYING) {
    player.pauseVideo();
    overlay.style.display = 'flex';
    btn.innerHTML = '<i class="fas fa-play"></i>';
  } else {
    player.playVideo();
    overlay.style.display = 'none';
    btn.innerHTML = '<i class="fas fa-pause"></i>';
  }
}

function toggleMute() {
  const btn = document.getElementById('muteBtn');
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
    document.getElementById('muteBtn').innerHTML =
      '<i class="fas fa-volume-xmark"></i>';
  } else {
    player.unMute();
    player.setVolume(newVolume);
    document.getElementById('muteBtn').innerHTML =
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
  const elem = document.querySelector('.video-wrapper');
  const btn = document.getElementById('fullscreenBtn');

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
  document.getElementById('currentTime').textContent = formatTime(current);
  seekBar.value = (current / duration) * 100;
  updateSilderFill(seekBar);
}

function updateSilderFill(slider) {
  const percentage =
    ((slider.value - slider.min) / (slider.max - slider.min)) * 100;
  slider.style.background = `linear-gradient(to right, #f90000 ${percentage}%, rgba(255, 255, 255, 0.1) ${percentage}%)`;
}

function onPlayerStateChange(event) {
  const playPauseBtn = document.getElementById('playPauseBtn');
  const overlayPlay = document.getElementById('overlayPlay');

  if (event.data === YT.PlayerState.PLAYING) {
    playPauseBtn.innerHTML = '<i class="fas fa-pause"></i>';
    overlayPlay.style.display = 'none';
  } else if (event.data === YT.PlayerState.PAUSED) {
    playPauseBtn.innerHTML = '<i class="fas fa-play"></i>';
    overlayPlay.style.display = 'flex';
  }
}

function formatTime(seconds) {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60)
    .toString()
    .padStart(2, '0');
  return `${mins}:${secs}`;
}

function extractYouTubeId(url) {
  if (!url) return null;

  if (/^[a-zA-Z0-9_-]{11}$/.test(url)) return url;

  try {
    const u = new URL(url);

    const v = u.searchParams.get('v');
    if (v && /^[a-zA-Z0-9_-]{11}$/.test(v)) return v;

    if (u.hostname.includes('youtu.be')) {
      const id = u.pathname.split('/').filter(Boolean)[0];
      if (id && /^[a-zA-Z0-9_-]{11}$/.test(id)) return id;
    }

    const parts = u.pathname.split('/').filter(Boolean);
    const idx = parts.findIndex((p) => p === 'shorts' || p === 'embed');
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
  const ytPanel = document.getElementById('ytPanel');
  const ytUrl = document.getElementById('ytUrl');
  const ytLoadBtn = document.getElementById('ytLoadBtn');

  ytPanel.classList.add('is-hidden');

  ytLoadBtn.addEventListener('click', () => {
    if (!isYouTubeApiReady) {
      alert('YouTube 播放器仍在載入，請稍後再試。');
      return;
    }

    const url = ytUrl.value.trim();
    const id = extractYouTubeId(url);

    if (!id) {
      alert('請輸入有效的 YouTube 連結，例如 watch?v=... 或 youtu.be/...');
      return;
    }

    ytPanel.classList.remove('is-hidden');

    if (!player) {
      createPlayer(id);
    } else {
      player.loadVideoById(id);
    }
  });

  ytUrl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') ytLoadBtn.click();
  });
}

function loadYouTubeIframeApi() {
  if (window.YT && typeof window.YT.Player === 'function') {
    if (typeof window.onYouTubeIframeAPIReady === 'function') {
      window.onYouTubeIframeAPIReady();
    }
    return;
  }

  if (document.querySelector('script[data-yt-iframe-api]')) {
    return;
  }

  const script = document.createElement('script');
  script.src = 'https://www.youtube.com/iframe_api';
  script.async = true;
  script.dataset.ytIframeApi = 'true';
  document.head.appendChild(script);
}

export function initYouTube() {
  bindInputControls();
  window.onYouTubeIframeAPIReady = () => {
    isYouTubeApiReady = true;
  };
  if (window.YT && typeof window.YT.Player === 'function') {
    isYouTubeApiReady = true;
  }
  loadYouTubeIframeApi();
}
