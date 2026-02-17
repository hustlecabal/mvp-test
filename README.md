# MVP Test - Faceless YouTube Template

Remotion-powered video generation template.

## Quick Start

```bash
# Install dependencies
npm install

# Preview in browser
npm run dev

# Build video locally
npm run build

# Output: out/video.mp4
```

## Deploy to Vercel

1. Import this repo in Vercel dashboard
2. Add `REMOTION_AWS_ACCESS_KEY_ID` and `REMOTION_AWS_SECRET_ACCESS_KEY` (for serverless rendering)
3. Or use Vercel CLI: `vercel --prod`

## Structure

```
src/
  index.tsx       # Remotion compositions
  HelloWorld.tsx  # Main video component
```

## Customize

Edit `src/HelloWorld.tsx`:
- Change `titleText` prop
- Add voiceover audio track
- Import your TTS files
- Add captions component

---
Built for Opeyemi's £2k/month automation pipeline.
