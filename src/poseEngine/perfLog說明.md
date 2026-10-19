# poseEngine 診斷 Log 說明（perfLog）

姿態偵測的調參用診斷紀錄。用來回頭核對「打擊觸發 vs 當下標準（含 adaptiveMonitor
自動調整後的門檻）差多少」。實作在 [`perfLog.js`](./perfLog.js)，埋點在
[`poseLoop.js`](./poseLoop.js)，觸發條件定義在 [`conditions.js`](./conditions.js)。

---

## 1. 何時產生、去哪拿

- **只在本地端執行**：`localhost` / `127.0.0.1` / `file://`。線上一律 no-op，
  `window.__poseLog` 為 `undefined`，設定面板也不會出現「匯出 log」按鈕。
- **只在演奏中記錄**：`main.js` 在 session 進入 `PLAYING` 時 `begin()`、離開時
  `end()`（歌曲結束 / 退出 / 關鏡頭都算一次「中斷」）。**含前導預覽那一節**
  （時間為負，見 §7）。
- **取得方式**：
  - devtools console 打 `__poseLog`（等同 `perfLog.getLog()`）。
  - 設定面板 →「除錯」→ **匯出 log**：下載 `poseLog-<時間戳>.json`。
  - 每次 `end()` 會 console 印一行摘要（幾幀 / 幾擊 / 幾段）。
- **資料只在記憶體**，重整頁面即消失；一個 run 上限 6 萬幀（安全閥）。

---

## 2. 頂層結構

```jsonc
{
  "runs": [ /* 每次演奏一個 run，見 §3 */ ]
}
```

## 3. run 物件

| 欄位 | 說明 |
|---|---|
| `id` | `run-1`、`run-2`…（本頁載入後遞增） |
| `meta` | 演奏情境，見 §4 |
| `startedAt` / `endedAt` | `Date.now()`（ms，Unix 時間） |
| `endReason` | 結束原因：`stopped`（一般離開 PLAYING）、`superseded`（未收尾又開新 run） |
| `frameCount` / `hitCount` | 這次的總幀數 / 總打擊數 |
| `standards` | 觸發標準參考，只記一次，見 §5 |
| `segments` | 分段軌跡，見 §6 |

## 4. meta

| 欄位 | 說明 |
|---|---|
| `song` | 歌名（如「中南美」） |
| `mode` | `"part"`（分部模式）或 `"song"`（影片歌曲模式） |
| `selectedMidi` | 分部模式所選鼓件的 MIDI 音高（Ride=51）；影片模式為 `null` |
| `limbMode` | `"off"` / `"standard"` / `"allKnee"` |
| `difficulty` | `"basic"`（四分）/ `"advanced"`（八分） |

## 5. standards（觸發標準參考，只記一次）

放**靜態門檻**（不會隨時間變的）。會被 adaptiveMonitor 漂移的**動態門檻**另外
逐幀記在 frame 裡（手：`pfHit*`；膝：`kDropHit*/kDropRel*/kDropStr*`），這樣既有基準
又看得出調整軌跡。

```jsonc
{
  "note": "手 pfHit 逐幀記（含提膝補償，同時是重新武裝線）；手速門檻比對下擊段峰值 spPk；膝 kDropHit/kDropRel/kDropStr 逐幀記（單位 = 肩寬 kScale）。其餘為靜態標準。",
  "hand": {
    "left":  { "PF_HIT": …, "SPEED_HIT": …, "COOLDOWN_MS": … },
    "right": { … }              // 未校準取不到 zone 參數時為 null
  },
  "knee": {
    "left":  { "windowDropHit": …, "windowDropRelease": …, "windowDropStrongHit": …,
               "peakSpeedHit": …, "cooldownMs": …,
               "maxXyRatio": …, "downFrameRatioHit": … },
    "right": { … }
  }
}
```

## 6. segments（分段軌跡）

