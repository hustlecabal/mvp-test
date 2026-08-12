# MVP Test - Faceless YouTube Template

Remotion-powered video generation template.

## Full Production Pipeline

The `openmontage/` directory vendors [OpenMontage](https://github.com/calesthio/OpenMontage) (AGPLv3), a full agentic video-production framework: 12 production pipelines, 100+ tools, and 700+ agent skills for scripting, asset generation, editing, and composition — driven by an AI coding assistant rather than manual editing.

It's a separate local/dev workspace, not part of this repo's Vercel deploy:

```bash
cd openmontage
make setup          # installs Python deps, Remotion composer, Piper TTS
cp .env.example .env  # add API keys for any paid providers you want (all optional)
```

Then open `openmontage/` in your AI coding assistant and describe the video you want — see `openmontage/README.md` for prompts and pipeline details, or `openmontage/AGENT_GUIDE.md` for the agent operating contract.

Renders land in `openmontage/` output folders; pull the finished file into `src/` here if you want it served through this repo's existing Vercel/Remotion template.

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
