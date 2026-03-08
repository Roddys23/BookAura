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

type JamendoTrack = {
  id: string;
  name: string;
  artist_name: string;
  audio: string;
  audiodownload: string;
  audiodownload_allowed: boolean;
  image: string;
  duration: number;
  instrumental?: number | string | boolean;
  musicinfo?: {
    vocalinstrumental?: string;
  };
};

const groqApiKey = process.env.GROQ_API_KEY;
const jamendoClientId = process.env.JAMENDO_CLIENT_ID;
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

  if (!jamendoClientId) {
      res.status(503).json({ error: "Music provider is not configured. Set JAMENDO_CLIENT_ID to enable soundtrack playback." });
    return;
  }

  try {
    const query = new URLSearchParams({
      client_id: jamendoClientId,
      format: "json",
      limit: "25",
      order: "popularity_total",
      fuzzytags: tags.join(","),
      include: "musicinfo",
      audioformat: "mp32",
      instrumental: "1"
    });

    const jamendoUrl = `https://api.jamendo.com/v3.0/tracks/?${query.toString()}`;
    const response = await fetch(jamendoUrl);

    if (!response.ok) {
      throw new Error(`Jamendo failed (${response.status})`);
    }

    const payload = (await response.json()) as { results?: JamendoTrack[] };

    const disallowedVocalHints = /\b(voice|vocals?|lyric|singer|singing|feat\.?|featuring|ft\.?|duet|choir)\b/i;

    const tracks = (payload.results || [])
      .filter((track) => {
        const hasInstrumentalFlag =
          track.instrumental === true ||
          track.instrumental === 1 ||
          String(track.instrumental) === "1" ||
          track.musicinfo?.vocalinstrumental === "instrumental";

        const isExplicitlyInstrumental = track.musicinfo?.vocalinstrumental === "instrumental";
        const noVocalHintsInName = !disallowedVocalHints.test(track.name || "");

        return hasInstrumentalFlag && isExplicitlyInstrumental && noVocalHintsInName;
      })
      .filter((track) => track.audiodownload_allowed === true)
      .slice(0, 10)
      .map((track) => ({
        id: track.id,
        title: track.name,
        artist: track.artist_name,
        audio: cleanMediaUrl(track.audio),
        download: cleanMediaUrl(track.audiodownload),
        image: cleanCoverUrl(track.image),
        duration: track.duration
      }));

    if (!tracks.length) {
        res.status(404).json({ error: "No strictly instrumental (lyric-free) tracks found for this mood. Try another book." });
      return;
    }

    res.json({ tracks, source: "jamendo" });
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
