import cors from "cors";
import dotenv from "dotenv";
import express, { Request, Response } from "express";
import { readdir } from "fs/promises";
import path from "path";
import Groq from "groq-sdk";

dotenv.config();

const app = express();
const port = process.env.PORT || 3000;

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));


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

type LocalAuraTrack = {
  id: string;
  audio: string;
  folder: string;
  title: string;
};

const groqApiKey = process.env.GROQ_API_KEY;
const googleBooksApiKey = process.env.GOOGLE_BOOKS_API_KEY;

const groq = groqApiKey ? new Groq({ apiKey: groqApiKey }) : null;

const cleanCoverUrl = (url?: string): string => {
  if (!url) {
    return "";
  }

  return url.replace("http://", "https://").replace(/&zoom=\d+/i, "");
};

const trimDescription = (description: string): string =>
  description.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();

const toTitleCase = (value: string): string =>
  value
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(" ");

const auraRootDir = path.join(publicDir, "audio", "auras");

let localAuraCatalogPromise: Promise<LocalAuraTrack[]> | null = null;

const moodFolderRules: Array<{ keywords: string[]; folders: string[] }> = [
  { keywords: ["dark", "horror", "fear", "sinister", "haunted", "dread"], folders: ["horror", "dark", "thriller"] },
  { keywords: ["mysterious", "mystery", "noir", "suspense", "investigation", "tense"], folders: ["thriller", "dark", "historical"] },
  { keywords: ["romantic", "romance", "love", "intimate", "tender"], folders: ["romance", "ethereal", "general"] },
  { keywords: ["epic", "heroic", "battle", "quest", "adventure"], folders: ["adventure", "fantasy", "Sci-Fi"] },
  { keywords: ["cinematic", "future", "space", "sci-fi", "cyber", "robot"], folders: ["Sci-Fi", "adventure", "general"] },
  { keywords: ["emotional", "melancholy", "sad", "grief", "lonely", "reflective"], folders: ["ethereal", "organic", "general"] },
  { keywords: ["ambient", "calm", "peaceful", "nature", "meditative"], folders: ["organic", "ethereal", "general"] },
  { keywords: ["atmospheric", "dreamy", "night", "moody"], folders: ["ethereal", "general", "historical"] },
  { keywords: ["historical", "period", "ancient", "medieval"], folders: ["historical", "general", "organic"] },
  { keywords: ["fantasy", "magical", "myth", "enchanted"], folders: ["fantasy", "ethereal", "adventure"] }
];

const shuffle = <T>(items: T[]): T[] => {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }

  return copy;
};

