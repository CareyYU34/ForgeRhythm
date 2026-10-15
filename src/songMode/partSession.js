/**
 * songMode/partSession.js
 *
 * 職責：分部模式的生命週期。與 songSession 是「姊妹」——共用譜面解析、
 * sequencer、barGrid、cueTrack、songUI、hitRouter 這條打擊管線，但：
 *
 *   - 沒有影片：時間軸來自 clockTransport（AudioContext 牆鐘）。
 *   - 多一個「選分部」步驟：使用者選一個鼓件自己打。
 *   - 多一條背景伴奏：backingTrack 自動播其餘分部（選中的那件在背景靜音）。
 *
 * ═══ 狀態機 ═══
 *
 *   IDLE ─選歌─> LOADING ─譜面就緒─> PART_SELECT ─選分部─> ARMED ─姿態就緒─> PLAYING
 *     ^                                                                          │
 *     └──────────────── 退出（ended / manual / camera-off / error）──────────────┘
 *
 * ═══ 與 songSession 一致的鴨子介面 ═══
 *
 * hitRouter 與 main.js 的 hudLoop 只認：
 *   isPlaying / isActive / syncBlock / getSequencer / getBarGrid / getChart /
 *   getFirstOnsetMs / getCueTrack
 * 兩個 session 一次只有一個 active，所以同一套 hitRouter / hudLoop 通吃。
 *
 * ═══ syncBlock 的不變式（與 songSession 完全相同，刻意複製而非共用）═══
 *
 *   冪等 —— 同一區塊內呼叫任意次，結果相同、無副作用
 *   單向 —— 只讀時間、只寫游標，不讀游標來決定要不要對齊
 *
 *   複製而非抽共用，是為了不動到已驗證的月亮路徑（songSession）。
 *   若日後要改對齊邏輯，請兩邊一起改。
 */

import { TUNING } from "./tuning.js";
import { buildPartChart, listParts } from "./chartLoader.js";
import { createSequencer } from "./sequencer.js";
import { createLeadIn } from "./leadIn.js";
import { createBarGrid } from "./barGrid.js";
import { createBackingTrack } from "./backingTrack.js";
import { createClockTransport } from "../transport/clockTransport.js";
import { MIDI_TO_SOUND_ID } from "../audioEngine.js";

export const PART_PHASES = {
  IDLE: "IDLE",
  LOADING: "LOADING",
  PART_SELECT: "PART_SELECT",
  ARMED: "ARMED",
  PLAYING: "PLAYING",
};

