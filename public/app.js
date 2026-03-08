const state = {
  books: [],
  tags: [],
  tracks: [],
  trackIndex: 0,
  selectedBook: null
};

const ambientTracks = {
  rain: "/audio/rain.mp3",
  wind: "/audio/wind.mp3",
  fire: "/audio/fire.mp3"
};

const ui = {
  searchForm: document.getElementById("book-search-form"),
  queryInput: document.getElementById("book-query"),
  status: document.getElementById("status"),
  results: document.getElementById("book-results"),
  coverImage: document.getElementById("focus-cover-image"),
  coverTitle: document.getElementById("focus-title"),
  coverAuthors: document.getElementById("focus-authors"),
  coverTags: document.getElementById("focus-tags"),
  trackImage: document.getElementById("track-image"),
  trackTitle: document.getElementById("track-title"),
  trackArtist: document.getElementById("track-artist"),
  player: document.getElementById("music-player"),
  skipButton: document.getElementById("skip-btn"),
  offlineButton: document.getElementById("offline-btn")
};

let audioCtx;
let musicSource;
let musicGain;
const ambientNodes = {};

const cachedSessionKey = "aura-reader-session";
const sessionCacheName = "aura-session-v1";
const sessionCachePath = "/offline/session.json";

const updateStatus = (text) => {
  ui.status.textContent = text;
};

const isNetworkError = (error) => error instanceof TypeError;

const ensureApiReachable = async () => {
  try {
    const response = await fetch("/api/health", { method: "GET", cache: "no-store" });
    return response.ok;
  } catch {
    return false;
  }
};

