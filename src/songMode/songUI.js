/**
 * songMode/songUI.js
 *
 * 職責：歌曲模式的所有 DOM 操作。
 *
 * ═══ 版面決策（規格書 §10.2）═══
 *
 * HUD 放在 camera-frame 底部中央，不放側邊面板。
 * 使用者是站著全身打鼓、離螢幕有距離的 —— 放在 player-card 旁邊等於不存在。
 * 放中央底部則落在他本來就在看的鏡像視野內，且不會擋住自己的身體。
 *
 * ⚠ 引導拍與預覽帶互斥顯示。
 *   畫面上永遠只有一組資訊在爭取注意力，這對站在遠處的使用者比
 *   「兩塊都在」重要得多。切換點由 main.js 的 HUD 迴圈判斷。
 *
 * ═══ 三個獨立訊號源（規格書 §13.2）═══
 *
 * 本版沒有任何診斷輸出，靠這三者交叉比對：
 *
 *   1. topbar 的命中文字（#hitDisplay，poseLoop 提供）
 *   2. HUD 的燈號（剛剛發出的音）
 *   3. HUD 的預覽帶頭顆（下一次會發出的音）
 *
 * 燈號 ≠ 上一幀的預覽帶頭顆 → router 或 sequencer 有錯。
 * 命中文字有跳但游標沒動 → 前奏閘門誤判或分流錯誤。
 * 命中文字一次跳兩下 → 同幀多重觸發（這正是本版要量測的資料）。
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
    cueBeats: $("songCueBeats"),
    ribbonRow: $("songRibbonRow"),
    ribbon: $("songRibbon"),
    lamp: $("songLamp"),
    cursorFill: $("songCursorFill"),
    cursorText: $("songCursorText"),
    cursorWrap: $("songCursorWrap"),
    waitText: $("songWaitText"),
  };

  let cues = [];

  // ── 歌曲清單的展開 / 收合 ──
  // 沿用 initSettingsPanel 的 pattern：按鈕與面板 stopPropagation，
  // document click 收合。
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
      cues = [];
    },

    // ═══ 等待姿態就緒 ═══════════════════════════════════════════════════

    showWaitingPose() {
      el.waitText?.classList.remove("is-hidden");
      el.cueBeats?.classList.add("is-hidden");
      el.ribbonRow?.classList.add("is-hidden");
      el.cursorWrap?.classList.add("is-hidden");
    },

    hideWaitingPose() {
      el.waitText?.classList.add("is-hidden");
      el.cursorWrap?.classList.remove("is-hidden");
    },

    // ═══ 引導拍 ═════════════════════════════════════════════════════════

    renderCueBeats(cueList, quarterMs) {
      cues = cueList ?? [];
      if (!el.cueBeats) return;

      if (!cues.length) {
        el.cueBeats.innerHTML =
          '<p class="song-cue-none">本譜不發引導音</p>';
        return;
      }

      el.cueBeats.innerHTML = cues
        .map(
          (c) =>
            `<div class="song-cue-beat" data-accent="${c.accent ? 1 : 0}" data-state="idle">${c.beat}</div>`,
        )
        .join("");

      if (quarterMs) {
        el.cueBeats.dataset.quarter = quarterMs.toFixed(1);
      }
    },

    /**
     * 引導拍指示燈。純視覺，不參與發聲。
     * 判定沿用順序鼓 v3：d < -60 → idle，d <= 120 → now，否則 passed。
     */
    updateCueLamps(currentTimeMs) {
      if (!el.cueBeats || !cues.length) return;
      const nodes = el.cueBeats.children;
      for (let i = 0; i < cues.length && i < nodes.length; i++) {
        const d = currentTimeMs - cues[i].t;
        nodes[i].dataset.state = d < -60 ? "idle" : d <= 120 ? "now" : "passed";
      }
    },

    // ═══ 預覽帶 ═════════════════════════════════════════════════════════

    /**
     * 最左邊那顆放大，代表「下一次打下去會發出的音」。
     * 這讓「順序派發」變成可見的 —— 聽到的鼓應該和放大那顆一致。
     */
    renderRibbon(sequencer) {
      if (!el.ribbon || !sequencer) return;
      const next = sequencer.peek(TUNING.RIBBON_LENGTH);
      el.ribbon.innerHTML = next
        .map(
          (o, i) =>
            `<i class="song-rib" data-midi="${o.midi}" data-head="${i === 0 ? 1 : 0}">${DRUM_SHORT[o.midi] ?? "?"}</i>`,
        )
        .join("");
    },

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
      this.renderRibbon(sequencer);
      this.updateCursor(sequencer.getCursor(), sequencer.getTotal());
    },

    // ═══ 階段切換（引導拍 ↔ 預覽帶）═════════════════════════════════════

    showCuePhase() {
      el.cueBeats?.classList.remove("is-hidden");
      el.ribbonRow?.classList.add("is-hidden");
    },

    showRibbonPhase() {
      el.cueBeats?.classList.add("is-hidden");
      el.ribbonRow?.classList.remove("is-hidden");
    },
  };
}
