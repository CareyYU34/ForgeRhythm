/**
 * songMode/songUI.js
 *
 * 職責：歌曲模式的所有 DOM 操作。
 *
 * ═══ 版面決策 ═══
 *
 * 底部 HUD 放在 camera-frame 底部中央 —— 使用者是站著全身打鼓、離螢幕
 * 有距離的，放側邊面板等於不存在。
 *
 * 前導倒數則放在畫面正中央，是獨立於 HUD 的元素。
 *
 * ⚠ #songCountdown 不能放進 .song-hud。那個容器是 bottom 定位的，
 *   放進去無法置中於畫面。
 *
 * ═══ 兩個訊號源 ═══
 *
 *   1. topbar 的命中文字（#hitDisplay，poseLoop 提供）
 *   2. HUD 的燈號（剛剛發出的音）
 *
 * 第三個訊號源（游標 `102 / 487`）在 L1 之後預設隱藏，
 * 由 TUNING.SHOW_DEBUG_CURSOR 控制。區塊對齊出問題時把它打開 ——
 * 它是唯一能看出游標錯位的視覺輸出。
 *
 * ═══ 節拍格線的更新頻率紀律 ═══
 *
 *   重建節點   → 只在換塊時（約 6 秒一次）
 *   指針位置   → 每幀，只寫 style.left
 *   音符狀態   → 每次打擊，只切 dataset
 *
 * ⚠ 打擊熱路徑上不得再出現 innerHTML 全量重建。
 *   舊版 renderRibbon 每次打擊重建 14 個節點，改成區塊制後
 *   這個成本應該消失，而不是平移到別處。
 */

import { TUNING } from "./tuning.js";

/** MIDI → 顯示用短標籤。與 styles 的 data-midi 配色對應。 */
const DRUM_SHORT = {
  36: "K",
  38: "S",
  42: "H",
};

const $ = (id) => document.getElementById(id);

