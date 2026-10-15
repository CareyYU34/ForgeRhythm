/**
 * poseEngine/perfLog.js
 *
 * 開發用的姿態偵測診斷紀錄器。用來調參 PF / 速度 / 膝蓋門檻。
 *
 * ═══ 規則 ═══
 *
 *   1. 只在本地端（localhost / 127.0.0.1 / file://）執行。線上一律 no-op，
 *      poseLoop 每幀只多一次布林判斷，零額外開銷。
 *   2. 只在「開始演奏後」記錄 —— 由 main.js 在 session 進入 PLAYING 時 begin()、
 *      離開時 end()（歌曲結束 / 退出 / 關鏡頭都算中斷）。
 *   3. 逐幀把重要數值收進緩衝；每次「打擊」或「中斷」把緩衝那一段 commit 進
 *      log dict（segments）。於是每個 segment = 「上一次打擊到這次打擊之間的
 *      逐幀軌跡 + 終結這段的那次打擊」，最適合回頭看「打下去前 PF 怎麼走的」。
 *
 * ═══ 怎麼看 ═══
 *
 *   演奏中/後在 devtools console：`__poseLog`（= getLog()）。
 *   結構：{ runs: [ { id, meta, startedAt, endedAt, endReason,
 *                     frameCount, hitCount, segments: [ {index, terminator, frames:[…]} ] } ] }
 *   frames 每筆：見 perfLog說明.md §7（含 det / age 推論與相機延遲）。
 *
 * ═══ 延遲時間軸（每一擊的 terminator.timing，全部是 performance.now() ms）═══
 *
 *   capT      相機拍到這一格（requestVideoFrameCallback 的 captureTime；瀏覽器不給則 null）
 *   frameT    pose loop 拿到這一格、開始推論
 *   detEndT   推論完成
 *   crossT    這一下 PF 首次 ≤ PF_HIT 的幀（手部才有）
 *   trigT     判定成立、準備發聲
 *   sound     { kind, callT, outT, outEstT, ... } 聲音真正從喇叭出來的估計時間
 *   animDrawT 特效畫到 canvas
 *   animShowT 下一個 rAF 時間戳（≈ 該畫面被呈現）
 *
 *   console：__poseTiming() 印出每一擊的各段延遲表。
 *   自由模式也想錄：__poseLogBegin() 開始、__poseLogEnd() 結束。
 */

function detectLocal() {
  try {
    const h = location.hostname;
    return (
      location.protocol === "file:" ||
      h === "localhost" ||
      h === "127.0.0.1" ||
      h === "::1" ||
      h === "[::1]" ||
      h === ""
    );
  } catch {
    return false;
  }
}

const IS_LOCAL = detectLocal();

/** 單一 run 內的緩衝上限（安全閥，避免超長 session 撐爆記憶體） */
const MAX_FRAMES_PER_RUN = 60000;

const logDict = { runs: [] };

let running = false;
let current = null; // 當前 run
let pending = []; // 尚未 commit 的逐幀緩衝
let segIndex = 0;
let framesInRun = 0;
/**
 * 最近一幀的紀錄（= 觸發當幀）。
 * ⚠ hit() 把它附進打擊事件當「觸發當下的標準」快照，於是每一擊自帶
 *   當下（自動調整後）的門檻 pfHit/pfRel/spHit、kAdj、以及 pf/speed/膝蓋特徵，
 *   不必再回頭去翻該段最後一幀來核對 adaptiveMonitor 的調整結果。
 *   用獨立變數而非 pending[last]，是為了處理「同一幀多次打擊」——第一擊
 *   commit 後 pending 會被清空，lastFrame 仍指向那一幀。
 */
let lastFrame = null;

/**
 * 派發中的打擊紀錄。poseLoop 在 hit() 之後、playZone() 期間保持它，
 * audioEngine 的 noteSound() 只在這段期間才掛上去 —— 於是節拍器 / 前導拍
 * 這類非打擊的排程音（HUD loop 發出）不會被誤記成打擊聲。
 */
let dispatchRec = null;

function r1(v) {
  return v == null || !Number.isFinite(v) ? null : Math.round(v * 10) / 10;
}

function diff(a, b) {
  return a == null || b == null ? null : r1(a - b);
}

// 開發時直接掛到 window，console 打 __poseLog 就能看
if (IS_LOCAL && typeof window !== "undefined") {
  window.__poseLog = logDict;
  window.__poseTiming = (run) => perfLog.timingTable(run);
  window.__poseLogBegin = (meta = { mode: "manual" }) => perfLog.begin(meta);
  window.__poseLogEnd = () => perfLog.end("manual");
}

/** 把當前緩衝收成一個 segment 放進 run。terminator = 該段的結尾事件。 */
function commit(terminator) {
  if (!current) return;
  current.segments.push({
    index: segIndex++,
    terminator, // { type:"hit", ... } 或 { type:"end", reason }
    frames: pending,
  });
  pending = [];
}

