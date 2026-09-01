// Reproducibility and signal-version metadata helpers.

import crypto from 'node:crypto';

export const SIGNAL_ENGINE_VERSION = 'm0.1';
export const DEFAULT_MODEL_VERSION = 'v1';

function normalizeForHash(value) {
  if (value === undefined) return null;
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'number' && !Number.isFinite(value)) return String(value);
    return value;
  }
  if (Array.isArray(value)) return value.map(normalizeForHash);

  return Object.keys(value)
    .sort()
    .reduce((result, key) => {
      result[key] = normalizeForHash(value[key]);
      return result;
    }, {});
}

export function stableStringify(value) {
  return JSON.stringify(normalizeForHash(value));
}

export function hashConfig(value) {
  return crypto.createHash('sha256').update(stableStringify(value)).digest('hex');
}

export function getCommitSha(env = process.env) {
  return env.VERCEL_GIT_COMMIT_SHA
    || env.GITHUB_SHA
    || env.COMMIT_SHA
    || 'unknown';
}

export function getModelVersion(env = process.env) {
  return env.MODEL_VERSION || DEFAULT_MODEL_VERSION;
}

export function buildLineage(config, options = {}) {
  const generatedAt = options.generatedAt || new Date().toISOString();
  const commitSha = options.commitSha || getCommitSha();
  const modelVersion = options.modelVersion || getModelVersion();
  const signalEngineVersion = options.signalEngineVersion || SIGNAL_ENGINE_VERSION;

  return {
    model_version: modelVersion,
    commit_sha: commitSha,
    config_hash: options.configHash || hashConfig(config),
    signal_engine_version: signalEngineVersion,
    generated_at: generatedAt,
  };
}
