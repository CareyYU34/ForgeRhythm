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