export function createPartSession({
  state,
  audio,
  getTransport,
  setTransport,
  songUI,
  onNotice,
}) {
  let phase = PART_PHASES.IDLE;
  let songJson = null;
  let currentSong = null;
  let chart = null;
  let sequencer = null;
  let leadIn = null;
  let barGrid = null;
  let backing = null;
  let firstOnsetMs = Infinity;
  let durationMs = 0;
  let armTimerId = null;
  let endTimerId = null;

  /** 上一次對齊到的區塊。null = 下一次呼叫必須重算。 */
  let lastAlignedBlock = null;

  function notice(msg) {
    if (typeof onNotice === "function") onNotice(msg);
    else if (msg) console.warn("[partSession]", msg);
  }

  function clearArmTimer() {
    if (armTimerId !== null) {
      clearInterval(armTimerId);
      armTimerId = null;
    }
  }

  function clearEndTimer() {
    if (endTimerId !== null) {
      clearInterval(endTimerId);
      endTimerId = null;
    }
  }

  function getFirstOnsetMs() {
    return firstOnsetMs;
  }

  // ═══ syncBlock（與 songSession 相同）═══════════════════════════════════
  function syncBlock(nowMs) {
    if (phase !== PART_PHASES.PLAYING) return false;
    if (!sequencer || !barGrid || !chart) return false;

    // 前奏期由 hitRouter 的前奏閘門負責，這裡不對齊。
    if (nowMs < getFirstOnsetMs()) return false;

    const blockIdx = barGrid.blockIndexAt(nowMs + TUNING.ALIGN_TOLERANCE_MS);
    if (blockIdx === lastAlignedBlock) return false;

    const blockStart = barGrid.blockStartMs(blockIdx);
    // ⚠ firstIndexAtOrAfter，不可用 nearestIndex（邊界會往回跳）。
    const target = chart.firstIndexAtOrAfter(blockStart);
    sequencer.setCursor(target);

    lastAlignedBlock = blockIdx;
    return true;
  }

  // ═══ 進入：選歌 → 載譜 → 選分部 ═══════════════════════════════════════
  async function enter(song) {
    if (phase !== PART_PHASES.IDLE) exit("switch");

    phase = PART_PHASES.LOADING;
    currentSong = song;

    try {
      const res = await fetch(encodeURI(song.chart));
      if (!res.ok) throw new Error(`譜面載入失敗（HTTP ${res.status}）`);
      songJson = await res.json();

      // 分部清單：標上「本機是否有對應鼓聲」。無對應者仍可當背景，但
      // 選來打會沒有自己的打擊音，故在選單上標為不可選。
      const parts = listParts(songJson).map((p) => ({
        ...p,
        playable: !!MIDI_TO_SOUND_ID[p.midi],
      }));

      // 版面切到「無影片」的分部模式，YT player 若在也一併收掉
      getTransport()?.destroy();
      setTransport(null);
      songUI.enterPartLayout(song.title);

      phase = PART_PHASES.PART_SELECT;
      songUI.showPartPicker(parts, (midi) => onPickPart(midi));
    } catch (err) {
      notice(`歌曲載入失敗：${err.message}`);
      exit("error");
    }
  }

  // ═══ 選定分部 → 建立管線 ═══════════════════════════════════════════════
  function onPickPart(selectMidi) {
    if (phase !== PART_PHASES.PART_SELECT) return;

    try {
      chart = buildPartChart(songJson, {
        selectMidi,
        difficulty: state.songDifficulty === "advanced" ? "advanced" : "basic",
      });

      sequencer = createSequencer({ chart });
      barGrid = createBarGrid({ chart });
      backing = createBackingTrack({ chart, audio, getTransport });
      leadIn = createLeadIn({ chart, barGrid, audio, getTransport });
      firstOnsetMs = chart.onsetList[0].time;
      lastAlignedBlock = null;

      if (chart.warnings.length) notice(chart.warnings.join(" "));
      if (barGrid.getWarnings().length) notice(barGrid.getWarnings().join(" "));

      // 歌曲總長 = 選中分部與背景分部的最後一顆，加尾拍留白
      const lastBackMs = chart.backingList.length
        ? chart.backingList[chart.backingList.length - 1].time
        : 0;
      durationMs = Math.max(chart.duration, lastBackMs) + 2000;

      // ── 建立時鐘 transport（從前導預覽的負時間起跑，音量接背景匯流排）──
      const adapter = createClockTransport({
        audioNow: audio.now,
        durationSec: durationMs / 1000,
        initialTime: leadIn.getStartMediaSec(),
        onVolume: (v) => audio.setBackingVolume(v),
      });
      setTransport(adapter);

      adapter.on("playing", () => {
        // 前導預覽（循環選中分部節奏）+ 背景。背景在負時間期間自然不發，
        // 因為它的排程 horizon 還沒到第一顆（time >= 0）。
        leadIn?.anchor();
        backing?.start();
        startEndWatchdog();
      });
      adapter.on("pause", () => {
        // ⚠ 與 songSession 同理：AudioContext 時間軸不因暫停而停，
        //   已排的引導音與背景音必須立即取消。
        audio.cancelScheduled();
        backing?.stop();
        clearEndTimer();
      });
      adapter.on("seeking", () => {
        audio.cancelScheduled();
        backing?.seek();
        lastAlignedBlock = null;
        songUI.invalidateBlock();
      });
      adapter.on("ended", () => exit("ended"));

      // ── HUD 初始畫面 ──
      songUI.hidePartPicker();
      songUI.setPartLabel(partLabel(selectMidi, chart));
      // 倒數 cue 由前導預覽提供；「開始」點對齊第一顆真實音符。
      songUI.setCues(leadIn.getCountdownCues(), firstOnsetMs);
      songUI.invalidateBlock();
      songUI.updateCursor(0, sequencer.getTotal());
      songUI.showCuePhase();

      // ── 等待姿態就緒 ──
      phase = PART_PHASES.ARMED;
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
      notice(`分部建立失敗：${err.message}`);
      exit("error");
    }
  }

  function partLabel(midi, ch) {
    // backingList / onsetList 的 name 來自 chart（GM 鼓名）。取選中分部的名字。
    const first = ch?.onsetList?.[0];
    return first?.name ?? String(midi);
  }

  function startPlaying() {
    if (phase !== PART_PHASES.ARMED) return;
    phase = PART_PHASES.PLAYING;
    songUI.hideWaitingPose();
    getTransport()?.play();
  }

  /**
   * 結束偵測：clockTransport 沒有影片的 "ended" 事件，改用輕量輪詢。
   * 播放時間越過歌曲總長 → 讓 transport 統一發 "ended"（→ exit）。
   */
  function startEndWatchdog() {
    clearEndTimer();
    endTimerId = setInterval(() => {
      const t = getTransport();
      if (!t) return;
      if (t.getCurrentTime() * 1000 >= durationMs) {
        clearEndTimer();
        t.signalEnded?.();
      }
    }, 200);
  }

  // ═══ 退出 ═══════════════════════════════════════════════════════════════
  function exit(reason = "manual") {
    if (phase === PART_PHASES.IDLE) return;

    clearArmTimer();
    clearEndTimer();
    audio.cancelScheduled();
    backing?.destroy();

    getTransport()?.destroy();
    setTransport(null);

    songUI.hidePartPicker();
    songUI.exitPartLayout();

    songJson = null;
    chart = null;
    sequencer = null;
    leadIn = null;
    barGrid = null;
    backing = null;
    currentSong = null;
    firstOnsetMs = Infinity;
    durationMs = 0;
    lastAlignedBlock = null;
    phase = PART_PHASES.IDLE;
  }

  return {
    PHASES: PART_PHASES,
    enter,
    exit,
    syncBlock,
    getPhase: () => phase,
    getSequencer: () => sequencer,
    getCueTrack: () => leadIn,
    getChart: () => chart,
    getBarGrid: () => barGrid,
    getSong: () => currentSong,
    getFirstOnsetMs,
    isPlaying: () => phase === PART_PHASES.PLAYING,
    isActive: () => phase !== PART_PHASES.IDLE,
  };
}
