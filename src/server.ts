import cors from "cors";
import dotenv from "dotenv";
import express, { Request, Response } from "express";
import path from "path";
import Groq from "groq-sdk";

dotenv.config();

const app = express();
const port = process.env.PORT || 3000;

const publicDir = path.resolve(process.cwd(), "public");

app.use(cors());
app.use(express.json({ limit: "1mb" }));
app.use(express.static(publicDir));

type BookResult = {
  id: string;
  title: string;
  authors: string[];
  description: string;
  cover: string;
};

type PixabayAudioVariant =
  | string
  | {
      url?: string;
    };

type PixabayTrack = {
  id: number | string;
  tags?: string;
  duration?: number;
  downloads?: number;
  pageURL?: string;
  user?: string;
  userImageURL?: string;
  audio?: Record<string, PixabayAudioVariant | undefined>;
};

const groqApiKey = process.env.GROQ_API_KEY;
const pixabayApiKey = process.env.PIXABAY_API_KEY;
const googleBooksApiKey = process.env.GOOGLE_BOOKS_API_KEY;

const groq = groqApiKey ? new Groq({ apiKey: groqApiKey }) : null;

const cleanCoverUrl = (url?: string): string => {
  if (!url) {
    return "";
  }

  return url.replace("http://", "https://").replace(/&zoom=\d+/i, "");
};

const cleanMediaUrl = (url?: string): string => {
  if (!url) {
    return "";
  }

  return url.replace(/^http:\/\//i, "https://");
};

const trimDescription = (description: string): string =>
  description.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();

const toTitleCase = (value: string): string =>
  value
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(" ");

const getPixabayAudioUrl = (track: PixabayTrack): string => {
  const audio = track.audio;
  if (!audio) {
    return "";
  }

  const variants = [audio.high, audio.medium, audio.low];
  for (const variant of variants) {
    if (typeof variant === "string") {
      return cleanMediaUrl(variant);
    }

    if (variant?.url) {
      return cleanMediaUrl(variant.url);
    }
  }

  return "";
};

const buildTrackTitle = (track: PixabayTrack): string => {
  const tags = String(track.tags || "")
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean)
    .slice(0, 3);

  if (!tags.length) {
    return `Instrumental Track ${track.id}`;
  }

  return toTitleCase(tags.join(" "));
};

const deriveFallbackMoodTags = (description: string): string[] => {
  const text = description.toLowerCase();

  const keywordBuckets: Array<{ words: string[]; tag: string }> = [
    { words: ["battle", "war", "fight", "hero", "epic", "quest"], tag: "epic" },
    { words: ["mystery", "detective", "crime", "secret", "thriller"], tag: "mysterious" },
    { words: ["love", "romance", "heart", "relationship"], tag: "romantic" },
    { words: ["dark", "horror", "fear", "ghost", "haunted"], tag: "dark" },
    { words: ["future", "space", "cyber", "robot", "sci-fi"], tag: "cinematic" },
    { words: ["sad", "loss", "grief", "melancholy", "lonely"], tag: "emotional" },
    { words: ["calm", "peace", "nature", "forest", "sea"], tag: "ambient" },
    { words: ["rain", "night", "city", "noir"], tag: "atmospheric" }
  ];

  const tags: string[] = [];
  for (const bucket of keywordBuckets) {
    if (bucket.words.some((word) => text.includes(word))) {
      tags.push(bucket.tag);
    }

    if (tags.length === 3) {
      break;
    }
  }

  while (tags.length < 3) {
    const defaults = ["cinematic", "ambient", "emotional"];
    const next = defaults.find((tag) => !tags.includes(tag));
    if (!next) {
      break;
    }

    tags.push(next);
  }

  return tags.slice(0, 3);
};


