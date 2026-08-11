// asset-archive-service.js
//
// Stage 9A — the orchestration layer between an already-created Asset
// (services/timeline-store.js) and permanent local storage
// (services/asset-storage.js). This file NEVER generates anything and
// never talks to EvoLink's generation API — it only downloads a result URL
// that a completed generation job already produced. See
// docs/architecture/asset-storage.md.

const timelineStore = require('./timeline-store');
const generationStore = require('./generation-store');
const assetStorage = require('./asset-storage');

// archiveGenerationAsset(assetId): downloads a completed generation's
// result into permanent local storage and updates the asset's `storage`
// field. Preserves every other asset field untouched (lineage: projectId,
// sceneId, shotId, generationId, provider, model, prompt, references —
// see updateAssetStorage in timeline-store.js).
//
// Safe to call more than once (Part 11):
//   - if the asset is already STORED and its file is still on disk, this
//     is a no-op that just returns the existing asset (alreadyArchived: true).
//   - if the asset is STORED but the file has gone missing, it is safely
//     re-downloaded from the original provider URL (if still known),
//     rather than failing or silently doing nothing.
async function archiveGenerationAsset(assetId, { fetchImpl } = {}) {
  const found = timelineStore.findAssetById(assetId);
  if (!found) {
    return { ok: false, reason: `No asset found with id "${assetId}"` };
  }
  const { project, asset } = found;

  if (asset.storage && asset.storage.status === 'STORED' && asset.storage.path) {
    if (assetStorage.storedFileExists(asset.storage.path)) {
      return { ok: true, asset, alreadyArchived: true };
    }
    // Falls through: metadata says STORED but the file is gone — reconcile
    // by re-downloading below, rather than trusting stale metadata.
  }

  // The asset's own `url` field is EvoLink's result URL, already recorded
  // when the generation completed (see generation-service.js's
  // createAssetForCompletedJob). Fall back to re-reading the generation
  // job's result only if that's ever missing.
  const job = asset.generationId ? generationStore.getGenerationJob(asset.generationId) : null;
  const sourceUrl = asset.url || (job && job.result && job.result.results && job.result.results[0]) || null;

  if (!sourceUrl) {
    const updated = timelineStore.updateAssetStorage(project.id, assetId, {
      status: 'FAILED',
      error: 'No provider result URL available to archive from.',
    });
    return { ok: false, reason: 'No provider result URL available to archive from.', asset: updated };
  }

  try {
    const result = await assetStorage.downloadAsset(sourceUrl, assetId, { fetchImpl });
    const updated = timelineStore.updateAssetStorage(project.id, assetId, {
      provider: 'local',
      path: result.relativePath,
      status: 'STORED',
      contentType: result.contentType,
      sizeBytes: result.sizeBytes,
      archivedAt: new Date().toISOString(),
      error: null,
    });
    return { ok: true, asset: updated, alreadyArchived: false };
  } catch (err) {
    const updated = timelineStore.updateAssetStorage(project.id, assetId, {
      status: 'FAILED',
      error: err.message,
    });
    return { ok: false, reason: err.message, asset: updated };
  }
}

module.exports = { archiveGenerationAsset };
