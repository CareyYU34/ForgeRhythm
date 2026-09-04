/**
 * songMode/songSession.js
 *
 * 職責：歌曲模式的生命週期，以及 L1 的區塊對齊判斷。
 *
 * ═══ 狀態機 ═══
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
 * ═══ L1：區塊對齊 ═══
 *
 * syncBlock 是整個專案唯一決定「游標該跳到哪」的地方。
 * 它必須維持兩個性質，缺一個都會出難查的 bug：
 *
 *   冪等   —— 同一區塊內呼叫任意次，結果相同、無副作用
 *   單向   —— 只讀時間、只寫游標，不讀游標來決定要不要對齊
 */

import { TUNING } from "./tuning.js";
import { loadChart } from "./chartLoader.js";
import { createSequencer } from "./sequencer.js";
import { createCueTrack } from "./cueTrack.js";
import { createBarGrid } from "./barGrid.js";
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
  let barGrid = null;
  let currentSong = null;
  let armTimerId = null;

  /**
   * 上一次對齊到的區塊。
   *
   * ⚠ 這個變數就是冪等性的實作。null 代表「下一次呼叫必須重算」，
   *   seek 之後必須設回 null。
   */
  let lastAlignedBlock = null;

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

  /**
   * 區塊對齊。L1 的核心。
   *
   * 呼叫者有兩個，兩個都必須呼叫：
   *   - main.js 的 hudLoop（每幀）
   *   - hitRouter.route（每次打擊，消除 rAF 空窗的競態）
   *
   * @param {number} nowMs 影片時間（ms）。呼叫端已讀好，本方法不再讀時鐘。
   * @returns {boolean} 是否真的發生了對齊（供呼叫端決定要不要重畫格線）
   */
  function syncBlock(nowMs) {
    if (phase !== SONG_PHASES.PLAYING) return false;
    if (!sequencer || !barGrid || !chart) return false;

    // ⚠ 前奏期由 hitRouter 的前奏閘門負責，兩者不得同時作用。
    //   這裡若不擋，前奏期間 hudLoop 會把游標對齊到第 0 塊，
    //   而閘門又不讓打擊推進 —— 兩邊對「游標現在該在哪」的認知會分歧。
    if (nowMs < getFirstOnsetMs()) return false;

    // ⚠ 判定點提前 ALIGN_TOLERANCE_MS。
    //   人的打擊散佈在小節線前後幾十毫秒，硬邊界會讓「提早打下的
    //   小節重拍」被判為還在舊區塊，於是吃掉舊區塊剩餘的音符。
    const blockIdx = barGrid.blockIndexAt(nowMs + TUNING.ALIGN_TOLERANCE_MS);

    // 冪等的關鍵：同一區塊內直接返回
    if (blockIdx === lastAlignedBlock) return false;

    const blockStart = barGrid.blockStartMs(blockIdx);

    // ⚠ 必須用 firstIndexAtOrAfter，不可用 nearestIndex。
    //   後者在邊界上可能回傳「上一區塊的最後一顆」，
    //   造成游標往回跳、剛打過的音再響一次。
    const target = chart.firstIndexAtOrAfter(blockStart);

    // 雙向硬對齊：target 小於當前游標時照樣執行（往回拉）。
    // 打太快與打太慢同樣是偏離，只修一邊會讓超前時的格線繼續失真。
    // 代價是超前時邊界處可能重播 1–2 顆，僅發生在跨小節線的瞬間。
    sequencer.setCursor(target);

    lastAlignedBlock = blockIdx;
    return true;
  }

  function getFirstOnsetMs() {
    return cueTrack?.getFirstOnsetMs() ?? Infinity;
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
      barGrid = createBarGrid({ chart });
      lastAlignedBlock = null;

      if (chart.warnings.length) notice(chart.warnings.join(" "));
      if (barGrid.getWarnings().length) {
        notice(barGrid.getWarnings().join(" "));
      }
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
        // 暫停不需要碰 lastAlignedBlock —— 時間沒前進，blockIdx 不變，
        // 冪等保證重複呼叫無副作用。
      });
      adapter.on("seeking", () => {
        audio.cancelScheduled();
        // ⚠ 必須重置。不重置的話，seek 到別的區塊後
        //   blockIdx 雖然變了但 lastAlignedBlock 仍是舊值 ——
        //   雖然仍會觸發對齊，但若 seek 回同一區塊就不會重算，
        //   而 seek 本身已經讓游標與時間脫節了。
        lastAlignedBlock = null;
        songUI.invalidateBlock();
      });
      adapter.on("ended", () => {
        exit("ended");
      });

      // ── 4. HUD 初始畫面 ──
      songUI.setCues(cueTrack.getCues(), cueTrack.getFirstOnsetMs());
      songUI.invalidateBlock();
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
    barGrid = null;
    currentSong = null;
    lastAlignedBlock = null;
    phase = SONG_PHASES.IDLE;

    if (reason === "error") {
      // notice 已在 enter 的 catch 內發出，此處不重複
    }
  }

  return {
    PHASES: SONG_PHASES,
    enter,
    exit,
    syncBlock,
    getPhase: () => phase,
    getSequencer: () => sequencer,
    getCueTrack: () => cueTrack,
    getChart: () => chart,
    getBarGrid: () => barGrid,
    getSong: () => currentSong,
    getFirstOnsetMs,
    /** hitRouter 與主迴圈的唯一判斷依據 */
    isPlaying: () => phase === SONG_PHASES.PLAYING,
    isActive: () => phase !== SONG_PHASES.IDLE,
  };
}