const getOpenLibraryCoverFromIsbn = (identifiers?: Array<{ type?: string; identifier?: string }>): string => {
  if (!Array.isArray(identifiers)) {
    return "";
  }

  const isbn = identifiers
    .map((entry) => ({ type: String(entry.type || "").toUpperCase(), id: String(entry.identifier || "").trim() }))
    .filter((entry) => entry.id)
    .find((entry) => entry.type === "ISBN_13" || entry.type === "ISBN_10");

  if (!isbn) {
    return "";
  }

  return `https://covers.openlibrary.org/b/isbn/${encodeURIComponent(isbn.id)}-L.jpg?default=false`;
};

app.get("/api/health", (_req: Request, res: Response) => {
  res.status(200).json({ status: "ok", timestamp: new Date().toISOString() });
});

app.get("/api/books", async (req: Request, res: Response) => {
  const query = String(req.query.query || "").trim();

  if (!query) {
    res.status(400).json({ error: "Missing query parameter 'query'." });
    return;
  }

  try {
    const params = new URLSearchParams({
      q: query,
      maxResults: "8",
      printType: "books"
    });

    if (googleBooksApiKey) {
      params.set("key", googleBooksApiKey);
    }

    const apiUrl = `https://www.googleapis.com/books/v1/volumes?${params.toString()}`;
    const response = await fetch(apiUrl);

    if (!response.ok) {
      if (response.status === 429) {
        res.status(429).json({ error: "Google Books rate limit reached. Please try again shortly." });
        return;
      }

      res.status(response.status).json({ error: `Google Books request failed (${response.status}).` });
      return;
    }

    const payload = (await response.json()) as {
      items?: Array<{
        id: string;
        volumeInfo?: {
          title?: string;
          authors?: string[];
          description?: string;
          industryIdentifiers?: Array<{
            type?: string;
            identifier?: string;
          }>;
          imageLinks?: {
            extraLarge?: string;
            large?: string;
            medium?: string;
            thumbnail?: string;
            smallThumbnail?: string;
          };
        };
      }>;
    };

    const books: BookResult[] = (payload.items || []).map((item) => {
      const info = item.volumeInfo || {};
      const images = info.imageLinks || {};
      const primaryCover = cleanCoverUrl(images.extraLarge || images.large || images.medium || images.thumbnail || images.smallThumbnail);
      const backupCover = getOpenLibraryCoverFromIsbn(info.industryIdentifiers);

      return {
        id: item.id,
        title: info.title || "Untitled",
        authors: info.authors || ["Unknown"],
        description: trimDescription(info.description || "No description available."),
        cover: primaryCover || backupCover
      };
    });

    res.json({ books });
  } catch (error) {
    console.error("/api/books error", error);
    res.status(500).json({ error: "Failed to fetch books." });
  }
});

app.post("/api/moods", async (req: Request, res: Response) => {
  const description = String(req.body?.description || "").trim();

  if (!description) {
    res.status(400).json({ error: "Missing book description." });
    return;
  }

  if (!groq) {
    res.json({ tags: deriveFallbackMoodTags(description), source: "fallback" });
    return;
  }

  try {
    const completion = await groq.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      temperature: 0.5,
      messages: [
        {
          role: "system",
          content:
            "You return exactly 3 concise, specific musical mood tags for a book description. Output strict JSON as {\"tags\":[\"tag one\",\"tag two\",\"tag three\"]}."
        },
        {
          role: "user",
          content: description
        }
      ]
    });

    const text = completion.choices[0]?.message?.content || "";
    let tags: string[] = [];

    try {
      const parsed = JSON.parse(text) as { tags?: string[] };
      tags = (parsed.tags || []).map((tag) => tag.trim().toLowerCase()).filter(Boolean);
    } catch {
      const fallback = text
        .replace(/[\[\]{}"']/g, "")
        .split(/[\n,]/)
        .map((part) => part.trim().toLowerCase())
        .filter(Boolean);
      tags = fallback.slice(0, 3);
    }

    if (tags.length < 3) {
      tags = deriveFallbackMoodTags(`${description} ${tags.join(" ")}`);
    }

    res.json({ tags, source: "groq" });
  } catch (error) {
    console.error("/api/moods error", error);
    res.json({ tags: deriveFallbackMoodTags(description), source: "fallback" });
  }
});