export function createSongUI() {
  const el = {
    libBtn: $("songLibBtn"),
    libPanel: $("songLibPanel"),
    ytPanel: $("ytPanel"),
    playerHost: $("playerHost"),
    overlayPlay: $("overlayPlay"),
    video: $("songVideo"),
    title: $("songTitle"),
    exitBtn: $("songExitBtn"),
    hud: $("songHud"),

    // ── 前導倒數（B 案）──
    countdown: $("songCountdown"),
    countdownNum: $("songCountdownNum"),

    // ── 節拍格線（C 案）──
    ribbonRow: $("songRibbonRow"),
    block: $("songBlock"),
    blockGrid: $("songBlockGrid"),
    blockNotes: $("songBlockNotes"),
    blockHead: $("songBlockHead"),
    blockRest: $("songBlockRest"),

    lamp: $("songLamp"),
    cursorFill: $("songCursorFill"),
    cursorText: $("songCursorText"),
    cursorWrap: $("songCursorWrap"),
    waitText: $("songWaitText"),
  };

  // ── 倒數狀態 ──
  let cues = [];
  let firstOnsetMs = Infinity;
  /** 上次顯示的內容，用來判斷是否需要觸發彈跳 */
  let lastShown = null;
  let popTimerId = null;

  // ── 格線狀態 ──
  /** 目前畫在畫面上的區塊。null = 需要重畫 */
  let renderedBlockIdx = null;
  /** 目前區塊內音符的 DOM 節點，index 與 chart.onsetList 的絕對 index 對應 */
  let blockNoteNodes = [];
  let blockFirstIndex = 0;
  let lastCursorPainted = -1;

  // ── 歌曲清單的展開 / 收合 ──
  el.libBtn?.addEventListener("click", (e) => {
    e.stopPropagation();
    el.libPanel.classList.toggle("is-hidden");
  });
  el.libPanel?.addEventListener("click", (e) => e.stopPropagation());
  document.addEventListener("click", () => {
    el.libPanel?.classList.add("is-hidden");
  });

  function closeLibrary() {
    el.libPanel?.classList.add("is-hidden");
  }

  function hideCountdown() {
    el.countdown?.classList.add("is-hidden");
    if (el.countdownNum) {
      el.countdownNum.dataset.go = "0";
      el.countdownNum.dataset.pop = "0";
    }
    lastShown = null;
  }

  /**
   * 換數字時的縮放彈跳。
   *
   * ⚠ 不用 CSS @keyframes 自走動畫 —— 自走動畫時長固定，
   *   影片暫停或 seek 後會與拍點脫節。狀態必須由影片時間驅動，
   *   這裡只負責「觸發一次 transition 再回彈」。
   */
  function pop() {
    if (!el.countdownNum) return;
    if (popTimerId !== null) clearTimeout(popTimerId);
    el.countdownNum.dataset.pop = "1";
    popTimerId = setTimeout(() => {
      if (el.countdownNum) el.countdownNum.dataset.pop = "0";
      popTimerId = null;
    }, TUNING.COUNTDOWN_POP_MS);
  }

  function showCountdownText(text, isGo) {
    if (!el.countdown || !el.countdownNum) return;
    el.countdown.classList.remove("is-hidden");
    el.countdownNum.dataset.go = isGo ? "1" : "0";

    if (text !== lastShown) {
      el.countdownNum.textContent = text;
      lastShown = text;
      pop();
    }
  }

  return {
    // ═══ 歌曲清單 ═══════════════════════════════════════════════════════

    renderLibrary(songs, onPick) {
      if (!el.libPanel) return;
      el.libPanel.replaceChildren();

      const head = document.createElement("p");
      head.className = "song-lib-head";
      head.textContent = "本機歌曲";
      el.libPanel.appendChild(head);

      for (const song of songs) {
        const item = document.createElement("button");
        item.type = "button";
        item.className = "song-lib-item";

        const cover = document.createElement("span");
        cover.className = "song-lib-cover";
        if (song.cover) {
          const img = document.createElement("img");
          img.src = song.cover;
          img.alt = "";
          cover.appendChild(img);
        } else {
          cover.innerHTML = '<i class="fas fa-play"></i>';
        }

        const meta = document.createElement("span");
        meta.className = "song-lib-meta";

        const title = document.createElement("span");
        title.className = "song-lib-title";
        title.textContent = song.title;

        const sub = document.createElement("span");
        sub.className = "song-lib-sub";
        sub.textContent = [
          song.bpm ? `${song.bpm} BPM` : "",
          song.noteCount ? `${song.noteCount} 顆` : "",
          song.duration ?? "",
        ]
          .filter(Boolean)
          .join("　");

        meta.append(title, sub);
        item.append(cover, meta);

        item.addEventListener("click", () => {
          closeLibrary();
          onPick(song);
        });

        el.libPanel.appendChild(item);
      }

      const hint = document.createElement("p");
      hint.className = "song-lib-hint";
      hint.textContent = "選歌後會等姿態就緒才開始播放，站進鏡頭即可。";
      el.libPanel.appendChild(hint);
    },

    bindExit(cb) {
      el.exitBtn?.addEventListener("click", cb);
    },

    getVideoEl() {
      return el.video;
    },

    // ═══ 版面切換 ═══════════════════════════════════════════════════════

    enterSongLayout(title) {
      closeLibrary();
      el.ytPanel?.classList.remove("is-hidden");
      el.playerHost?.classList.add("is-hidden");
      el.video?.classList.remove("is-hidden");
      el.exitBtn?.classList.remove("is-hidden");
      el.hud?.classList.remove("is-hidden");
      if (el.title) {
        el.title.textContent = title ?? "";
        el.title.classList.remove("is-hidden");
      }
      // YT 的中央播放遮罩在歌曲模式無意義
      if (el.overlayPlay) el.overlayPlay.style.display = "none";
    },

    exitSongLayout() {
      el.hud?.classList.add("is-hidden");
      el.video?.classList.add("is-hidden");
      el.exitBtn?.classList.add("is-hidden");
      el.title?.classList.add("is-hidden");
      el.playerHost?.classList.remove("is-hidden");
      // YT player 已 destroy，面板收起，使用者需重新載入連結
      el.ytPanel?.classList.add("is-hidden");
      if (el.overlayPlay) el.overlayPlay.style.display = "";

      // ⚠ 必須隱藏倒數，否則退出後畫面正中央會殘留一個大字
      hideCountdown();

      cues = [];
      firstOnsetMs = Infinity;
      renderedBlockIdx = null;
      blockNoteNodes = [];
      lastCursorPainted = -1;
    },

    // ═══ 等待姿態就緒 ═══════════════════════════════════════════════════

    showWaitingPose() {
      el.waitText?.classList.remove("is-hidden");
      el.ribbonRow?.classList.add("is-hidden");
      el.cursorWrap?.classList.add("is-hidden");
      hideCountdown();
    },

    hideWaitingPose() {
      el.waitText?.classList.add("is-hidden");
      // ⚠ 游標進度條預設隱藏，只在除錯時打開
      if (TUNING.SHOW_DEBUG_CURSOR) {
        el.cursorWrap?.classList.remove("is-hidden");
      }
    },

    // ═══ 前導倒數 ═══════════════════════════════════════════════════════

    /** songSession.enter 時注入引導音時刻表 */
    setCues(cueList, onsetMs) {
      cues = cueList ?? [];
      firstOnsetMs = Number.isFinite(onsetMs) ? onsetMs : Infinity;
      lastShown = null;
    },

    /**
     * 置中倒數。純視覺，不參與發聲。
     *
     * 顯示值 = CUE_COUNT − beat + 1
     *   beat = 1（第一顆 onset 前 4 拍，重音）→ 顯示「4」
     *   beat = 4（前 1 拍）                    → 顯示「1」
     *
     * 數字在兩拍之間持續顯示，不淡出。
     */
    updateCountdown(currentTimeMs) {
      if (!el.countdown) return;

      if (!cues.length) {
        hideCountdown();
        return;
      }

      // ── 第一顆音符之後：「開始」，然後收起 ──
      if (currentTimeMs >= firstOnsetMs) {
        if (currentTimeMs < firstOnsetMs + TUNING.COUNTDOWN_GO_HOLD_MS) {
          showCountdownText("開始", true);
        } else {
          hideCountdown();
        }
        return;
      }

      // ── 找出當前該顯示哪一顆 ──
      // 最後一個滿足 c.t <= now + LEAD 的 cue。
      // LEAD 補償 rAF 取樣間隔與影片時間的量化誤差，
      // 讓數字不會在視覺上晚於聲音。
      let current = null;
      for (const c of cues) {
        if (c.t <= currentTimeMs + TUNING.COUNTDOWN_LEAD_MS) current = c;
        else break;
      }

      if (!current) {
        // 還沒到第一顆引導音
        hideCountdown();
        return;
      }

      showCountdownText(String(TUNING.CUE_COUNT - current.beat + 1), false);
    },

    // ═══ 節拍格線 ═══════════════════════════════════════════════════════

    /** 強制下一次 ensureBlock 重畫（seek / 跨邊界打擊後呼叫） */
    invalidateBlock() {
      renderedBlockIdx = null;
    },

    /**
     * 確保畫面上是指定區塊。已經是了就什麼都不做。
     *
     * ⚠ 這是唯一會重建節點的地方，呼叫頻率約每 6 秒一次。
     */
    ensureBlock({ chart, barGrid, blockIdx, sequencer }) {
      if (!el.blockNotes || !el.blockGrid) return;
      if (!chart || !barGrid) return;
      if (blockIdx === renderedBlockIdx) return;

      const startMs = barGrid.blockStartMs(blockIdx);
      const endMs = barGrid.blockEndMs(blockIdx);
      const spanMs = barGrid.getBlockMs();

      // ⚠ offsetWidth 是強制回流的讀取，必須在任何 replaceChildren 之前，
      //   否則同一幀內 write-after-read 會讓瀏覽器 layout 兩次。
      //   每次換塊才發生（約 6 秒一次），不在打擊熱路徑上。
      const blockWidthPx = el.block ? el.block.offsetWidth : 0;

      // ── 拍線 ──
      const beats = barGrid.getBeatsPerBlock();
      const beatsPerBar = barGrid.getBeatsPerBar();
      const gridFrag = document.createDocumentFragment();
      for (let b = 0; b < beats; b++) {
        const line = document.createElement("i");
        line.className = "song-beat-line";
        line.dataset.bar = b % beatsPerBar === 0 ? "1" : "0";
        line.style.left = `${(b / beats) * 100}%`;
        gridFrag.appendChild(line);
      }
      el.blockGrid.replaceChildren(gridFrag);

      // ── 音符 ──
      const from = chart.firstIndexAtOrAfter(startMs);
      const to = chart.firstIndexAtOrAfter(endMs);

      blockFirstIndex = from;
      blockNoteNodes = [];

      const noteFrag = document.createDocumentFragment();
      let minDeltaMs = Infinity;
      let prevTime = null;
      for (let i = from; i < to; i++) {
        const o = chart.onsetList[i];

        // 密度量測：本區塊相鄰音符的最小時間間隔
        if (prevTime !== null) {
          const d = o.time - prevTime;
          if (d < minDeltaMs) minDeltaMs = d;
        }
        prevTime = o.time;

        const node = document.createElement("i");
        node.className = "song-note";
        node.dataset.midi = String(o.midi);
        node.dataset.index = String(i);
        node.dataset.state = "pending";
        node.style.left = `${((o.time - startMs) / spanMs) * 100}%`;
        node.textContent = DRUM_SHORT[o.midi] ?? "?";
        noteFrag.appendChild(node);
        blockNoteNodes.push(node);
      }
      el.blockNotes.replaceChildren(noteFrag);

      // ── 密度保險 ──
      // 音符數 < 2 時沒有相鄰間隔可算，一律視為不密集。
      if (el.block) {
        const dense =
          minDeltaMs !== Infinity &&
          spanMs > 0 &&
          blockWidthPx > 0 &&
          (minDeltaMs / spanMs) * blockWidthPx < TUNING.NOTE_SOON_MIN_GAP_PX;
        el.block.dataset.dense = dense ? "1" : "0";
      }

      // ── 空區塊 ──
      el.blockRest?.classList.toggle("is-hidden", blockNoteNodes.length > 0);

      renderedBlockIdx = blockIdx;
      lastCursorPainted = -1;
      if (sequencer) this.updateBlockStates(sequencer);
    },

    /**
     * 播放位置指針。每幀呼叫，只寫 style.left。
     *
     * 這是「換頁不做提前量」的補償 —— 使用者從指針位置就能預期
     * 何時翻頁，不需要兩個區塊同時在畫面上爭取注意力。
     */
    updateBlockHead(currentTimeMs, barGrid, blockIdx) {
      if (!el.blockHead || !barGrid) return;
      const startMs = barGrid.blockStartMs(blockIdx);
      const pct = ((currentTimeMs - startMs) / barGrid.getBlockMs()) * 100;
      el.blockHead.style.left = `${Math.max(0, Math.min(100, pct))}%`;
    },

    /**
     * 音符狀態。每次打擊呼叫，只切 dataset。
     *
     * next 保證與下一次打擊實際發出的音一致 ——
     * 這是 L1 雙向硬對齊要達成的核心性質。
     */
    updateBlockStates(sequencer) {
      if (!sequencer || !blockNoteNodes.length) return;
      const cursor = sequencer.getCursor();
      // ⚠ 打擊熱路徑上唯一的成本護欄，不要移除。
      if (cursor === lastCursorPainted) return;

      const soonEnd = cursor + TUNING.NOTE_SOON_COUNT;
      for (const node of blockNoteNodes) {
        const i = Number(node.dataset.index);
        node.dataset.state =
          i < cursor
            ? "done"
            : i === cursor
              ? "next"
              : i <= soonEnd
                ? "soon"
                : "pending";
      }
      lastCursorPainted = cursor;
    },

    // ═══ 游標（除錯用，預設隱藏）═══════════════════════════════════════

    updateCursor(cursor, total) {
      if (el.cursorText) el.cursorText.textContent = `${cursor} / ${total}`;
      if (el.cursorFill) {
        el.cursorFill.style.width = `${total ? (cursor / total) * 100 : 0}%`;
      }
    },

    /** 燈號 = 剛剛發出的那一顆 */
    updateLamp(res) {
      if (!el.lamp) return;
      if (!res || res.exhausted || res.midi === null) {
        el.lamp.dataset.midi = "";
        el.lamp.textContent = "—";
        return;
      }
      el.lamp.dataset.midi = String(res.midi);
      el.lamp.textContent = DRUM_SHORT[res.midi] ?? "?";
    },

    /** hitRouter 每次派發後呼叫 */
    onHitResult(res, sequencer) {
      this.updateLamp(res);
      this.updateBlockStates(sequencer);
      this.updateCursor(sequencer.getCursor(), sequencer.getTotal());
    },

    // ═══ 階段切換 ═══════════════════════════════════════════════════════
    //
    // ⚠ 倒數的顯示與否完全由 updateCountdown 依影片時間決定，
    //   不由階段切換控制 —— 兩套控制會在 seek 時互相打架。

    showCuePhase() {
      el.ribbonRow?.classList.add("is-hidden");
    },

    showRibbonPhase() {
      el.ribbonRow?.classList.remove("is-hidden");
    },
  };
}