# Production IR — Creative Layer

"IR" stands for **Intermediate Representation**: a shared, structured way of
describing something that many different tools can read and write, instead
of everyone inventing their own format. In EvoLink Video Factory, the
Creative IR is the shared structure that Claude Code, creative skills, and
(eventually) the frontend all read and write when they talk about *what a
video is about*.

Code: `server/schemas/production-schema.js`, function `createCreativeIR()`.

## Why not just "one big prompt"?

If every creative skill dumped its output into a single text blob, later
skills couldn't reliably build on earlier ones, and a human couldn't review
one part without wading through everything else. Instead, each concern gets
its own named field on the project. A skill reads the fields it needs and
writes only to the field it owns — it never has to understand or overwrite
another skill's output.

## The fields

| Field | What it holds |
|---|---|
| `title`, `topic` | The project's identity — what it's called and what it's about (from Stage 2). |
| `audience` | Who this video is for, in plain language (e.g. "young professionals interested in tech history"). |
| `tone` | The emotional register (e.g. "nostalgic", "urgent", "playful"). |
| `creativeMode` | A label for which overall creative approach is being used (e.g. documentary, narrative, UGC-style). Left as a free string for now — no fixed list is enforced yet. |
| `research` | Whatever a research step gathers — facts, sources, background. |
| `creativeDirection` | The overall creative concept and direction for the piece. |
| `story` | The narrative shape — beats, arc, structure. |
| `script` | The actual written script/dialogue/voiceover text. |
| `characters` | A list of characters in the video (name, description, reference notes). |
| `locations` | A list of places/settings the video takes place in. |
| `visualBible` | Visual rules that should stay consistent throughout — palette, style, recurring visual motifs. |

Every field defaults to an empty string, object, or array. **Nothing is
required to be filled in.** A brand-new project is valid with everything
blank; skills fill fields in over time as the project moves through the
[state machine](./state-machine.md).

## How existing skills fit in

This stage does **not** rebuild or call any creative skill. It only defines
where a skill's output would land if/when it's wired in later (e.g. via
MCP). Roughly:

- `cinema-worldbuilder-pro-20` / `video-prompt-builder` → would contribute to
  `visualBible`, `characters`, `locations`, and individual shots' prompt
  fields (see [timeline-ir.md](./timeline-ir.md)).
- `banana-pro-director-20` → would contribute character/reference image
  direction, feeding `characters` and asset lineage.
- `ugc-decoder` / `ugc-builder` → would contribute to `creativeDirection`
  and `story` when the creative mode is UGC-style content.
- `brand-video-editor` / `ffmpeg-karaoke-animated-text` → operate later in
  the pipeline (editing/captioning), closer to the Timeline IR's `audio`
  and `outputSettings`.

None of that wiring exists yet — this stage only makes sure there's a
well-defined place for it to go.