app.get("/api/tracks", async (req: Request, res: Response) => {
  const tagsRaw = String(req.query.tags || "").trim();

  const tags = tagsRaw
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean)
    .slice(0, 3);

  if (!tags.length) {
    res.status(400).json({ error: "Missing query parameter 'tags'." });
    return;
  }

  if (!pixabayApiKey) {
    res.status(503).json({ error: "Music provider is not configured. Set PIXABAY_API_KEY to enable soundtrack playback." });
    return;
  }

  try {
    const queryCandidates = [
      `${tags.join(" ")} instrumental`,
      ...tags.map((tag) => `${tag} instrumental music`),
      `${tags[0]} cinematic instrumental`
    ];

    const uniqueCandidates = [...new Set(queryCandidates.map((query) => query.trim()).filter(Boolean))].slice(0, 5);

    const allHits: PixabayTrack[] = [];

    for (const queryText of uniqueCandidates) {
      const query = new URLSearchParams({
        key: pixabayApiKey,
        q: queryText,
        per_page: "30",
        order: "popular",
        category: "music",
        safesearch: "true"
      });

      const pixabayUrl = `https://pixabay.com/api/audio/?${query.toString()}`;
// Add this right before line 342
await new Promise(resolve => setTimeout(resolve, 300)); 

      const response = await fetch(pixabayUrl, {
    method: 'GET',
    headers: {
        // Essential: This "Human" header is the most common fix for 403s on Render
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Accept': 'application/json',
        'Referer': 'https://pixabay.com/'
    }
});

// CRITICAL: Check if the response is actually OK before calling .json()
if (!response.ok) {
    const errorBody = await response.text().catch(() => "No body");
    console.error(`Pixabay blocked the request. Status: ${response.status}, Body: ${errorBody}`);
    // Return an empty array or throw a clean error so the app doesn't crash
    return []; 
}

const data = await response.json();




      const payload = (await response.json()) as { hits?: PixabayTrack[] };
      allHits.push(...(payload.hits || []));

      if (allHits.length >= 40) {
        break;
      }
    }

    const disallowedVocalHints = /\b(voice|vocals?|lyric|singer|singing|feat\.?|featuring|ft\.?|duet|choir)\b/i;

    const dedupedHits = Array.from(new Map(allHits.map((track) => [String(track.id), track])).values());

    const tracks = dedupedHits
      .filter((track) => {
        const metadataText = `${track.tags || ""} ${track.pageURL || ""}`.toLowerCase();
        return !disallowedVocalHints.test(metadataText);
      })
      .map((track) => ({ track, audioUrl: getPixabayAudioUrl(track) }))
      .filter(({ audioUrl }) => Boolean(audioUrl))
      .sort((a, b) => Number(b.track.downloads || 0) - Number(a.track.downloads || 0))
      .slice(0, 10)
      .map(({ track, audioUrl }) => ({
        id: String(track.id),
        title: buildTrackTitle(track),
        artist: track.user || "Pixabay Artist",
        audio: audioUrl,
        download: audioUrl,
        image: cleanCoverUrl(track.userImageURL),
        duration: Number(track.duration || 0)
      }));

    if (!tracks.length) {
      res.status(404).json({ error: "No strictly instrumental (lyric-free) tracks found for this mood. Try another book." });
      return;
    }

    res.json({ tracks, source: "pixabay" });
  } catch (error) {
    console.error("/api/tracks error", error);
    res.status(500).json({ error: "Failed to fetch music tracks." });
  }
});

app.get("/{*any}", (_req: Request, res: Response) => {
  res.sendFile(path.join(publicDir, "index.html"));
});

app.listen(port, () => {
  console.log(`Aura Reader server running on http://localhost:${port}`);
});
