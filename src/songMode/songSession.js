/**
 * songMode/songSession.js
 *
 * 職責：歌曲模式的生命週期。
 *
 * ═══ 狀態機（規格書 §7.1）═══
 *
 *   IDLE ──選歌──> LOADING ──資產就緒──> ARMED ──姿態就緒──> PLAYING ──┐
 *     ^                                                                  │
 *     └─────────── 退出（ended / manual / camera-off / error）───────────┘
 *
 *   IDLE     預設。打擊走自由模式。
 *   LOADING  fetch chart、設 video src、等 loadedmetadata。
 *   ARMED    影片「不播」。HUD 顯示「請站進鏡頭」。輪詢 calibrationProfile。
 *   PLAYING  transport.play()，playing 事件觸發 cueTrack.anchor()。
 *
 * ═══ 就緒閘門 ═══
 *
 * adaptiveMonitor 的冷啟動會在關鍵節點連續可見約 3 秒後自動套上
 * DEFAULT_CALIBRATION_PROFILE。poseLoop 的整段打擊偵測包在
 * if (state.calibrationProfile) 內，所以 profile 為 null 時歌曲模式
 * 會是「有影片有引導音，但打什麼都沒反應」—— 必須擋在播放之前。
 *
 * ═══ 游標歸零 ═══
 *
 * sequencer 在 enter() 時重建，所以退出再重進即從第一顆開始。
 * 這就是本版不做「重置游標」按鈕的原因。
 */

import { TUNING } from "./tuning.js";
import { loadChart } from "./chartLoader.js";
import { createSequencer } from "./sequencer.js";
import { createCueTrack } from "./cueTrack.js";
import { createVideoAdapter } from "../transport/videoAdapter.js";

export const SONG_PHASES = {
  IDLE: "IDLE",
  LOADING: "LOADING",
  ARMED: "ARMED",
  PLAYING: "PLAYING",
};

/**
 * @param {Object}   deps
 * @param {Object}   deps.state        main.js 的共享 state（讀 calibrationProfile）
 * @param {Object}   deps.audio        擴充後的 audioEngine（整個物件）
 * @param {Function} deps.getTransport
 * @param {Function} deps.setTransport
 * @param {Object}   deps.songUI
 * @param {Function} [deps.onNotice]   警告訊息回呼（可選）
 */
export function createSongSession({
  state,
  audio,
  getTransport,
  setTransport,
  songUI,
  onNotice,
}) {
  let phase = SONG_PHASES.IDLE;
  let chart = null;
  let sequencer = null;
  let cueTrack = null;
  let currentSong = null;
  let armTimerId = null;

  function clearArmTimer() {
    if (armTimerId !== null) {
      clearInterval(armTimerId);
      armTimerId = null;
    }
  }

  function notice(msg) {
    if (typeof onNotice === "function") onNotice(msg);
    else if (msg) console.warn("[songSession]", msg);
  }

  function startPlaying() {
    if (phase !== SONG_PHASES.ARMED) return;
    phase = SONG_PHASES.PLAYING;
    songUI.hideWaitingPose();
    getTransport()?.play();
  }

  async function enter(song) {
    // 切歌：先完整退出，避免殘留 transport 與排程
    if (phase !== SONG_PHASES.IDLE) exit("switch");

    phase = SONG_PHASES.LOADING;
    currentSong = song;

    try {
      // ── 1. 譜面 ──
      // ⚠ 檔名雖已改為 ASCII，仍保留 encodeURI 以防日後放中文檔名
      const res = await fetch(encodeURI(song.chart));
      if (!res.ok) throw new Error(`譜面載入失敗（HTTP ${res.status}）`);
      chart = loadChart(await res.json());

      sequencer = createSequencer({ chart });
      // ⚠ 傳 getTransport 函式而非實例 —— 此刻 transport 還沒建立
      cueTrack = createCueTrack({ chart, audio, getTransport });

      if (chart.warnings.length) notice(chart.warnings.join(" "));
      if (!cueTrack.isFeasible()) {
        notice(
          `第一顆音符在 ${(cueTrack.getFirstOnsetMs() / 1000).toFixed(2)} 秒，` +
            `前面塞不下 ${TUNING.CUE_COUNT} 個四分音符，本譜不發引導音。`,
        );
      }

      // ── 2. 版面切換（YT player 在這一步被 destroy）──
      getTransport()?.destroy();
      setTransport(null);
      songUI.enterSongLayout(song.title);

      // ── 3. 影片 ──
      const adapter = createVideoAdapter({ videoEl: songUI.getVideoEl() });
      await adapter.load(song.video);
      setTransport(adapter);

      adapter.on("playing", () => {
        // anchor() 內部會先 cancelScheduled，重複觸發不會重複排程
        cueTrack?.anchor();
      });
      adapter.on("pause", () => {
        // ⚠ 必須取消。AudioContext 的時間軸不會因為影片暫停而停止，
        //   不取消的話暫停後引導音仍會照原定時刻響出來。
        audio.cancelScheduled();
      });
      adapter.on("seeking", () => {
        audio.cancelScheduled();
      });
      adapter.on("ended", () => {
        exit("ended");
      });

      // ── 4. HUD 初始畫面 ──
      songUI.renderCueBeats(cueTrack.getCues(), cueTrack.getQuarterMs());
      songUI.renderRibbon(sequencer);
      songUI.updateCursor(0, sequencer.getTotal());
      songUI.showCuePhase();

      // ── 5. 等待姿態就緒 ──
      phase = SONG_PHASES.ARMED;
      songUI.showWaitingPose();

      if (state.calibrationProfile) {
        startPlaying();
      } else {
        armTimerId = setInterval(() => {
          if (state.calibrationProfile) {
            clearArmTimer();
            startPlaying();
          }
        }, TUNING.POSE_READY_POLL_MS);
      }
    } catch (err) {
      notice(`歌曲載入失敗：${err.message}`);
      exit("error");
    }
  }

  /**
   * @param {"ended"|"manual"|"camera-off"|"error"|"switch"} reason
   */
  function exit(reason = "manual") {
    if (phase === SONG_PHASES.IDLE) return;

    clearArmTimer();
    audio.cancelScheduled();

    getTransport()?.destroy();
    setTransport(null);

    songUI.exitSongLayout();

    chart = null;
    sequencer = null;
    cueTrack = null;
    currentSong = null;
    phase = SONG_PHASES.IDLE;

    if (reason === "error") {
      // notice 已在 enter 的 catch 內發出，此處不重複
    }
  }

  return {
    PHASES: SONG_PHASES,
    enter,
    exit,
    getPhase: () => phase,
    getSequencer: () => sequencer,
    getCueTrack: () => cueTrack,
    getChart: () => chart,
    getSong: () => currentSong,
    getFirstOnsetMs: () => cueTrack?.getFirstOnsetMs() ?? Infinity,
    /** hitRouter 與主迴圈的唯一判斷依據 */
    isPlaying: () => phase === SONG_PHASES.PLAYING,
    isActive: () => phase !== SONG_PHASES.IDLE,
  };
}
