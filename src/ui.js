export function bindCameraToggle({
  button,
  state,
  getPoseLandmarker,
  startWebcam,
  stopWebcam,
}) {
  button.onclick = async () => {
    if (!getPoseLandmarker()) return;
    state.running = !state.running;
    button.textContent = state.running ? "關閉鏡頭" : "開啟鏡頭";
    if (state.running) {
      await startWebcam();
    } else {
      stopWebcam();
    }
  };
}

function populateSelect(selectEl, selectedId, soundLibrary) {
  selectEl.innerHTML = "";
  for (const s of soundLibrary) {
    const opt = document.createElement("option");
    opt.value = s.id;
    opt.textContent = s.label;
    if (s.id === selectedId) opt.selected = true;
    selectEl.appendChild(opt);
  }
}

function createNumericControl({
  label,
  value,
  min,
  max,
  onChange,
  displayMin = min,
  displayMax = max,
  displayStep = 1,
  toDisplay = (v) => v,
  toInternal = (v) => v,
}) {
  const row = document.createElement("div");
  row.className = "settings-control-row";

  const title = document.createElement("label");
  title.className = "settings-control-label";
  title.textContent = label;

  const inputsWrap = document.createElement("div");
  inputsWrap.className = "settings-control-inputs";

  const range = document.createElement("input");
  range.type = "range";
  range.min = String(displayMin);
  range.max = String(displayMax);
  range.step = String(displayStep);

  const number = document.createElement("input");
  number.type = "number";
  number.min = String(displayMin);
  number.max = String(displayMax);
  number.step = String(displayStep);
  number.className = "settings-number-input";

  const clampInternal = (v) => Math.min(max, Math.max(min, v));
  const clampDisplay = (v) => Math.min(displayMax, Math.max(displayMin, v));

  const setFromDisplay = (nextDisplay) => {
    if (!Number.isFinite(nextDisplay)) return;
    const safeDisplay = Math.round(clampDisplay(nextDisplay));
    const safeInternal = clampInternal(toInternal(safeDisplay));
    const normalizedDisplay = Math.round(clampDisplay(toDisplay(safeInternal)));

    range.value = String(normalizedDisplay);
    number.value = String(normalizedDisplay);
    onChange(safeInternal);
  };

  const setFromInternal = (nextInternal) => {
    if (!Number.isFinite(nextInternal)) return;
    const safeInternal = clampInternal(nextInternal);
    const safeDisplay = Math.round(clampDisplay(toDisplay(safeInternal)));

    range.value = String(safeDisplay);
    number.value = String(safeDisplay);
    onChange(safeInternal);
  };

  // 距上次使用者操作在此時間窗內就不覆蓋顯示，避免打斷拖曳/輸入。
  // ⚠ 不能用 focus 判斷：range 被拖曳/點擊後仍保有 focus，以 focus 為準會讓
  //   syncDisplay 永久跳過（放開滑桿後自動下降也不會反映）。改用時間窗。
  const USER_EDIT_SUPPRESS_MS = 800;
  let lastUserEditMs = -Infinity;

  // 靜默同步顯示值：只更新兩個輸入框，不觸發 onChange。
  // 供外部（自動化調整）即時反映用。
  const syncDisplay = (nextInternal) => {
    if (!Number.isFinite(nextInternal)) return;
    if (performance.now() - lastUserEditMs < USER_EDIT_SUPPRESS_MS) return;
    const safeDisplay = Math.round(
      clampDisplay(toDisplay(clampInternal(nextInternal))),
    );
    const next = String(safeDisplay);
    if (range.value !== next) range.value = next;
    if (number.value !== next) number.value = next;
  };

  range.addEventListener("input", () => {
    lastUserEditMs = performance.now();
    setFromDisplay(Number(range.value));
  });

  number.addEventListener("input", () => {
    lastUserEditMs = performance.now();
    if (number.value.trim() === "") return;
    setFromDisplay(Number(number.value));
  });

  number.addEventListener("blur", () => {
    setFromDisplay(Number(number.value));
  });

  setFromInternal(value);

  inputsWrap.appendChild(range);
  inputsWrap.appendChild(number);
  row.appendChild(title);
  row.appendChild(inputsWrap);

  return { row, syncDisplay };
}

function createToggleControl({ label, value, onChange }) {
  const row = document.createElement("div");
  row.className = "settings-control-row settings-toggle-row";

  const title = document.createElement("div");
  title.className = "settings-control-label";
  title.textContent = label;

  const toggleWrap = document.createElement("button");
  toggleWrap.type = "button";
  toggleWrap.className = "settings-switch";
  toggleWrap.setAttribute("role", "switch");
  toggleWrap.setAttribute("aria-label", label);

  const toggleTrack = document.createElement("span");
  toggleTrack.className = "settings-switch-track";

  const toggleThumb = document.createElement("span");
  toggleThumb.className = "settings-switch-thumb";
  toggleTrack.appendChild(toggleThumb);

  toggleWrap.appendChild(toggleTrack);

  const syncButtonState = (enabled) => {
    toggleWrap.dataset.enabled = String(enabled);
    toggleWrap.setAttribute("aria-checked", String(enabled));
  };

  syncButtonState(value);

  toggleWrap.addEventListener("click", () => {
    const nextValue = toggleWrap.dataset.enabled !== "true";
    syncButtonState(nextValue);
    onChange(nextValue);
  });

  row.appendChild(title);
  row.appendChild(toggleWrap);

  return row;
}

/**
 * 三選一（以上）的下拉控制項，樣式沿用 .rack-select。
 * @param {{label:string, value:string, options:{value:string,label:string}[], onChange:(v:string)=>void}} opts
 */
