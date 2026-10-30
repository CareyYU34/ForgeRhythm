/**
 * palette.js
 *
 * 畫面配色的唯一來源：骨架（poseLoop.drawPoseLandmarks 霓虹光管）與打擊特效（hitEffects.js）
 * 都從這裡取色，讓「哪一側／哪種動作」在骨架和特效上永遠是同一個顏色。
 *
 *   left / right  左右側的手臂與腿光管＋手部打擊特效（pose left = 鏡像後畫面左邊）
 *   knee          提膝打擊特效；腿光管在膝蓋觸發時也會短暫轉成這個顏色
 *   crash         Crash 衝擊波（重擊）
 *   body          軀幹框、頭圈
 *
 * 每種動作只定主色，特效需要的第二色（粒子、能量線）由 secondaryOf() 往白色調亮推出，
 * 改顏色只需要改這一份。
 */

export const PALETTE = {
  left: [0, 220, 255],
  right: [255, 61, 61],
  knee: [40, 255, 140],
  crash: [255, 210, 87],
  body: [255, 255, 255],
};

/** 往白色混 t（0 = 原色，1 = 白） */
export function lighten(c, t) {
  return c.map((v) => Math.round(v + (255 - v) * t));
}

/** 特效第二色：crash 的白光要更白，其餘適度調亮 */
export function secondaryOf(key) {
  return lighten(PALETTE[key], key === "crash" ? 0.75 : 0.45);
}
