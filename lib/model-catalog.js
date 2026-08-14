const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');
const { addPluginVersionHeader } = require('./plugin-version');
const CATALOG_SCHEMA_VERSION = 1;
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
const TEMP_MAX_AGE_MS = 60 * 1000;
// Superseded revisions stay readable for this grace period before garbage
// collection so a reader that listed the directory just before a newer
// revision published can still open its candidates; readers never observe
// null while a valid snapshot exists.
const SUPERSEDED_REVISION_GRACE_MS = 60 * 1000;

const RFC3339 = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

function cachePrefixFor(dataDir, ingestUrl) {
  return path.join(dataDir, `model-catalog-v${CATALOG_SCHEMA_VERSION}-${crypto.createHash('sha256').update(ingestUrl).digest('hex').slice(0, 16)}`);
}

function cachePathFor(dataDir, ingestUrl, revision) {
  return `${cachePrefixFor(dataDir, ingestUrl)}.rev${revision}.json`;
}

function timestamp(value) {
  if (typeof value !== 'string') return null;
  const match = RFC3339.exec(value);
  if (!match) return null;
  const [, year, month, day, hour, minute, second, zone] = match;
  const numericYear = Number(year);
  const numericMonth = Number(month);
  const numericDay = Number(day);
  const daysInMonth = numericMonth === 2
    ? (numericYear % 4 === 0 && (numericYear % 100 !== 0 || numericYear % 400 === 0) ? 29 : 28)
    : [4, 6, 9, 11].includes(numericMonth) ? 30 : 31;
  if (numericMonth < 1 || numericMonth > 12
    || numericDay < 1 || numericDay > daysInMonth
    || Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59
    || (zone !== 'Z' && (Number(zone.slice(1, 3)) > 23 || Number(zone.slice(4, 6)) > 59))) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function validRate(rate) {
  return Boolean(rate
    && typeof rate === 'object'
    && !Array.isArray(rate)
    && ['input', 'output', 'cache_read', 'cache_write_5m'].every((key) => Number.isFinite(rate[key]) && rate[key] >= 0)
    // Optional 1h write rate: absent is fine, present must be finite and non-negative.
    && (rate.cache_write_1h === undefined
      || (Number.isFinite(rate.cache_write_1h) && rate.cache_write_1h >= 0))
    // Optional above-200k tier: absent is fine, present must be a full valid vector.
    && (rate.long_context_above_200k === undefined
      || validLongContextRates(rate.long_context_above_200k)));
}

function validLongContextRates(tier) {
  return Boolean(tier
    && typeof tier === 'object'
    && !Array.isArray(tier)
    && ['input', 'output', 'cache_read', 'cache_write_5m'].every((key) => Number.isFinite(tier[key]) && tier[key] >= 0)
    && (tier.cache_write_1h === undefined
      || (Number.isFinite(tier.cache_write_1h) && tier.cache_write_1h >= 0)));
}

function validModelResolution(model) {
  if (!model || typeof model !== 'object' || Array.isArray(model)) return false;
  if (model.status === 'known') {
    return typeof model.canonical_model_id === 'string' && typeof model.display_name === 'string';
  }
  return model.status === 'ambiguous' || model.status === 'unknown';
}

function validProviderResolution(provider) {
  if (!provider || typeof provider !== 'object' || Array.isArray(provider)) return false;
  if (provider.status === 'observed' || provider.status === 'catalog_inferred') {
    return typeof provider.provider === 'string';
  }
  return provider.status === 'ambiguous' || provider.status === 'unknown';
}

function validSegment(segment) {
  if (!segment || typeof segment !== 'object' || Array.isArray(segment)) return false;
  const from = timestamp(segment.effective_from);
  const to = segment.effective_to === null ? null : timestamp(segment.effective_to);
  if (from === null || (segment.effective_to !== null && to === null) || (to !== null && to <= from)) return false;
  const hasRate = Object.hasOwn(segment, 'rate') && validRate(segment.rate);
  const hasUnpriced = Object.hasOwn(segment, 'unpriced_reason') && typeof segment.unpriced_reason === 'string';
  return hasRate !== hasUnpriced;
}

function validateSnapshot(parsed) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  if (parsed.schema_version !== CATALOG_SCHEMA_VERSION
    || !Number.isSafeInteger(parsed.catalog_revision)
    || parsed.catalog_revision <= 0
    || typeof parsed.checksum_sha256 !== 'string'
    || !/^[0-9a-fA-F]{64}$/.test(parsed.checksum_sha256)
    || !Array.isArray(parsed.exact_lookups)) return null;
  const externalModelIds = new Set();
  for (const lookup of parsed.exact_lookups) {
    if (!lookup || typeof lookup !== 'object' || Array.isArray(lookup)
      || typeof lookup.external_model_id !== 'string'
      || externalModelIds.has(lookup.external_model_id)
      || !validModelResolution(lookup.model)
      || !validProviderResolution(lookup.provider)
      || !Array.isArray(lookup.list_rates)
      || !lookup.list_rates.every(validSegment)) return null;
    externalModelIds.add(lookup.external_model_id);
    let previous = null;
    for (const segment of lookup.list_rates) {
      const from = timestamp(segment.effective_from);
      if (previous && (from <= previous.from
        || previous.to === null
        || from < previous.to)) return null;
      previous = {
        from,
        to: segment.effective_to === null ? null : timestamp(segment.effective_to),
      };
    }
  }
  return parsed;
}

