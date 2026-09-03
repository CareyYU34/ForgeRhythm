/**
 * songMode/manifest.js
 *
 * 本機歌曲清單。
 *
 * ⚠ 檔名一律使用 ASCII。
 *   原始素材檔名含中文（月亮代表我的心_h264.mp4），fetch 必須 encodeURI
 *   才不會失敗。改名後這個陷阱直接消失。
 *
 * ⚠ bpm / noteCount / duration 僅供清單顯示，避免點擊前就得載入 JSON。
 *   發聲用的數值一律以 chartLoader 的解析結果為準，兩邊不一致時以後者為對。
 */

export const SONG_LIBRARY = [
  {
    id: "moon",
    title: "月亮代表我的心",
    video: "./assets/songs/moon/video.mp4",
    chart: "./assets/songs/moon/chart.json",
    /** 無縮圖時清單顯示占位方塊 */
    cover: null,
    bpm: 78,
    noteCount: 487,
    duration: "3:41",
  },
];