一段 = **上一次事件到這次事件之間的逐幀緩衝 + 終結它的事件**。於是每個 hit
segment 就是「這一擊打下去之前 PF / 速度 / 膝蓋特徵怎麼走的」。

```jsonc
{
  "index": 0,
  "terminator": { … },   // 見下
  "frames": [ { …每幀… }, … ]   // 見 §8；hit 的最後一幀 = 觸發那一幀
}
```

### terminator（這段是被什麼結束的）

- **打擊**：`{ "type": "hit", "side": "left|right", "zone": "front|heel", "t": <ms>,`
  手擊另有 `"pf"`, `"speed"`（= 這一擊的下擊段峰值手速，即與 `SPEED_HIT` 比對的值）；`"at": {…}` }
  - `zone`：`front` = 手打大腿正面；`heel` = 膝蓋踢擊。
  - **`at`** = **觸發當幀的完整 frame 快照**（§8 全部欄位）。這是「與現實差多少」
    的核心：一擊即自帶當下所有實測值與（自動調整後的）門檻，不必回頭翻 frames。
- **中斷 / 結束**：`{ "type": "end", "reason": "stopped" }`（該段是這次演奏最後殘餘的緩衝）。

## 7. frame（逐幀，最重要）

`t` 是 `performance.now()`（牆鐘 ms），**不是**媒體時間，且**包含前導預覽**
（前導期媒體時間為負，但這裡的 `t` 一律遞增）。所有座標為 MediaPipe normalized
（0–1）；PF 已用大腿長度正規化；y 軸向下為正，故 `windowDy` 正值 = 向下掉。
數值皆四捨五入到小數 4 位（`null` = 該幀取不到）。

### 時間（每幀）

| 欄位 | 意義 |
|---|---|
| `det` | 這一格的推論耗時（ms）= 推論完成 − pose loop 拿到影格 |
| `age` | 相機拍到 → 推論完成（ms）。瀏覽器沒提供 `captureTime` 時為 `null` |

### 手部（Ride 這類手打樂器看這組）

| 欄位 | 意義 | 對照門檻 |
|---|---|---|
| `pfL` / `pfR` | 手到大腿線的垂距 PF（越小＝越貼大腿） | `pfHit*` |
| `spL` / `spR` | 單幀手速（normalized/秒），僅供參考 | — |
| `spPkL` / `spPkR` | 本次下擊段的峰值手速（PF 創新高時歸零；打擊當幀已歸零，請看 terminator 的 `speed`） | `spHit*` |
| `armL` / `armR` | 本幀判斷後是否「已武裝」（可再擊）。打擊當幀會變 `false`（剛解除武裝） | — |
| `pfHitL` / `pfHitR` | **動態**：`PF_HIT + 提膝補償`（低於它才可能觸發；高於它即重新武裝） | 實測 `pf*` |
| `spHitL` / `spHitR` | 速度門檻（下擊段峰值 ≥ 才算打擊） | 實測 `spPk*` |
| `kAdjL` / `kAdjR` | 提膝補償量（提膝時為正，門檻同步升高防誤觸） | — |

### 膝蓋（heel 觸發看這組）

時間窗固定 0.14 秒（不隨幀率變）；位移 / 速度皆**除以肩寬**（單位 = 肩寬、肩寬/秒），不受人離鏡頭遠近影響。

| 欄位 | 意義（= conditions.js 的實測量） | 對照門檻 |
|---|---|---|
| `kScale` | 身體尺度：肩寬 EMA（normalized；未量到時退回 0.2） | — |
| `kneeDyL/R` | `windowDy` 視窗內垂直位移（正 = 下掉） | `kDropHit*`（≥ 才觸發）、`kDropStr*` |
| `kneePkL/R` | `maxDownSpeed` 峰值下降速度 | `standards.knee.*.peakSpeedHit`（≥） |
| `kneeXyL/R` | `xyRatio` 水平/垂直比 | `standards.knee.*.maxXyRatio`（≤） |
| `kneeDfrL/R` | `downFrameRatio` 下降幀比例 | `standards.knee.*.downFrameRatioHit`（≥） |
| `kDropHitL/R` | **動態**：`windowDropHit`（adaptiveMonitor 近失調整） | 實測 `kneeDy*` |
| `kDropRelL/R` | **動態**：`windowDropRelease`（低於它才重新武裝） | 實測 `kneeDy*` |
| `kDropStrL/R` | **動態**：`windowDropStrongHit`（下落夠大就免看峰值速度；隨 `kDropHit` 等比縮放） | 實測 `kneeDy*` |
| `kArmL` / `kArmR` | 膝蓋本幀判斷後是否已武裝 | — |