function cacheFailure(reason) {
  return `kept-cache ${reason}`;
}

function cleanupPublishedCache(dataDir, ingestUrl, publishedRevision) {
  const prefix = path.basename(cachePrefixFor(dataDir, ingestUrl));
  const revisionPattern = new RegExp(`^${prefix}\\.rev(\\d+)\\.json$`);
  try {
    for (const name of fs.readdirSync(dataDir)) {
      const revisionMatch = revisionPattern.exec(name);
      const filePath = path.join(dataDir, name);
      try {
        if (name === `${prefix}.json`
          || (revisionMatch && Number(revisionMatch[1]) < publishedRevision
            && Date.now() - fs.statSync(filePath).mtimeMs > SUPERSEDED_REVISION_GRACE_MS)
          || (name.startsWith(`${prefix}.`) && name.endsWith('.tmp')
            && Date.now() - fs.statSync(filePath).mtimeMs > TEMP_MAX_AGE_MS)) {
          fs.unlinkSync(filePath);
        }
      } catch {}
    }
  } catch {}
}

async function refreshCatalog({ ingestUrl, apiKey, dataDir, timeoutMs }) {
  if (typeof ingestUrl !== 'string' || ingestUrl.length === 0) return cacheFailure('missing-ingest-url');
  if (typeof apiKey !== 'string' || apiKey.length === 0) return cacheFailure('missing-api-key');
  if (typeof dataDir !== 'string' || dataDir.length === 0) return cacheFailure('missing-data-dir');
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return cacheFailure('invalid-timeout');

  let url;
  try {
    url = new URL(`${ingestUrl}/v1/model-catalog`);
  } catch {
    return cacheFailure('invalid-ingest-url');
  }

  let oversized = false;
  const body = await new Promise((resolve) => {
    const transport = url.protocol === 'https:' ? https : url.protocol === 'http:' ? http : null;
    if (!transport) {
      resolve(null);
      return;
    }
    const controller = new AbortController();
    let settled = false;
    const settle = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(abortTimer);
      resolve(value);
    };
    const abortTimer = setTimeout(() => {
      controller.abort();
      settle(null);
    }, timeoutMs);
    let req;
    try {
      req = transport.request(url, {
        method: 'GET',
        headers: addPluginVersionHeader({ 'x-api-key': apiKey }),
        timeout: timeoutMs,
        signal: controller.signal,
      }, (res) => {
        let response = '';
        let responseBytes = 0;
        res.on('data', (chunk) => {
          responseBytes += Buffer.byteLength(chunk);
          if (responseBytes > MAX_RESPONSE_BYTES) {
            oversized = true;
            req.destroy();
            settle(null);
            return;
          }
          response += chunk;
        });
        res.on('end', () => settle(res.statusCode === 200 ? response : null));
      });
      req.on('error', () => settle(null));
      req.on('timeout', () => {
        controller.abort();
        req.destroy();
        settle(null);
      });
      req.end();
    } catch {
      settle(null);
    }
  });
  if (body === null) return cacheFailure(oversized ? 'oversized-response' : 'request-failed');

  let snapshot;
  try {
    snapshot = validateSnapshot(JSON.parse(body));
  } catch {
    snapshot = null;
  }
  if (!snapshot) return cacheFailure('invalid-snapshot');

  // This only avoids unnecessary writes; immutable revision files preserve correctness without it.
  const current = loadCatalog(dataDir, ingestUrl);
  if (current && current.catalog_revision >= snapshot.catalog_revision) return cacheFailure('stale-revision');

  const finalPath = cachePathFor(dataDir, ingestUrl, snapshot.catalog_revision);
  const tempPath = `${finalPath}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(tempPath, JSON.stringify(snapshot));
    const verified = validateSnapshot(JSON.parse(fs.readFileSync(tempPath, 'utf8')));
    if (!verified) throw new Error('temp-validation-failed');
    fs.renameSync(tempPath, finalPath);
    cleanupPublishedCache(dataDir, ingestUrl, snapshot.catalog_revision);
    return `ok revision ${snapshot.catalog_revision}`;
  } catch {
    try { fs.unlinkSync(tempPath); } catch {}
    return cacheFailure('publish-failed');
  }
}

function loadCatalog(dataDir, ingestUrl) {
  if (typeof dataDir !== 'string' || dataDir.length === 0 || typeof ingestUrl !== 'string' || ingestUrl.length === 0) return null;
  const prefix = path.basename(cachePrefixFor(dataDir, ingestUrl));
  const revisionPattern = new RegExp(`^${prefix}\\.rev(\\d+)\\.json$`);
  // A concurrent publisher may rename a newer revision in and clean lower
  // revisions out between our directory listing and the reads below. When a
  // listed candidate disappears (ENOENT) the scan restarts on a fresh
  // listing, so cleanup can only ever move the result forward, never to
  // null while a valid snapshot exists.
  for (let attempt = 0; attempt < 4; attempt += 1) {
    let highest = null;
    let vanished = false;
    try {
      for (const name of fs.readdirSync(dataDir)) {
        const match = revisionPattern.exec(name);
        if (!match) continue;
        const revision = Number(match[1]);
        try {
          const candidate = validateSnapshot(JSON.parse(fs.readFileSync(path.join(dataDir, name), 'utf8')));
          if (candidate && candidate.catalog_revision === revision
            && (!highest || candidate.catalog_revision > highest.catalog_revision)) {
            highest = candidate;
          }
        } catch (error) {
          if (error && error.code === 'ENOENT') vanished = true;
        }
      }
    } catch {
      return null;
    }
    if (highest || !vanished) return highest;
  }
  return null;
}

function adaptModelId(raw) {
  if (typeof raw !== 'string') return null;
  const lookupKey = raw.endsWith(' [1m]')
    ? raw.slice(0, -5)
    : raw.endsWith('[1m]')
      ? raw.slice(0, -4)
      : raw;
  return { raw, lookupKey, context1m: lookupKey !== raw };
}

function rateFor(catalog, model, occurredAtMs) {
  const adapted = adaptModelId(model);
  if (!adapted || !Number.isFinite(occurredAtMs) || !validateSnapshot(catalog)) return null;
  const lookup = catalog.exact_lookups.find((entry) => entry.external_model_id === adapted.lookupKey);
  if (!lookup) return null;
  // Only an exact, unambiguously-known model may be priced, matching the engine
  // resolver and dashboard: an ambiguous canonical model is never priced even
  // when its compiled rate segment carries a numeric vector.
  if (!lookup.model || lookup.model.status !== 'known') return null;
  const segment = lookup.list_rates.find((entry) => {
    const from = Date.parse(entry.effective_from);
    const to = entry.effective_to === null ? null : Date.parse(entry.effective_to);
    return occurredAtMs >= from && (to === null || occurredAtMs < to);
  });
  if (!segment || !segment.rate) return null;
  const tier = segment.rate.long_context_above_200k;
  return {
    input: segment.rate.input,
    output: segment.rate.output,
    cacheRead: segment.rate.cache_read,
    cacheWrite: segment.rate.cache_write_5m,
    cacheWrite1h: Number.isFinite(segment.rate.cache_write_1h) ? segment.rate.cache_write_1h : null,
    // A tier can exist without published rates; such requests above 200k
    // input-side tokens stay unpriced instead of being priced low.
    hasLongContextTier: segment.rate.has_long_context_tier === true,
    longContext: tier === undefined ? null : {
      input: tier.input,
      output: tier.output,
      cacheRead: tier.cache_read,
      cacheWrite: tier.cache_write_5m,
      cacheWrite1h: Number.isFinite(tier.cache_write_1h) ? tier.cache_write_1h : null,
    },
    revision: catalog.catalog_revision,
  };
}

module.exports = {
  CATALOG_SCHEMA_VERSION,
  cachePathFor,
  timestamp,
  validateSnapshot,
  refreshCatalog,
  loadCatalog,
  adaptModelId,
  rateFor,
};