export const perfLog = {
  isLocal() {
    return IS_LOCAL;
  },

  /** poseLoop 熱路徑用：不 active 就別費工建 record。 */
  isActive() {
    return IS_LOCAL && running;
  },

  /** 進入 PLAYING 時呼叫。meta 建議帶歌曲 / 分部資訊。 */
  begin(meta = {}) {
    if (!IS_LOCAL) return;
    // 前一段沒正常結束就先收尾，避免資料黏在一起
    if (running) this.end("superseded");
    current = {
      id: `run-${logDict.runs.length + 1}`,
      meta,
      startedAt: Date.now(),
      endedAt: null,
      endReason: null,
      frameCount: 0,
      hitCount: 0,
      // 觸發標準的參考快照（靜態門檻只記一次；會被 adaptiveMonitor 漂移的
      // 動態門檻另外逐幀記在 frame 裡，才看得出「與現實差多少 + 調整軌跡」）。
      standards: null,
      segments: [],
    };
    pending = [];
    segIndex = 0;
    framesInRun = 0;
    lastFrame = null;
    running = true;
    logDict.runs.push(current);
  },

  /** 這個 run 是否還沒記過觸發標準（讓呼叫端只在需要時才建那個物件）。 */
  needsStandards() {
    return running && !!current && !current.standards;
  },

  /** 記錄這個 run 的觸發標準參考（只記一次；needsStandards() 為真時才會存）。 */
  setStandards(obj) {
    if (running && current && !current.standards) current.standards = obj;
  },

  /** 每幀呼叫（呼叫端已用 isActive() 擋掉 no-op 情況）。 */
  frame(rec) {
    if (!running || !current) return;
    lastFrame = rec; // 觸發快照的來源（即使超過安全閥仍更新）
    if (framesInRun >= MAX_FRAMES_PER_RUN) return; // 安全閥：滿了就不再收
    pending.push(rec);
    current.frameCount++;
    framesInRun++;
  },

  /**
   * 打擊時呼叫：commit 這一段緩衝，terminator 記下這次打擊，
   * 並附上觸發當幀的完整快照 `at`（含當下自動調整後的門檻）。
   */
  hit(rec) {
    if (!running || !current) return null;
    current.hitCount++;
    const terminator = { type: "hit", ...rec, at: lastFrame };
    commit(terminator);
    dispatchRec = terminator;
    return terminator;
  },

  /** playZone() 返回後呼叫：結束這一擊的派發期。 */
  endDispatch() {
    dispatchRec = null;
  },

  /** audioEngine 發出打擊聲時呼叫；只在派發期內掛到當前這一擊。 */
  noteSound(info) {
    if (!dispatchRec?.timing || dispatchRec.timing.sound) return;
    dispatchRec.timing.sound = info;
  },

  /**
   * 每一擊的各段延遲（ms）。
   *   cam    相機拍到 → 程式拿到（相機管線 + 等 rAF）
   *   det    推論耗時
   *   wait   PF 越線 → 判定成立（被速度門檻 / 冷卻擋住的時間；同一幀 = 0）
   *   snd    判定 → 喇叭出聲（outT；括號內為 baseLatency+outputLatency 估計）
   *   anim   判定 → 畫面呈現
   *   total  相機拍到 → 喇叭出聲（整條鏈；capT 取不到時改從 frameT 起算並標 *）
   */
  timingTable(run = logDict.runs.at(-1)) {
    if (!run) {
      console.log("[perfLog] 沒有紀錄。歌曲模式演奏，或 __poseLogBegin() 後打幾下再 __poseLogEnd()。");
      return [];
    }
    const rows = run.segments
      .filter((s) => s.terminator?.type === "hit" && s.terminator.timing)
      .map((s) => {
        const h = s.terminator;
        const tm = h.timing;
        const snd = tm.sound;
        const start = tm.capT ?? tm.frameT;
        return {
          side: h.side,
          zone: h.zone,
          gapPrev: r1(tm.gapMs),
          cam: diff(tm.frameT, tm.capT),
          det: diff(tm.detEndT, tm.frameT),
          wait: diff(tm.frameT, tm.crossT),
          snd: snd ? diff(snd.outT ?? snd.outEstT, tm.trigT) : "無聲",
          sndEst: snd ? diff(snd.outEstT, tm.trigT) : null,
          anim: diff(tm.animShowT, tm.trigT),
          total: snd
            ? `${diff(snd.outT ?? snd.outEstT, start)}${tm.capT == null ? "*" : ""}`
            : null,
          sndKind: snd?.kind ?? null,
        };
      });
    console.table(rows);
    return rows;
  },

  /** 中斷 / 結束時呼叫：commit 殘餘緩衝並收尾 run。 */
  end(reason = "end") {
    if (!IS_LOCAL || !running || !current) return;
    commit({ type: "end", reason });
    current.endedAt = Date.now();
    current.endReason = reason;
    // 摘要一行，方便一眼看出這次演奏規模
    try {
      console.log(
        `[perfLog] ${current.id} 結束（${reason}）：` +
          `${current.frameCount} 幀 / ${current.hitCount} 擊 / ` +
          `${current.segments.length} 段。console 打 __poseLog 看細節。`,
      );
    } catch {
      /* ignore */
    }
    running = false;
    current = null;
    pending = [];
    lastFrame = null;
    dispatchRec = null;
  },

  getLog() {
    return logDict;
  },
};