## 8. 觸發條件（怎麼用上面欄位判斷「差多少」）

以下與 [`conditions.js`](./conditions.js) 一致。

**手部** —— 命中需同時：
```
armL == true  且  pfL ≤ pfHitL  且  spPkL ≥ spHitL     （右手同理換 R）
```
重新武裝：`pf > pfHit` 時 `arm` 轉回 true（已無獨立的 release 門檻）。另有 `COOLDOWN_MS` 節流。

**膝蓋** —— 命中需同時：
```
kArm == true
且 kneeDy ≥ kDropHit
且 (kneeDy ≥ kDropStr  或  kneePk ≥ peakSpeedHit)
且 kneeXy ≤ maxXyRatio
且 kneeDfr ≥ downFrameRatioHit
```
（`peakSpeedHit` 等靜態門檻在 `standards.knee.<side>`；`kDropHit/kDropRel/kDropStr` 在 frame。）
重新武裝：`kneeDy ≤ kDropRel`。另有 `cooldownMs` 節流。

> 診斷心法：某一擊若各實測值都遠優於門檻 → 觸發紮實；若剛好踩線或某條靠
> `或` 條件勉強過 → 偏敏感；`pf` 在 `pfHit` 附近反覆進出卻沒觸發、
> 且 `spPk` 偏低 → 動作太慢或懸停（速度門檻擋下）。膝蓋在手打樂器時頻繁觸發且 `kneeDy` 只略高於 `kDropHit` → 多半是
> 踏步誤觸，可考慮把 `limbMode` 設 `standard` 或收緊膝門檻。

## 9. 常用分析片段（貼進 console）

```js
// 每次膝擊的關鍵量 vs 門檻，看「差多少」
const std = __poseLog.runs.at(-1).standards.knee;
console.table(
  __poseLog.runs.at(-1).segments
    .filter(s => s.terminator.zone === "heel")
    .map(s => {
      const a = s.terminator.at, S = s.terminator.side, R = S === "left" ? "L" : "R";
      const t = std[S];
      return {
        side: S,
        dy: a["kneeDy"+R], dropHit: a["kDropHit"+R],
        strong: a["kDropStr"+R],
        pk: a["kneePk"+R], pkHit: t.peakSpeedHit,
      };
    })
);
```

```js
// 手擊：pf 與（自動調整後）門檻的裕度
console.table(
  __poseLog.runs.at(-1).segments
    .filter(s => s.terminator.zone === "front")
    .map(s => {
      const a = s.terminator.at, R = s.terminator.side === "left" ? "L" : "R";
      return { side: s.terminator.side, pf: s.terminator.pf,
               pfHit: a["pfHit"+R], 裕度: +(a["pfHit"+R] - s.terminator.pf).toFixed(3),
               sp: s.terminator.speed, spHit: a["spHit"+R] };
    })
);
```

```js
// pfHit 的漂移軌跡（看 adaptiveMonitor 怎麼調）
const fr = __poseLog.runs.at(-1).segments.flatMap(s => s.frames);
console.log("pfHitR:", fr[0].pfHitR, "→", fr.at(-1).pfHitR,
            "min", Math.min(...fr.map(f=>f.pfHitR).filter(x=>x!=null)),
            "max", Math.max(...fr.map(f=>f.pfHitR).filter(x=>x!=null)));
```