const getInitials = (title) => {
  const words = String(title || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  const initials = words
    .map((word) => word[0]?.toUpperCase() || "")
    .join("")
    .slice(0, 2);

  return initials || "AR";
};

const fallbackCoverUrl = (title) => {
  const initials = getInitials(title);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="300" viewBox="0 0 200 300"><rect width="100%" height="100%" fill="#2f7d57" /><text x="50%" y="50%" dominant-baseline="middle" text-anchor="middle" fill="#ffffff" font-family="Arial, sans-serif" font-size="64" font-weight="700">${initials}</text></svg>`;

  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
};

const withCoverFallback = (url, title) => (url ? url : fallbackCoverUrl(title));

const applyImageFallback = (img, title) => {
  if (!img) {
    return;
  }

  const fallback = fallbackCoverUrl(title);
  img.onerror = () => {
    img.onerror = null;
    img.src = fallback;
  };

  if (!img.src) {
    img.src = fallback;
  }
};

const saveSession = async () => {
  const payload = {
    tags: state.tags,
    tracks: state.tracks,
    selectedBook: state.selectedBook
  };

  localStorage.setItem(cachedSessionKey, JSON.stringify(payload));

  if ("caches" in window) {
    try {
      const cache = await caches.open(sessionCacheName);
      await cache.put(
        sessionCachePath,
        new Response(JSON.stringify(payload), {
          headers: { "Content-Type": "application/json" }
        })
      );
    } catch (error) {
      console.error("Could not cache session payload", error);
    }
  }
};

const applySession = (session) => {
  if (!session) {
    return;
  }

  try {
    if (session.selectedBook) {
      state.selectedBook = session.selectedBook;
      renderBookFocus();
    }

    if (Array.isArray(session.tags)) {
      state.tags = session.tags;
      ui.coverTags.textContent = session.tags.join(" • ");
    }

    if (Array.isArray(session.tracks) && session.tracks.length) {
      state.tracks = session.tracks;
      state.trackIndex = 0;
      updateTrackCard(false);
      updateStatus("Loaded last saved offline-ready session.");
    }
  } catch {
    localStorage.removeItem(cachedSessionKey);
  }
};

const loadSession = async () => {
  if (!navigator.onLine && "caches" in window) {
    try {
      const cache = await caches.open(sessionCacheName);
      const response = await cache.match(sessionCachePath);
      if (response) {
        const cachedSession = await response.json();
        applySession(cachedSession);
        return;
      }
    } catch (error) {
      console.error("Could not load session from Cache API", error);
    }
  }

  const value = localStorage.getItem(cachedSessionKey);
  if (!value) {
    return;
  }

  try {
    const session = JSON.parse(value);
    applySession(session);
  } catch {
    localStorage.removeItem(cachedSessionKey);
  }
};

const ensureAudioGraph = () => {
  if (audioCtx) {
    return;
  }

  audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  musicSource = audioCtx.createMediaElementSource(ui.player);
  musicGain = audioCtx.createGain();
  musicGain.gain.value = 1;
  musicSource.connect(musicGain).connect(audioCtx.destination);

  Object.entries(ambientTracks).forEach(([name, src]) => {
    const audio = new Audio(src);
    audio.loop = true;
    audio.crossOrigin = "anonymous";
    audio.preload = "auto";

    const source = audioCtx.createMediaElementSource(audio);
    const gain = audioCtx.createGain();
    gain.gain.value = 0;
    source.connect(gain).connect(audioCtx.destination);

    ambientNodes[name] = { audio, gain };
  });
};

const renderResults = () => {
  ui.results.innerHTML = "";

  state.books.forEach((book, index) => {
    const button = document.createElement("button");
    button.className = "w-full rounded-2xl border border-pine/20 bg-white p-3 text-left shadow-sm";
    button.innerHTML = `
      <div class=\"flex gap-3\">
        <img src=\"${withCoverFallback(book.cover, book.title)}\" alt=\"${book.title}\" class=\"h-20 w-14 rounded-lg object-cover bg-sand\" />
        <div>
          <p class=\"text-sm font-bold\">${book.title}</p>
          <p class=\"text-xs text-pine/70\">${book.authors.join(", ")}</p>
          <p class=\"mt-1 line-clamp-2 text-xs text-pine/80\">${book.description}</p>
        </div>
      </div>
    `;

    const imageEl = button.querySelector("img");
    applyImageFallback(imageEl, book.title);

    button.style.animationDelay = `${index * 80}ms`;
    button.addEventListener("click", () => selectBook(book));
    ui.results.appendChild(button);
  });
};

const renderBookFocus = () => {
  if (!state.selectedBook) {
    return;
  }

  ui.coverImage.src = withCoverFallback(state.selectedBook.cover, state.selectedBook.title);
  applyImageFallback(ui.coverImage, state.selectedBook.title);
  ui.coverTitle.textContent = state.selectedBook.title;
  ui.coverAuthors.textContent = state.selectedBook.authors.join(", ");
};

const updateTrackCard = async (autoplay = false) => {
  const track = state.tracks[state.trackIndex];
  if (!track) {
    ui.trackTitle.textContent = "No track loaded";
    ui.trackArtist.textContent = "Search and select a book";
    ui.trackImage.src = fallbackCoverUrl(state.selectedBook?.title || "Aura Reader");
    ui.player.removeAttribute("src");
    return;
  }

  ui.trackTitle.textContent = track.title;
  ui.trackArtist.textContent = track.artist;
  ui.trackImage.src = withCoverFallback(track.image || state.selectedBook?.cover, state.selectedBook?.title || track.title);
  applyImageFallback(ui.trackImage, state.selectedBook?.title || track.title);
  ui.player.src = track.audio;

  if (autoplay) {
    try {
      await ui.player.play();
    } catch {
      updateStatus("Soundtrack ready. Tap play to start.");
    }
  }
};

const nextTrack = async () => {
  if (!state.tracks.length) {
    return;
  }

  state.trackIndex = (state.trackIndex + 1) % state.tracks.length;
  await updateTrackCard(true);
};

const cacheForOffline = async () => {
  const urls = [
    ...state.tracks.map((track) => track.audio),
    ...state.tracks.map((track) => track.download).filter(Boolean),
    ...Object.values(ambientTracks)
  ];

  const deduped = [...new Set(urls)];

  if (navigator.serviceWorker?.controller) {
    navigator.serviceWorker.controller.postMessage({ type: "CACHE_URLS", payload: deduped });
    updateStatus("Offline cache started in Service Worker.");
  }

  await saveSession();
};

const loadTracksByTags = async (tags) => {
  if (!navigator.onLine) {
    updateStatus("Offline mode: loaded tracks from saved session.");
    return;
  }

  const response = await fetch(`/api/tracks?tags=${encodeURIComponent(tags.join(","))}`);
  if (!response.ok) {
    let message = "Track fetch failed";
    try {
      const payload = await response.json();
      if (payload?.error) {
        message = payload.error;
      }
    } catch {
      // Keep fallback message when body is not JSON.
    }

    throw new Error(message);
  }

  const data = await response.json();
  state.tracks = data.tracks || [];
  state.trackIndex = 0;

  if (!state.tracks.length) {
    throw new Error("No instrumental tracks found for this mood. Try another book.");
  }

  await updateTrackCard(true);
};

const selectBook = async (book) => {
  state.selectedBook = book;
  renderBookFocus();
  ui.results.classList.add("hidden");
  updateStatus("Analyzing book mood...");

  if (!navigator.onLine) {
    await loadSession();
    return;
  }

  try {
    try {
      ensureAudioGraph();
      if (audioCtx?.state === "suspended") {
        await audioCtx.resume();
      }
    } catch {
      // Ignore resume issues and continue fetching.
    }

    const moodResponse = await fetch("/api/moods", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ description: book.description })
    });

    if (!moodResponse.ok) {
      throw new Error("Mood generation failed");
    }

    const moodData = await moodResponse.json();
    state.tags = moodData.tags || [];
    ui.coverTags.textContent = state.tags.join(" • ");

    updateStatus("Fetching instrumental tracks...");
    await loadTracksByTags(state.tags);

    await saveSession();
    if (state.tracks.length) {
      updateStatus("Aura soundtrack is ready.");
    }
  } catch (error) {
    console.error(error);
    updateStatus(error?.message || "Could not build soundtrack for this book.");
  }
};

const setupMixerEvents = () => {
  document.querySelectorAll(".ambient-row").forEach((row) => {
    const sound = row.dataset.sound;
    const toggle = row.querySelector(".ambient-toggle");
    const volume = row.querySelector(".ambient-volume");

    toggle.addEventListener("change", async () => {
      ensureAudioGraph();
      await audioCtx.resume();

      if (!ambientNodes[sound]) {
        return;
      }

      if (toggle.checked) {
        await ambientNodes[sound].audio.play().catch(() => {});
        ambientNodes[sound].gain.gain.value = Number(volume.value);
      } else {
        ambientNodes[sound].gain.gain.value = 0;
        ambientNodes[sound].audio.pause();
      }
    });

    volume.addEventListener("input", () => {
      if (!ambientNodes[sound]) {
        return;
      }

      ambientNodes[sound].gain.gain.value = toggle.checked ? Number(volume.value) : 0;
    });
  });
};

const searchBooks = async (query) => {
  updateStatus("Searching books...");

  if (!navigator.onLine) {
    updateStatus("Offline mode: book search unavailable, using saved session only.");
    await loadSession();
    return;
  }

  const apiReachable = await ensureApiReachable();
  if (!apiReachable) {
    throw new Error("Server unreachable. Start BookAura API and try again.");
  }

  let response;
  try {
    response = await fetch(`/api/books?query=${encodeURIComponent(query)}`);
  } catch (error) {
    if (isNetworkError(error)) {
      throw new Error("Network error while searching books. Check your connection and server status.");
    }

    throw error;
  }

  if (!response.ok) {
    let message = "Book search failed.";

    try {
      const payload = await response.json();
      if (payload?.error) {
        message = payload.error;
      }
    } catch {
      // Keep generic fallback if response body is not JSON.
    }

    throw new Error(message);
  }

  const data = await response.json();
  state.books = data.books || [];
  ui.results.classList.remove("hidden");
  renderResults();
  updateStatus(state.books.length ? "Select a book to generate music." : "No books found.");
};

const registerServiceWorker = async () => {
  if (!("serviceWorker" in navigator)) {
    return;
  }

  try {
    const registration = await navigator.serviceWorker.register("/sw.js");

    const promptRefresh = () => {
      if (registration.waiting) {
        registration.waiting.postMessage({ type: "SKIP_WAITING" });
      }
    };

    registration.addEventListener("updatefound", () => {
      const installing = registration.installing;
      if (!installing) {
        return;
      }

      installing.addEventListener("statechange", () => {
        if (installing.state === "installed" && navigator.serviceWorker.controller) {
          promptRefresh();
        }
      });
    });

    if (registration.waiting) {
      promptRefresh();
    }

    let refreshed = false;
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (refreshed) {
        return;
      }

      refreshed = true;
      window.location.reload();
    });

    await registration.update();
  } catch (error) {
    console.error("Service Worker registration failed", error);
  }
};

ui.searchForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const query = ui.queryInput.value.trim();
  if (!query) {
    return;
  }

  try {
    await searchBooks(query);
  } catch (error) {
    console.error(error);
    if (isNetworkError(error)) {
      updateStatus("Network error while searching books. Please check your internet and try again.");
      return;
    }

    updateStatus(error?.message || "Book search failed.");
  }
});

ui.skipButton.addEventListener("click", nextTrack);
ui.player.addEventListener("play", async () => {
  ensureAudioGraph();
  await audioCtx.resume();
});
ui.player.addEventListener("ended", nextTrack);
ui.offlineButton.addEventListener("click", cacheForOffline);

setupMixerEvents();
loadSession();
registerServiceWorker();
