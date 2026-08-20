// human-voice-profile-service.js
//
// CREATIVE BRAIN, Part 6/7 — turns a real, acquired DiscussionItem[]
// corpus (services/human-voice-acquisition-service.js) into an aggregate
// HumanVoiceProfile (schemas/human-voice-profile-schema.js).
//
// THE HARD RULE THIS FILE ENFORCES (Part 7): individual post/comment text
// is evidence FOR a pattern, never a script template. This file NEVER
// stores a discussion item's raw text on the persisted profile — every
// pattern entry is a short, abstracted label plus a supportCount and
// exampleThreadIds[] (references only, resolved back to Reddit's own
// externalIds, same provenance discipline as reference-video-schema.js's
// own source.externalId).
//
// DETERMINISTIC, MARKER-BASED, NEVER AN NLP CLASSIFIER — mirrors
// narration-director-service.js's own explicit precedent ("no fuzzy
// string matching... a targeted, documented pattern", that file's own
// header) applied to a discussion corpus instead of narration text. This
// is intentionally conservative: a small, documented marker vocabulary
// per dimension, not a semantic understanding model. A pattern only
// enters the profile once it clears MIN_ABSOLUTE_SUPPORT_COUNT — the same
// "one post is not a voice" guard cross-video-pattern-service.js already
// established for reference videos.

const { createHumanVoiceProfile, createVoicePatternEntry } = require('../schemas/human-voice-profile-schema');

const MIN_ABSOLUTE_SUPPORT_COUNT = 3;
const MIN_DISCUSSION_ITEM_COUNT = 5; // fewer real items than this -> PARTIAL, never fabricated up to a minimum

const STOPWORDS = new Set('a an the and or but if then so of to in on for with is are was were be been being it its this that these those i you he she we they my your his her our their as at by from not no do does did have has had can will would should could just so very really'.split(' '));

function splitSentences(text) {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 3);
}

