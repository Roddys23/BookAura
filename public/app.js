let recentTrackIds = [];

const state = {
  books: [],
  tags: [],
  tracks: [],
  trackIndex: 0,
  selectedBook: null,
  blockedTrackIdsByBookId: {},
  moodTagsByBookId: {}
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
  player: document.getElementById("music-player"),
  playPauseButton: document.getElementById("play-pause-btn"),
  banTrackButton: document.getElementById("ban-track-btn"),
  offlineButton: document.getElementById("offline-btn")
};

let audioCtx;
const ambientNodes = {};

const cachedSessionKey = "aura-reader-session";
const blockedTracksKey = "aura-blocked-tracks-by-book-id";
const moodHistoryKey = "aura-moods-by-book-id";
const sessionCacheName = "aura-session-v1";
const sessionCachePath = "/offline/session.json";
const defaultCoverLogoPath = "/logo/Screenshot_20260308_230255_Photos.jpg";

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

const initialsFallbackCoverUrl = (title) => {
  const initials = getInitials(title);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="300" viewBox="0 0 200 300"><rect width="100%" height="100%" fill="#2f7d57" /><text x="50%" y="50%" dominant-baseline="middle" text-anchor="middle" fill="#ffffff" font-family="Arial, sans-serif" font-size="64" font-weight="700">${initials}</text></svg>`;

  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
};

const fallbackCoverUrl = () => defaultCoverLogoPath;

const withCoverFallback = (url, title) => (url ? url : fallbackCoverUrl(title));

const applyImageFallback = (img, title) => {
  if (!img) {
    return;
  }

  const fallback = fallbackCoverUrl(title);
  const initialsFallback = initialsFallbackCoverUrl(title);
  img.onerror = () => {
    if (img.src.includes(defaultCoverLogoPath)) {
      img.onerror = null;
      img.src = initialsFallback;
      return;
    }

    img.onerror = null;
    img.src = fallback;
  };

  if (!img.src) {
    img.src = fallback;
  }
};

const getCurrentBookId = () => String(state.selectedBook?.id || "").trim();

const getBlockedTrackIdsForCurrentBook = () => {
  const bookId = getCurrentBookId();
  if (!bookId) {
    return new Set();
  }

  const blocked = state.blockedTrackIdsByBookId[bookId];
  return new Set(Array.isArray(blocked) ? blocked : []);
};

const setBlockedTrackIdsForCurrentBook = (ids) => {
  const bookId = getCurrentBookId();
  if (!bookId) {
    return;
  }

  state.blockedTrackIdsByBookId[bookId] = [...new Set(ids)];
};

const saveSession = async () => {
  const payload = {
    tags: state.tags,
    tracks: state.tracks,
    selectedBook: state.selectedBook,
    blockedTrackIdsByBookId: state.blockedTrackIdsByBookId,
    moodTagsByBookId: state.moodTagsByBookId
  };

  localStorage.setItem(cachedSessionKey, JSON.stringify(payload));
  localStorage.setItem(blockedTracksKey, JSON.stringify(state.blockedTrackIdsByBookId));
  localStorage.setItem(moodHistoryKey, JSON.stringify(state.moodTagsByBookId));

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

    if (session.blockedTrackIdsByBookId && typeof session.blockedTrackIdsByBookId === "object") {
      state.blockedTrackIdsByBookId = session.blockedTrackIdsByBookId;
    }

    if (session.moodTagsByBookId && typeof session.moodTagsByBookId === "object") {
      state.moodTagsByBookId = session.moodTagsByBookId;
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
      }
    } catch (error) {
      console.error("Could not load session from Cache API", error);
    }
  }

  const sessionValue = localStorage.getItem(cachedSessionKey);
  if (sessionValue) {
    try {
      const session = JSON.parse(sessionValue);
      applySession(session);
    } catch {
      localStorage.removeItem(cachedSessionKey);
    }
  }

  try {
    const blocked = JSON.parse(localStorage.getItem(blockedTracksKey) || "{}");
    if (blocked && typeof blocked === "object") {
      state.blockedTrackIdsByBookId = blocked;
    }
  } catch {
    localStorage.removeItem(blockedTracksKey);
  }

  try {
    const moods = JSON.parse(localStorage.getItem(moodHistoryKey) || "{}");
    if (moods && typeof moods === "object") {
      state.moodTagsByBookId = moods;
    }
  } catch {
    localStorage.removeItem(moodHistoryKey);
  }
};

const ensureAudioGraph = () => {
  if (audioCtx) {
    return;
  }

  if (!(window.AudioContext || window.webkitAudioContext)) {
    return;
  }

  audioCtx = new (window.AudioContext || window.webkitAudioContext)();

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
    ui.player.pause();
    ui.player.removeAttribute("src");
    ui.player.load();
    if (ui.playPauseButton) {
      ui.playPauseButton.textContent = "Play";
    }
    return;
  }

  ui.player.src = track.audio;
  ui.player.load();

  // --- INSERT BACKGROUND PLAY LOGIC HERE ---
  if ('mediaSession' in navigator) {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: track.title || 'Aura Track',
      artist: 'Aura Reader',
      album: state.currentBook?.title || 'Ambient Library',
      artwork: [
        { src: state.currentBook?.thumbnail || '', sizes: '512x512', type: 'image/png' }
      ]
    });

    // Enables the "Next" button on your lock screen
    navigator.mediaSession.setActionHandler('nexttrack', () => {
      nextTrack();
    });

    // Enables the "Pause/Play" buttons on your lock screen
    navigator.mediaSession.setActionHandler('play', () => ui.player.play());
    navigator.mediaSession.setActionHandler('pause', () => ui.player.pause());
  }
  // ------------------------------------------

  if (autoplay) {
    try {
      await ui.player.play();
      if (ui.playPauseButton) {
        ui.playPauseButton.textContent = "Pause";
      }
    } catch {
      updateStatus("Soundtrack ready. Tap play to start.");
      if (ui.playPauseButton) {
        ui.playPauseButton.textContent = "Play";
      }
    }
  } else if (ui.playPauseButton) {
    ui.playPauseButton.textContent = "Play";
  }
};

const nextTrack = async () => {
  if (!state.tracks.length) {
    return;
  }

  const blockedIds = getBlockedTrackIdsForCurrentBook();
  const startingIndex = state.trackIndex;
  let fallbackIndex = (startingIndex + 1) % state.tracks.length;

  do {
    state.trackIndex = (state.trackIndex + 1) % state.tracks.length;
    const track = state.tracks[state.trackIndex];

    if (!track) {
      continue;
    }

    if (state.trackIndex === fallbackIndex) {
      fallbackIndex = state.trackIndex;
    }

    if (!blockedIds.has(track.id) && !recentTrackIds.includes(track.id)) {
      recentTrackIds.push(track.id);
      if (recentTrackIds.length > 3) {
        recentTrackIds.shift();
      }

      await updateTrackCard(true);
      return;
    }
  } while (state.trackIndex !== startingIndex);

  state.trackIndex = fallbackIndex;
  const fallbackTrack = state.tracks[state.trackIndex];
  if (fallbackTrack?.id) {
    recentTrackIds.push(fallbackTrack.id);
    if (recentTrackIds.length > 3) {
      recentTrackIds.shift();
    }
  }

  await updateTrackCard(true);
};

const banCurrentTrack = async () => {
  const currentTrack = state.tracks[state.trackIndex];
  if (!currentTrack) {
    return;
  }

  const blockedIds = getBlockedTrackIdsForCurrentBook();
  blockedIds.add(currentTrack.id);
  setBlockedTrackIdsForCurrentBook([...blockedIds]);
  await saveSession();

  if (blockedIds.size >= state.tracks.length) {
    updateStatus("All tracks are blocked for this book. Pick another book to continue.");
    ui.player.pause();
    ui.player.removeAttribute("src");
    ui.player.load();
    if (ui.playPauseButton) {
      ui.playPauseButton.textContent = "Play";
    }
    return;
  }

  await nextTrack();
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
  const blockedIds = getBlockedTrackIdsForCurrentBook();
  state.tracks = (data.tracks || []).filter((track) => !blockedIds.has(track.id));
  state.trackIndex = 0;

  if (!state.tracks.length) {
    throw new Error("No playable local aura tracks found for this mood.");
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
    ensureAudioGraph();
    if (audioCtx?.state === "suspended") {
      await audioCtx.resume().catch(() => {});
    }

    const cachedTags = Array.isArray(state.moodTagsByBookId[book.id])
      ? state.moodTagsByBookId[book.id].slice(0, 3)
      : [];

    if (cachedTags.length) {
      state.tags = cachedTags;
      ui.coverTags.textContent = state.tags.join(" • ");
      updateStatus("Using saved moods for this book...");
    } else {
      const moodResponse = await fetch("/api/moods", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ description: book.description })
      });

      if (!moodResponse.ok) {
        throw new Error("Mood generation failed");
      }

      const moodData = await moodResponse.json();
      state.tags = (moodData.tags || []).slice(0, 3);
      state.moodTagsByBookId[book.id] = state.tags;
      ui.coverTags.textContent = state.tags.join(" • ");
    }

    updateStatus("Fetching local aura tracks...");
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
      if (!audioCtx) {
        return;
      }

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
    response = await fetch(`https://bookaura-dkm4.onrender.com/api/books?query=${encodeURIComponent(query)}`);
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

const handleSearch = async (e) => {
  e.preventDefault();
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
};

ui.searchForm.addEventListener("submit", handleSearch);

ui.player.addEventListener("play", () => {
  if (ui.playPauseButton) {
    ui.playPauseButton.textContent = "Pause";
  }

  if (!audioCtx || audioCtx.state !== "suspended") {
    return;
  }

  audioCtx.resume().catch(() => {});
});

ui.player.addEventListener("pause", () => {
  if (ui.playPauseButton) {
    ui.playPauseButton.textContent = "Play";
  }
});

ui.player.addEventListener("error", () => {
  const errorCode = ui.player.error?.code;
  if (errorCode === MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED) {
    updateStatus("Track source is unsupported or blocked. Trying another track.");
    nextTrack();
    return;
  }

  updateStatus("Could not play this track. Trying another one.");
  nextTrack();
});

ui.player.addEventListener("ended", nextTrack);

ui.playPauseButton?.addEventListener("click", async () => {
  if (!ui.player.src) {
    if (!state.tracks.length) {
      updateStatus("Select a book first to start playback.");
      return;
    }

    await updateTrackCard(false);
  }

  if (ui.player.paused) {
    try {
      await ui.player.play();
    } catch {
      updateStatus("Tap play again to allow audio playback.");
    }
    return;
  }

  ui.player.pause();
});

ui.banTrackButton?.addEventListener("click", banCurrentTrack);
ui.offlineButton.addEventListener("click", cacheForOffline);

setupMixerEvents();
loadSession();
registerServiceWorker();

ui.player.addEventListener('ended', () => nextTrack());
