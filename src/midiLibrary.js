const MIDI_LIBRARY_API = "https://imuse.ncnu.edu.tw/Midi-library/api";
const SEARCH_DEBOUNCE_MS = 300;

function debounce(fn, delay) {
  let timerId = null;

  return (...args) => {
    window.clearTimeout(timerId);
    timerId = window.setTimeout(() => fn(...args), delay);
  };
}

function buildSearchUrl({ query, category }) {
  const url = new URL(`${MIDI_LIBRARY_API}/midis`);
  url.searchParams.set("page", "1");
  url.searchParams.set("limit", "1000");
  url.searchParams.set("sort", "uploaded_at");
  url.searchParams.set("order", "desc");

  if (query) {
    url.searchParams.set("q", query);
  }

  if (category) {
    url.searchParams.set("category", category);
  }

  return url.toString();
}

function normalizeCategories(payload) {
  if (!payload) return [];

  const source = Array.isArray(payload)
    ? payload
    : Array.isArray(payload.items)
      ? payload.items
      : Array.isArray(payload.data)
        ? payload.data
        : [];

  return source
    .map((item) => {
      if (typeof item === "string") return item.trim();
      if (item && typeof item === "object") {
        return (
          item.name ||
          item.title ||
          item.category ||
          item.categories_text ||
          item.label ||
          ""
        ).trim();
      }
      return "";
    })
    .filter(Boolean);
}

function extractItemCategories(item) {
  const categories = [];

  if (Array.isArray(item.categories)) {
    categories.push(...item.categories);
  }

  if (typeof item.categories_text === "string") {
    categories.push(...item.categories_text.split(/[\u3001,/]/));
  }

  return categories.map((category) => category.trim()).filter(Boolean);
}

function formatSongOption(item) {
  const composer = item.composer ? ` - ${item.composer}` : "";
  return `${item.title || "\u672a\u547d\u540d\u6b4c\u66f2"}${composer}`;
}

function renderCategoryOptions(selectEl, categories, selectedValue) {
  selectEl.replaceChildren();

  const defaultOption = document.createElement("option");
  defaultOption.value = "";
  defaultOption.textContent = "\u5168\u90e8\u985e\u5225";
  selectEl.append(defaultOption);

  categories.forEach((category) => {
    const option = document.createElement("option");
    option.value = category;
    option.textContent = category;
    option.selected = category === selectedValue;
    selectEl.append(option);
  });
}

function renderSongOptions(
  selectEl,
  items,
  placeholder = "\u8acb\u9078\u64c7\u6b4c\u66f2",
) {
  selectEl.replaceChildren();

  const defaultOption = document.createElement("option");
  defaultOption.value = "";
  defaultOption.textContent = placeholder;
  selectEl.append(defaultOption);

  items.forEach((item) => {
    const option = document.createElement("option");
    option.value = item.id;
    option.textContent = formatSongOption(item);
    selectEl.append(option);
  });
}

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
    },
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  return response.json();
}

export function initMidiLibraryPicker() {
  const songQueryEl = document.getElementById("midiSongQuery");
  const categoryEl = document.getElementById("midiCategory");
  const songSelectEl = document.getElementById("midiSongSelect");
  const ytUrlEl = document.getElementById("ytUrl");

  if (!songQueryEl || !categoryEl || !songSelectEl || !ytUrlEl) {
    return;
  }

  const state = {
    items: [],
    categorySet: new Set(),
    requestToken: 0,
  };

  const syncCategoriesFromItems = (items) => {
    items.forEach((item) => {
      extractItemCategories(item).forEach((category) =>
        state.categorySet.add(category),
      );
    });

    const sortedCategories = [...state.categorySet].sort((a, b) =>
      a.localeCompare(b, "zh-Hant"),
    );
    renderCategoryOptions(categoryEl, sortedCategories, categoryEl.value);
  };

  const searchSongs = async () => {
    const currentToken = ++state.requestToken;
    const query = songQueryEl.value.trim();
    const category = categoryEl.value.trim();

    songSelectEl.disabled = true;
    renderSongOptions(songSelectEl, [], "\u641c\u5c0b\u4e2d...");

    try {
      const payload = await fetchJson(buildSearchUrl({ query, category }));

      if (currentToken !== state.requestToken) {
        return;
      }

      state.items = Array.isArray(payload.items) ? payload.items : [];
      syncCategoriesFromItems(state.items);
      renderSongOptions(
        songSelectEl,
        state.items,
        state.items.length
          ? "\u8acb\u9078\u64c7 API \u6b4c\u66f2"
          : "\u627e\u4e0d\u5230\u7b26\u5408\u689d\u4ef6\u7684\u6b4c\u66f2",
      );
      songSelectEl.disabled = state.items.length === 0;
    } catch (error) {
      if (currentToken !== state.requestToken) {
        return;
      }

      state.items = [];
      renderSongOptions(songSelectEl, [], "API \u8b80\u53d6\u5931\u6557");
      songSelectEl.disabled = true;
      console.error("Failed to fetch midi library songs:", error);
    }
  };

  const debouncedSearch = debounce(searchSongs, SEARCH_DEBOUNCE_MS);

  const loadCategories = async () => {
    const endpoints = [
      `${MIDI_LIBRARY_API}/categories`,
      `${MIDI_LIBRARY_API}/midis/categories`,
      `${MIDI_LIBRARY_API}/public/categories`,
    ];

    for (const endpoint of endpoints) {
      try {
        const payload = await fetchJson(endpoint);
        const categories = normalizeCategories(payload);

        if (!categories.length) {
          continue;
        }

        categories.forEach((category) => state.categorySet.add(category));
        syncCategoriesFromItems([]);
        return;
      } catch (error) {
        console.warn(`Failed to load categories from ${endpoint}:`, error);
      }
    }
  };

  songQueryEl.addEventListener("input", debouncedSearch);
  categoryEl.addEventListener("change", searchSongs);

  songSelectEl.addEventListener("change", () => {
    const selectedId = songSelectEl.value;
    const selectedSong = state.items.find((item) => item.id === selectedId);

    if (!selectedSong) {
      return;
    }

    ytUrlEl.value = (selectedSong.description || "").trim();
  });

  loadCategories().finally(() => {
    searchSongs();
  });
}
