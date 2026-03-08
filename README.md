# Aura Reader

Mobile-first Progressive Web App that converts a book mood into a playable instrumental soundtrack with an ambient nature mixer.

## Stack

- Node.js + Express + TypeScript backend
- Tailwind CSS mobile-first frontend
- AI with `groq-sdk` (`llama-3.3-70b-versatile`)
- Google Books API + Jamendo API integration
- Web Audio API mixer (Rain, Wind, Fire)
- PWA with Workbox service worker caching

## Environment Variables

Copy `.env.example` to `.env` and set:

- `GROQ_API_KEY`
- `JAMENDO_CLIENT_ID`
- `GOOGLE_BOOKS_API_KEY`
- `PORT` (optional)

## Scripts

- `npm run build` - Compile backend (`tsc`)
- `npm start` - Start production server (`node dist/server.js`)
- `npm run dev` - Build and start local server
- `npm run dev:watch` - TypeScript watch mode (compile only)

## Run locally

```bash
npm install
npm run build
npm start
```

Open `http://localhost:3000`.

## Notes

- Book covers use Google Books first, then Open Library (by ISBN) as a backup.
- Music playback is strict instrumental-only. If no lyric-free tracks are available for a mood, the app returns no tracks rather than relaxing the filter.

## Render deployment

Build command:

```bash
npm run build
```

Start command:

```bash
npm start
```