function tokenize(sentence) {
  return sentence
    .toLowerCase()
    .replace(/[^a-z0-9'\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w));
}

// One dimension's marker set — a sentence containing ANY listed marker
// counts as one occurrence of that dimension, labeled by the marker
// itself (never by inventing a paraphrase of the sentence).
const MARKER_DIMENSIONS = {
  emotionalPatterns: ['frustrated', 'frustrating', 'excited', 'anxious', 'overwhelmed', 'relieved', 'disappointed', 'proud of', 'grateful'],
  humour: ['lol', 'lmao', 'haha', 'hah', ':)', 'joking', 'kidding'],
  disagreement: ['actually,', "i disagree", "that's not true", "i don't think that's right", 'to be fair', 'on the other hand', 'counterpoint'],
  vulnerability: ["i struggled", "it's hard for me", 'i felt', 'i was scared', 'i was ashamed', "i'm afraid", 'honestly, i'],
  uncertainty: ["i don't know", 'not sure', 'maybe', 'i think', 'i guess', 'possibly', 'not 100% sure'],
  audienceQuestions: [], // handled structurally below (any sentence ending in '?'), not by marker
  recurringTensions: ['the problem is', 'struggle with', 'even though', 'despite', "but i can't", 'trade-off', 'tradeoff'],
  recurringExperiences: ["i've been through", 'same thing happened to me', 'i went through', 'happened to me too', 'i went through the same'],
  conversationPatterns: ['in my experience', 'to be honest', 'honestly', 'not gonna lie', 'at the end of the day'],
  emotionalTransitions: ['started out', 'used to', 'ended up', 'turned into', 'eventually'],
};

// Known filler/cliche openers this codebase's own narration/interpretation
// anti-slop conventions already treat as generic (extended here for a
// discussion-corpus context) — Part 8's own "clichés to avoid" concept.
const CLICHE_MARKERS = ['at the end of the day', 'in this day and age', "it is what it is", 'needless to say', 'to be honest with you'];

function countMarkers(items, markers) {
  const counts = new Map(); // marker -> {count, threadIds:Set}
  for (const item of items) {
    for (const sentence of splitSentences(item.text)) {
      const lower = sentence.toLowerCase();
      for (const marker of markers) {
        if (lower.includes(marker)) {
          const entry = counts.get(marker) || { count: 0, threadIds: new Set() };
          entry.count += 1;
          entry.threadIds.add(item.externalId);
          counts.set(marker, entry);
        }
      }
    }
  }
  return counts;
}

function markerCountsToEntries(counts) {
  return [...counts.entries()]
    .filter(([, entry]) => entry.count >= MIN_ABSOLUTE_SUPPORT_COUNT)
    .map(([marker, entry]) => createVoicePatternEntry({ pattern: marker, supportCount: entry.count, exampleThreadIds: [...entry.threadIds].slice(0, 5) }));
}

// audienceQuestions — structural (any real sentence ending in '?'),
// grouped by its own text since there is no fixed marker vocabulary for
// "a question" — each DISTINCT question appearing >= MIN_ABSOLUTE_
// SUPPORT_COUNT times across the corpus becomes one pattern entry.
function extractAudienceQuestions(items) {
  const counts = new Map();
  for (const item of items) {
    for (const sentence of splitSentences(item.text)) {
      if (sentence.trim().endsWith('?') && sentence.length <= 200) {
        const key = sentence.trim();
        const entry = counts.get(key) || { count: 0, threadIds: new Set() };
        entry.count += 1;
        entry.threadIds.add(item.externalId);
        counts.set(key, entry);
      }
    }
  }
  return markerCountsToEntries(counts);
}

// vocabulary / idioms — frequent content words / repeated 3-word phrases
// across DISTINCT items (never counting the same item's own repetition
// twice toward supportCount, so one verbose post can't dominate).
function extractFrequentTerms(items, { ngram = 1 } = {}) {
  const counts = new Map(); // term -> {itemIds:Set}
  for (const item of items) {
    const words = tokenize(item.text);
    const seenInItem = new Set();
    for (let i = 0; i + ngram <= words.length; i += 1) {
      const term = words.slice(i, i + ngram).join(' ');
      if (seenInItem.has(term)) continue;
      seenInItem.add(term);
      const entry = counts.get(term) || new Set();
      entry.add(item.externalId);
      counts.set(term, entry);
    }
  }
  return [...counts.entries()]
    .filter(([, threadIds]) => threadIds.size >= MIN_ABSOLUTE_SUPPORT_COUNT)
    .sort((a, b) => b[1].size - a[1].size)
    .slice(0, 25)
    .map(([term, threadIds]) => createVoicePatternEntry({ pattern: term, supportCount: threadIds.size, exampleThreadIds: [...threadIds].slice(0, 5) }));
}

function buildHumanVoiceProfile(projectId, { topic, platform = 'REDDIT', items = [], sourceQueryIds = [] } = {}) {
  const diagnostics = [];
  if (!Array.isArray(items) || items.length === 0) {
    return createHumanVoiceProfile({ projectId, topic, platform, status: 'FAILED', diagnostics: [{ code: 'ACQUISITION_FAILED', message: 'no discussion items to build a profile from' }] });
  }
  if (items.length < MIN_DISCUSSION_ITEM_COUNT) {
    diagnostics.push({ code: 'INSUFFICIENT_DISCUSSION_VOLUME', message: `only ${items.length} real discussion items acquired (minimum ${MIN_DISCUSSION_ITEM_COUNT}) — profile built, but with reduced confidence` });
  }

  const markerEntries = {};
  for (const [dimension, markers] of Object.entries(MARKER_DIMENSIONS)) {
    if (dimension === 'audienceQuestions') continue;
    markerEntries[dimension] = markerCountsToEntries(countMarkers(items, markers));
  }

  const clicheEntries = markerCountsToEntries(countMarkers(items, CLICHE_MARKERS));
  const vocabulary = extractFrequentTerms(items, { ngram: 1 });
  const idioms = extractFrequentTerms(items, { ngram: 3 });
  const recurringFraming = extractFrequentTerms(items, { ngram: 4 });
  const audienceQuestions = extractAudienceQuestions(items);

  const sourceThreadIds = [...new Set(items.map((i) => i.externalId).filter(Boolean))];

  return createHumanVoiceProfile({
    projectId,
    topic,
    platform,
    status: diagnostics.length > 0 ? 'PARTIAL' : 'COMPLETE',
    sourceThreadIds,
    sourceQueryIds,
    diagnostics,
    vocabulary,
    idioms,
    languagePatterns: recurringFraming, // same extraction, distinct semantic label per Part 6's own list
    emotionalPatterns: markerEntries.emotionalPatterns,
    emotionalTransitions: markerEntries.emotionalTransitions,
    recurringExperiences: markerEntries.recurringExperiences,
    recurringTensions: markerEntries.recurringTensions,
    conversationPatterns: markerEntries.conversationPatterns,
    humour: markerEntries.humour,
    disagreement: markerEntries.disagreement,
    vulnerability: markerEntries.vulnerability,
    uncertainty: markerEntries.uncertainty,
    audienceQuestions,
    recurringFraming,
    clichesToAvoid: clicheEntries,
  });
}

module.exports = { buildHumanVoiceProfile, MIN_ABSOLUTE_SUPPORT_COUNT, MIN_DISCUSSION_ITEM_COUNT };
