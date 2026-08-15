# Stage 25 — Final MVP Acceptance Test

Stage 25's question was the final one: can the whole pipeline actually
produce a real video, driven end-to-end through the UI, with one real
provider call? A brand-new disposable project ("STAGE 25 MVP ACCEPTANCE
TEST") was created and driven through steps 1–23 of the acceptance
workflow entirely via a real Chromium browser (Playwright) against the
production server (real `EVOLINK_API_KEY`, real data store) — brief,
character, location, storyboard scene/shot, keyframe (via ANALYZE
KEYFRAMES → ADD THIS KEYFRAME), reference upload, canonical selection,
keyframe generation (fake-image provider, zero cost) and review, canonical
keyframe selection, Video Prompt Package build (evolink /
doubao-seedance-1.0-pro-fast, 5s / 720p / adaptive), unknown-cost
acknowledgement, generation approval, and eligibility check — every step
passed.

## The one real generation call

`GENERATE VIDEO` was clicked exactly once. It failed:
`"prompt cannot be empty"`, with `providerTaskId: null` — the request
never reached EvoLink. Confirmed via a before/after EvoLink credits check
(`339.7484` remaining, unchanged): **zero cost was incurred.** Per this
stage's explicit instruction ("If generation fails, DO NOT automatically
retry. Stop and report the failure"), no second attempt was made.

### Root cause

The video prompt package's `prompt` field is built from `creativeSpecification`
(camera, subjectMotion, environmentMotion, composition, lighting, pacing —
see `video-prompt-service.js`) and the keyframe's own composition/camera
fields — none of which the 23-step acceptance workflow ever populates. The
workflow supplies character/location *references* but no *creative
direction*, so the package's prompt renders empty. The eligibility check
(`canGenerateVideo`) does not verify the package has non-empty prompt
content before reporting `allowed: true` — this is a genuine gap: the
button was enabled and clickable right up to a request EvoLink was always
going to reject.

## A second gap, found and fixed

Once the generation failed, the Operator Queue showed `VIDEO_READY_FOR_GENERATION`
for the keyframe — identical to a keyframe that had never been attempted.
`computeVideoStatus` (`operator-queue-service.js`) only ever inspected
video *assets*; a FAILED job produces none, so it fell through every check
straight to the "ready" state. An operator had no way to see that a real
attempt already happened, or why. Fixed additively: a terminal FAILED job
with no asset now reports `videoStatus: 'VIDEO_FAILED'` with the provider's
error message, both in the REST/MCP queue response and as a banner in the
Operator Queue UI. See `server/test/operator-queue-video-status.test.js`
for the regression tests.

## What this proves and what it doesn't

Proven, through the real UI, with a real server, a real reference image,
and (for the keyframe step) the existing zero-cost fake-image provider:
the full mechanical pipeline — creative planning → reference library →
keyframe generation/review/canonicalization → video package build →
approval → eligibility — works correctly and safely, including the
generation-approval, budget, and unknown-cost gates. Not yet proven:
that the pipeline can produce an actual playable video, because the one
permitted real call was never given enough creative content to succeed.
That is the concrete, addressable gap this stage surfaced.