const toTrackTitleFromFileName = (fileName: string): string => {
  const stem = path.parse(fileName).name;
  const normalized = stem
    .replace(/[()]/g, " ")
    .replace(/[._-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!normalized) {
    return "Aura Instrumental";
  }

  return toTitleCase(normalized);
};

const getFoldersForTag = (tag: string): string[] => {
  const normalized = tag.toLowerCase().trim();
  const matched = moodFolderRules.filter((rule) => rule.keywords.some((keyword) => normalized.includes(keyword)));
  if (!matched.length) {
    return ["general"];
  }

  return [...new Set(matched.flatMap((rule) => rule.folders))];
};

const scanAuraTracks = async (): Promise<LocalAuraTrack[]> => {
  let folderEntries;

  try {
    folderEntries = await readdir(auraRootDir, { withFileTypes: true });
  } catch (error) {
    console.error("Could not read aura directory", error);
    return [];
  }

  const tracks: LocalAuraTrack[] = [];
  for (const entry of folderEntries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const folderName = entry.name;
    const folderPath = path.join(auraRootDir, folderName);

    let files;
    try {
      files = await readdir(folderPath, { withFileTypes: true });
    } catch (error) {
      console.error(`Could not read aura folder: ${folderName}`, error);
      continue;
    }

    for (const file of files) {
      if (!file.isFile()) {
        continue;
      }

      const lowerName = file.name.toLowerCase();
      if (!lowerName.endsWith(".mp3") && !lowerName.endsWith(".wav") && !lowerName.endsWith(".m4a") && !lowerName.endsWith(".ogg")) {
        continue;
      }

      const webPath = `/audio/auras/${encodeURIComponent(folderName)}/${encodeURIComponent(file.name)}`;
      tracks.push({
        id: `${folderName}/${file.name}`,
        audio: webPath,
        folder: folderName,
        title: toTrackTitleFromFileName(file.name)
      });
    }
  }

  return tracks;
};

const getLocalAuraCatalog = async (): Promise<LocalAuraTrack[]> => {
  if (!localAuraCatalogPromise) {
    localAuraCatalogPromise = scanAuraTracks();
  }

  return localAuraCatalogPromise;
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
const titleQuery = `intitle:${query}`;

const params = new URLSearchParams({
  q: titleQuery,
  maxResults: "5",
  printType: "books",
  orderBy: "relevance"
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
            "You return exactly 6 concise, specific musical mood tags for a book description. Output strict JSON as {\"tags\":[\"tag one\",\"tag two\",\"tag three\"]}."
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

// --- PASTE AT LINE 361 ---
const AURA_KEYWORDS: Record<string, string[]> = {
    dark_fantasy: ["blood", "blade", "demon", "crown", "curse", "throne", "gothic", "sacrifice", "magic"],
    ethereal: ["dream", "spirit", "light", "cloud", "floating", "glow", "soft", "aura", "vision", "angelic"],
    fantasy: ["dragon", "elf", "wizard", "quest", "myth", "ancient", "prophecy", "castle", "hidden"],
    horror: ["scream", "nightmare", "monster", "death", "teeth", "bone", "killer", "haunt", "terrifying"],
    romance: ["heart", "love", "kiss", "passion", "wedding", "desire", "sweet", "crush", "darling"],
    suspense: ["ticking", "secret", "chase", "lies", "truth", "evidence", "danger", "trap", "alert"],
    minimal: ["quiet", "white", "empty", "simple", "still", "breath", "clear", "lone", "essence"],
    organic: ["forest", "tree", "earth", "dirt", "green", "garden", "wild", "roots", "moss", "rain"],
    celestial: ["space", "star", "planet", "galaxy", "orbit", "metal", "neon", "ship", "vacuum", "future"],
    vintage: ["memory", "history", "past", "old", "letter", "dusty", "classic", "archive", "antique"],
    noir: ["rain", "smoke", "detective", "crime", "shadow", "alley", "midnight", "cold", "city", "jazz"],
    adventure: ["journey", "travel", "map", "compass", "gold", "mountain", "explore", "hero", "escape"]
};

function determineAura(title: string, description: string, tags: string[]): string {
    const fullText = `${title} ${description} ${tags.join(' ')}`.toLowerCase();
    let bestAura = "minimal";
    let highestScore = 0;

    for (const [aura, keywords] of Object.entries(AURA_KEYWORDS)) {
        let score = keywords.filter(word => fullText.includes(word)).length;
        if (score > highestScore) {
            highestScore = score;
            bestAura = aura;
        }
    }
    return bestAura;
}
// --- END OF NEW CODE ---

app.get("/api/tracks", async (req: Request, res: Response) => {
  const tagsRaw = String(req.query.tags || "").trim();

  const tags = tagsRaw
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean)
    .slice(0, 6);

  if (!tags.length) {
    res.status(400).json({ error: "Missing query parameter 'tags'." });
    return;
  }

  try {
    const allTracks = await getLocalAuraCatalog();
            // 1. Determine the best folder based on keywords
        const matchedAura = determineAura(
            String(req.query.title || ""), 
            String(req.query.description || ""), 
            tags
        );

        // 2. Set candidates with the matched aura as the top priority
        const folderCandidates = [
            matchedAura,
            ...new Set(tags.flatMap((tag) => getFoldersForTag(tag))),
            "general"
        ];


    const selectedTracks = shuffle(
      allTracks.filter((track) => folderCandidates.includes(track.folder))
    ).slice(0, 10);

    const tracks = selectedTracks.map((track) => ({
      id: track.id,
      title: track.title,
      artist: `${track.folder} aura`,
      audio: track.audio,
      download: track.audio,
      image: "",
      duration: 0
    }));

    if (!tracks.length) {
      res.status(404).json({ error: "No local aura tracks found for this mood. Add files under public/audio/auras." });
      return;
    }

    res.json({ tracks, source: "local" });
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
