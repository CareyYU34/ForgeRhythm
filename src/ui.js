const HIT_LABELS = {
  left_front: "左腳正面",
  left_outer: "左腳外側",
  left_inner: "左腳內側",
  left_heel: "左腳跟",
  right_front: "右腳正面",
  right_outer: "右腳外側",
  right_inner: "右腳內側",
  right_heel: "右腳跟",
};

function createHitText(hit) {
  const text = document.createElement("span");
  text.className = "hit-text-item";
  text.textContent = hit.label;
  return text;
}

export function getHitLabel(side, zoneId) {
  return HIT_LABELS[`${side}_${zoneId}`] ?? `${side}_${zoneId}`;
}

export function initHitDisplay(container, maxItems = 3) {
  if (!container) {
    return { replaceHits() {} };
  }

  function render(hits) {
    container.replaceChildren(...hits.map(createHitText));
    container.classList.toggle("is-empty", hits.length === 0);
  }

  function replaceHits(hits) {
    const nextHits = Array.isArray(hits) ? hits.slice(0, maxItems) : [];
    render(nextHits);
  }

  render([]);
  return { replaceHits };
}

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

  range.addEventListener("input", () => {
    setFromDisplay(Number(range.value));
  });

  number.addEventListener("input", () => {
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

  return row;
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
  drawPoseDebugEnabled,
  showPFOverlay,
  onOutputGainChange,
  onVisibilityThresholdChange,
  onDrawPoseDebugChange,
  onShowPFOverlayChange,
}) {
  const controlsEl = panelEl.querySelector("#runtimeControls");
  const debugControlsEl = panelEl.querySelector("#debugControls");

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
      }),
    );

    controlsEl.appendChild(
      createNumericControl({
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
}
