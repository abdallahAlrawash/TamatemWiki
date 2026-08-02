import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { getRunOutputDir } from './runFolders.js';

const pricingPath = path.join('storage', 'pricing.json');

async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await readFile(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function roundCost(value) {
  return Number((Number(value) || 0).toFixed(6));
}

function getOutputDir({ outputDir, runId } = {}) {
  return outputDir || (runId ? getRunOutputDir(runId) : null);
}

function openAiUsage(raw = {}) {
  const usage = raw.usage || {};
  const inputTokens = usage.input_tokens ?? usage.prompt_tokens ?? 0;
  const outputTokens = usage.output_tokens ?? usage.completion_tokens ?? 0;
  const cachedInputTokens = usage.input_tokens_details?.cached_tokens ?? usage.prompt_tokens_details?.cached_tokens ?? 0;

  return {
    cached_input_tokens: cachedInputTokens,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    total_tokens: usage.total_tokens ?? inputTokens + outputTokens,
  };
}

function geminiUsage(raw = {}) {
  const usage = raw.usageMetadata || raw.usage_metadata || {};
  const inputTokens = usage.promptTokenCount ?? usage.prompt_tokens ?? 0;
  const outputTokens = usage.candidatesTokenCount ?? usage.output_tokens ?? 0;
  const totalTokens = usage.totalTokenCount ?? usage.total_tokens ?? inputTokens + outputTokens;

  return {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    total_tokens: totalTokens,
  };
}

function applyBatchDiscount(cost, pricing, billingMode) {
  if (billingMode !== 'batch') {
    return cost;
  }

  return cost * (pricing.batch_discount ?? 0.5);
}

function calculateOpenAiTextCost({ billingMode, model, raw }, pricing) {
  const usage = openAiUsage(raw);
  const rates = pricing.openai?.text_models?.[model] || pricing.openai?.text_models?.default;
  let cost = 0;

  if (rates) {
    const billableInputTokens = Math.max(0, usage.input_tokens - usage.cached_input_tokens);

    cost += (billableInputTokens / 1_000_000) * (rates.input_per_1m_tokens || 0);
    cost += (usage.cached_input_tokens / 1_000_000) * (rates.cached_input_per_1m_tokens || rates.input_per_1m_tokens || 0);
    cost += (usage.output_tokens / 1_000_000) * (rates.output_per_1m_tokens || 0);
  }

  return {
    estimated_cost_usd: roundCost(applyBatchDiscount(cost, pricing.openai || {}, billingMode)),
    usage,
  };
}

function calculateOpenAiImageCost({ billingMode, imageCount = 1, model, raw }, pricing) {
  const usage = openAiUsage(raw);
  const rates = pricing.openai?.image_models?.[model] || pricing.openai?.image_models?.default;
  let cost = 0;

  if (rates && usage.total_tokens) {
    cost += (usage.input_tokens / 1_000_000) * (rates.text_input_per_1m_tokens || 0);
    cost += (usage.cached_input_tokens / 1_000_000) * (rates.cached_input_per_1m_tokens || 0);
    cost += (usage.output_tokens / 1_000_000) * (rates.image_output_per_1m_tokens || 0);
  } else if (rates?.fallback_per_image_estimate) {
    cost += imageCount * rates.fallback_per_image_estimate;
  }

  return {
    estimated_cost_usd: roundCost(applyBatchDiscount(cost, pricing.openai || {}, billingMode)),
    usage: {
      ...usage,
      images: imageCount,
    },
  };
}

function calculateGoogleImageCost({
  billingMode,
  imageSize = '1K',
  inputImages = 0,
  model,
  outputImages = 1,
  raw,
}, pricing) {
  const usage = geminiUsage(raw);
  const rates = pricing.google?.image_models?.[model] || pricing.google?.image_models?.default;
  let cost = 0;

  if (rates) {
    cost += (usage.input_tokens / 1_000_000) * (rates.input_text_image_per_1m_tokens || 0);
    cost += (usage.output_tokens / 1_000_000) * (rates.output_text_per_1m_tokens || 0);
    cost += inputImages * (billingMode === 'batch' ? rates.batch_input_image_estimate : rates.input_image_estimate || 0);

    const normalizedSize = String(imageSize).toLowerCase();
    const outputRate =
      normalizedSize.includes('4k')
        ? billingMode === 'batch'
          ? rates.batch_output_image_4k
          : rates.output_image_4k
        : normalizedSize.includes('2k')
          ? billingMode === 'batch'
            ? rates.batch_output_image_2k || rates.batch_output_image_1k_2k
            : rates.output_image_2k || rates.output_image_1k_2k
          : billingMode === 'batch'
            ? rates.batch_output_image_1k || rates.batch_output_image_1k_2k
            : rates.output_image_1k || rates.output_image_1k_2k;

    cost += outputImages * (outputRate || 0);
  }

  return {
    estimated_cost_usd: roundCost(cost),
    usage: {
      ...usage,
      image_size: imageSize,
      input_images: inputImages,
      output_images: outputImages,
    },
  };
}

function calculateGoogleTextCost({ billingMode, model, raw }, pricing) {
  const usage = geminiUsage(raw);
  const rates = pricing.google?.text_models?.[model] || pricing.google?.text_models?.default;
  let cost = 0;

  if (rates) {
    cost += (usage.input_tokens / 1_000_000) * (rates.input_per_1m_tokens || 0);
    cost += (usage.output_tokens / 1_000_000) * (rates.output_per_1m_tokens || 0);
  }

  return {
    estimated_cost_usd: roundCost(applyBatchDiscount(cost, pricing.google || {}, billingMode)),
    usage,
  };
}

function calculateElevenLabsTtsCost({ characters = 0, model }, pricing) {
  const rates = pricing.elevenlabs?.tts?.[model] || pricing.elevenlabs?.tts?.default;
  const cost = rates ? (characters / 1000) * (rates.per_1000_characters || 0) : 0;

  return {
    estimated_cost_usd: roundCost(cost),
    usage: {
      characters,
    },
  };
}

function calculateElevenLabsSttCost({ seconds = 0, model }, pricing) {
  const rates = pricing.elevenlabs?.speech_to_text?.[model] || pricing.elevenlabs?.speech_to_text?.default;
  const cost = rates ? (seconds / 3600) * (rates.per_hour || 0) : 0;

  return {
    estimated_cost_usd: roundCost(cost),
    usage: {
      seconds,
    },
  };
}

function calculateElevenLabsSfxCost({ generations = 1, model, seconds = 10 }, pricing) {
  const rates = pricing.elevenlabs?.sound_effects?.[model] || pricing.elevenlabs?.sound_effects?.default;
  const cost = rates ? generations * (rates.per_generation || 0) : 0;

  return {
    estimated_cost_usd: roundCost(cost),
    usage: {
      generations,
      seconds,
    },
  };
}

function calculateCost(entry, pricing) {
  if (entry.provider === 'openai' && entry.kind === 'text') {
    return calculateOpenAiTextCost(entry, pricing);
  }

  if (entry.provider === 'openai' && entry.kind === 'image') {
    return calculateOpenAiImageCost(entry, pricing);
  }

  if (entry.provider === 'google' && entry.kind === 'image') {
    return calculateGoogleImageCost(entry, pricing);
  }

  if (entry.provider === 'google' && entry.kind === 'text') {
    return calculateGoogleTextCost(entry, pricing);
  }

  if (entry.provider === 'elevenlabs' && entry.kind === 'tts') {
    return calculateElevenLabsTtsCost(entry, pricing);
  }

  if (entry.provider === 'elevenlabs' && entry.kind === 'speech_to_text') {
    return calculateElevenLabsSttCost(entry, pricing);
  }

  if (entry.provider === 'elevenlabs' && entry.kind === 'sound_effect') {
    return calculateElevenLabsSfxCost(entry, pricing);
  }

  return {
    estimated_cost_usd: 0,
    usage: entry.usage || {},
  };
}

function summarize(entries) {
  const byProvider = {};
  const byStep = {};
  let total = 0;

  for (const entry of entries) {
    total += entry.estimated_cost_usd || 0;
    byProvider[entry.provider] = roundCost((byProvider[entry.provider] || 0) + (entry.estimated_cost_usd || 0));
    byStep[entry.step] = roundCost((byStep[entry.step] || 0) + (entry.estimated_cost_usd || 0));
  }

  return {
    by_provider: byProvider,
    by_step: byStep,
    total_estimated_usd: roundCost(total),
  };
}

export async function estimateRunCost(entries = []) {
  const pricing = await readJson(pricingPath, {});
  const breakdown = [];
  let total = 0;

  for (const entry of entries) {
    const repeat = entry.repeat || 1;
    const calculated = calculateCost(entry, pricing);
    const stepCost = roundCost((calculated.estimated_cost_usd || 0) * repeat);

    total += stepCost;
    breakdown.push({
      cost_usd: stepCost,
      provider: entry.provider,
      repeat,
      step: entry.step,
    });
  }

  return {
    breakdown,
    currency: pricing.currency || 'USD',
    per_video_usd: roundCost(total),
  };
}

export async function logCost(entry) {
  const outputDir = getOutputDir(entry);

  if (!outputDir) {
    return null;
  }

  const pricing = await readJson(pricingPath, {});
  const ledgerPath = path.join(outputDir, 'costs.json');
  const current = await readJson(ledgerPath, {
    currency: pricing.currency || 'USD',
    entries: [],
    pricing_source: pricingPath,
    run_id: entry.runId || path.basename(outputDir),
  });
  const calculated = calculateCost(entry, pricing);
  const costEntry = {
    at: new Date().toISOString(),
    billing_mode: entry.billingMode || 'live',
    estimated_cost_usd: calculated.estimated_cost_usd,
    kind: entry.kind,
    metadata: entry.metadata || {},
    model: entry.model || null,
    provider: entry.provider,
    step: entry.step,
    usage: {
      ...(entry.usage || {}),
      ...(calculated.usage || {}),
    },
  };
  const next = {
    ...current,
    currency: pricing.currency || current.currency || 'USD',
    entries: [...(current.entries || []), costEntry],
    pricing_updated_at: pricing.updated_at,
    summary: summarize([...(current.entries || []), costEntry]),
    updated_at: costEntry.at,
  };

  await mkdir(outputDir, { recursive: true });
  await writeFile(ledgerPath, `${JSON.stringify(next, null, 2)}\n`, 'utf8');

  return costEntry;
}