function createSelectControl({ label, value, options, onChange }) {
  const row = document.createElement("div");
  row.className = "settings-control-row";

  const title = document.createElement("div");
  title.className = "settings-control-label";
  title.textContent = label;

  const sel = document.createElement("select");
  sel.className = "rack-select";
  for (const opt of options) {
    const o = document.createElement("option");
    o.value = opt.value;
    o.textContent = opt.label;
    if (opt.value === value) o.selected = true;
    sel.appendChild(o);
  }
  sel.addEventListener("change", () => onChange(sel.value));

  row.appendChild(title);
  row.appendChild(sel);
  return row;
}

export function bindSoundUI({ rackEl, soundLibrary, zones, zoneSound }) {
  rackEl.innerHTML = "";

  for (const side of ["left", "right"]) {
    const block = document.createElement("div");
    block.className = "zone-block";

    const header = document.createElement("div");
    header.className = "zone-header";
    header.textContent = side === "left" ? "左腿" : "右腿";

    const body = document.createElement("div");
    body.className = "zone-body";

    for (const z of zones) {
      const row = document.createElement("div");
      row.className = "zone-row";

      const label = document.createElement("div");
      label.className = "zone-label";
      label.textContent = z.label;

      const sel = document.createElement("select");
      sel.className = "rack-select";
      const key = `${side}_${z.id}`;
      sel.id = `sound_${key}`;

      populateSelect(sel, zoneSound[key], soundLibrary);

      sel.addEventListener("change", () => {
        zoneSound[key] = sel.value;
      });

      row.appendChild(label);
      row.appendChild(sel);
      body.appendChild(row);
    }

    block.appendChild(header);
    block.appendChild(body);
    rackEl.appendChild(block);
  }
}

export function initSettingsPanel({
  toggleBtn,
  panelEl,
  outputGain,
  visibilityThreshold,
  limbMode,
  advancedDifficulty,
  drawPoseDebugEnabled,
  showPFOverlay,
  onOutputGainChange,
  onVisibilityThresholdChange,
  onLimbModeChange,
  onAdvancedDifficultyChange,
  onDrawPoseDebugChange,
  onShowPFOverlayChange,
  // 讀取即時（自動化調整後）的可見度閾值。adaptiveMonitor 會在背景漂移
  // state.visibilityThreshold，UI 端輪詢此函式把最新值反映到控制項顯示。
  getLiveVisibilityThreshold,
}) {
  const controlsEl = panelEl.querySelector("#runtimeControls");
  const debugControlsEl = panelEl.querySelector("#debugControls");

  let visibilityControl = null;

  if (controlsEl) {
    controlsEl.innerHTML = "";

    controlsEl.appendChild(
      createNumericControl({
        label: "音量",
        value: outputGain,
        min: 1,
        max: 10,
        displayMin: 10,
        displayMax: 100,
        displayStep: 1,
        toDisplay: (internal) => internal * 10,
        toInternal: (display) => Number((display / 10).toFixed(3)),
        onChange: onOutputGainChange,
      }).row,
    );

    visibilityControl = createNumericControl({
      label: "模型可見度閾值",
      value: visibilityThreshold,
      min: 0,
      max: 1,
      displayMin: 10,
      displayMax: 100,
      displayStep: 1,
      toDisplay: (internal) => internal * 100,
      toInternal: (display) => Number((display / 100).toFixed(4)),
      onChange: onVisibilityThresholdChange,
    });
    controlsEl.appendChild(visibilityControl.row);

    // 歌曲模式部位配對（三選一）：
    //   off      = 任何部位都推進下一顆
    //   standard = 大鼓限膝蓋、其餘限手部
    //   allKnee  = 全部音符都限膝蓋
    controlsEl.appendChild(
      createSelectControl({
        label: "部位配對（歌曲模式）",
        value: limbMode,
        options: [
          { value: "off", label: "不配對（任何部位）" },
          { value: "standard", label: "標準（大鼓限膝蓋）" },
          { value: "allKnee", label: "全膝蓋" },
        ],
        onChange: onLimbModeChange,
      }),
    );

    // 歌曲模式難度：關閉 = 預設（四分，只吃四分位置音符）；
    // 開啟 = 進階（八分，吃全部音符）。於下次載入譜面（重新選歌）時生效。
    controlsEl.appendChild(
      createToggleControl({
        label: "進階難度（八分音符）",
        value: advancedDifficulty,
        onChange: onAdvancedDifficultyChange,
      }),
    );
  }

  if (debugControlsEl) {
    debugControlsEl.innerHTML = "";
    debugControlsEl.appendChild(
      createToggleControl({
        label: "全身節點",
        value: drawPoseDebugEnabled,
        onChange: onDrawPoseDebugChange,
      }),
    );

    debugControlsEl.appendChild(
      createToggleControl({
        label: "PF 值顯示",
        value: showPFOverlay,
        onChange: onShowPFOverlayChange,
      }),
    );
  }

  toggleBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    panelEl.classList.toggle("is-hidden");
  });

  panelEl.addEventListener("click", (e) => {
    e.stopPropagation();
  });

  document.addEventListener("click", () => {
    panelEl.classList.add("is-hidden");
  });

  // 即時反映自動化調整：輪詢 state.visibilityThreshold 並靜默同步到控制項顯示。
  // 面板關閉時不更新（省去無意義的 DOM 寫入）；使用者操作中由 syncDisplay 自行跳過。
  // adaptiveMonitor 約每 2s 才漂移一次，250ms 輪詢已等同即時。
  if (visibilityControl && typeof getLiveVisibilityThreshold === "function") {
    setInterval(() => {
      if (panelEl.classList.contains("is-hidden")) return;
      visibilityControl.syncDisplay(getLiveVisibilityThreshold());
    }, 250);
  }
}