## 10. 注意事項

- `t` 是牆鐘、非媒體時間；要對回歌曲位置需另行換算（本 log 不含媒體時間）。
- `arm*` / `kArm*` 是**本幀判斷後**的狀態：打擊當幀為 `false`（剛解除武裝）。
- log 記的是**物理偵測到的打擊**。前導預覽期雖被 hitRouter 前奏閘門擋下不推進
  游標，該次偵測仍會入 log（對調參有用，能看到誤觸）。
- 座標是鏡像前的原始 normalized 值（畫面有 CSS `scaleX(-1)`，與 log 無關）。
- 靜態門檻只在 `standards` 記一次；若中途未校準（`hand.*` 為 `null`），代表那段
  沒有動態手部門檻可比。

## 10. 延遲時間軸（觸發 / 聲音 / 動畫時機）

每一擊的 `terminator.timing`（全部是 `performance.now()` 的 ms，可直接相減）：

| 欄位 | 時間點 | 來源 |
|---|---|---|
| `capT` | 相機拍到這一格 | `requestVideoFrameCallback` 的 `captureTime`（瀏覽器不給則 `null`） |
| `frameT` | pose loop 拿到這一格、開始推論 | `predictWebcam` 的 `webTimeMs` |
| `detEndT` | 推論完成 | `detectForVideo` callback 開頭 |
| `crossT` | 這一下 PF **首次** ≤ `PF_HIT` 的幀（僅手部） | `conditions.js` 的 `belowSinceMs` |
| `trigT` | 判定成立、即將發聲 | `dispatchHit` |
| `sound.outT` | 聲音真正從喇叭出來 | `getOutputTimestamp()` 換算 |
| `sound.outEstT` | 同上的備案估計 | 呼叫時間 + `baseLatency` + `outputLatency` |
| `animDrawT` | 特效畫進 canvas | `_fx.draw` 之後 |
| `animShowT` | ≈ 該畫面呈現到螢幕 | 下一個 rAF 的時間戳 |
| `gapMs` | 與同側上一擊的間隔（僅手部） | `conditions.js` |

`sound` 為 `undefined` = 這一擊**沒有發聲**（音色設成靜音，或歌曲模式下被閘門擋掉但也沒發提示音）。
`sound.kind`：`zone` 自由模式、`midi` 歌曲模式音符、`cue` 歌曲模式的提示音（前奏期 / 部位不符）。
HUD loop 排的節拍器不在打擊派發期內，不會被誤記。

**console 一鍵看**：`__poseTiming()` 印出每一擊的分段延遲：

| 欄 | 段落 | 偏大代表 |
|---|---|---|
| `cam` | 相機拍到 → 程式拿到 | 相機管線 / 曝光 / 低幀率 |
| `det` | 推論耗時 | 機器效能（模型、delegate、解析度） |
| `wait` | PF 越線 → 判定成立 | **判定邏輯**：速度門檻或冷卻擋住（0 = 越線當幀就觸發） |
| `snd` | 判定 → 喇叭出聲（`sndEst` 為備案估計） | 音訊輸出延遲（藍牙耳機常見 150ms+） |
| `anim` | 判定 → 畫面呈現 | 渲染 / 掉幀 |
| `total` | 相機拍到 → 喇叭出聲（取不到 `capT` 時從 `frameT` 起算並標 `*`） | 整條鏈 |

> 「手已經拍到但聲音很晚」的判讀：`wait` 大 → 判定邏輯；`cam`/`det` 大 → 偵測鏈；
> `snd` 大 → 音訊輸出；以上都小但仍覺得晚 → 多半是 `PF_HIT` 太低，越線本身就晚了
> （看 `pf`、`pfHit` 與 §9 的手擊裕度表）。

**自由模式也想錄**：console 打 `__poseLogBegin()` 開始，打幾下後 `__poseLogEnd()`，再 `__poseTiming()`。
