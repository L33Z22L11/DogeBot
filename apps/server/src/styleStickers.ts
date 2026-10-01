import { Buffer } from 'node:buffer';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  renderStickerToImage,
  type NodeStickerFontFiles,
  type StickerFlavor,
  type StickerImageResult
} from '@syru/byted-sticker-generator/node';
import { DEFAULT_STICKER_CONTROLS, randomStickerColors, resolveGradientStops } from '@syru/byted-sticker-generator';
import type { Request, Response } from 'express';
import { passiveInteractionConfig, stickerRenderConfig } from './config.js';
import { createConcurrencyLimiter } from './utils/concurrency.js';
import { normalizeHexColor } from './utils/color.js';

export type { StickerFlavor };

/** 限制导出图片最长边，避免机器人上传过大图片 */
const MAX_OUTPUT_EDGE = 4096;
/** 与生成器支持的 HDR EV 上限保持一致，允许正数小数。 */
export const STYLE_STICKER_HDR_EV_MAX = 5;
export const STYLE_STICKER_HDR_EV_DEFAULT = 4;

const STYLE_STICKER_FONT_FILES = resolveStyleStickerFontFiles();
const runStyleStickerRenderTask = createConcurrencyLimiter({
  name: 'style-sticker-render',
  limit: stickerRenderConfig.concurrency,
  maxQueue: stickerRenderConfig.queueMax,
  taskTimeoutMs: stickerRenderConfig.timeoutMs
});

const RENDER_CACHE_TTL_MS = 60_000;
const RENDER_CACHE_MAX_ENTRIES = 20;
const renderResultCache = new Map<string, {
  image: Buffer;
  mime: string;
  colors: readonly [string, string];
  renderScale: number;
  gradientAngle: number;
  expiresAt: number;
}>();

interface ResolvedStyleStickerInput {
  text: string;
  flavor: StickerFlavor;
  colors: readonly [string, string];
  renderScale: number;
  gradientAngle: number;
  flashStops: number | null;
}

function resolveStyleStickerFontFiles(): NodeStickerFontFiles {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const distAssetsDir = join(moduleDir, 'assets', 'fonts');
  const sourceAssetsDir = join(moduleDir, '..', 'assets', 'fonts');
  const assetsDir = existsSync(distAssetsDir) ? distAssetsDir : sourceAssetsDir;
  const fontPath = (file: string) => join(assetsDir, file);
  return {
    snh: fontPath('DouyinSansBold.woff2'),
    bs: fontPath('YouSheBiaoTiHei.ttf'),
    appleColorEmoji: fontPath('AppleColorEmoji.ttf'),
    appleSymbols: fontPath('AppleSymbols.ttf'),
    notoColorEmoji: fontPath('NotoColorEmoji.ttf'),
    notoSansSymbols2: fontPath('NotoSansSymbols2-Regular.ttf')
  };
}

function normalizeRenderScale(value: unknown) {
  const parsed = typeof value === 'string' ? Number(value.trim()) : value;
  if (typeof parsed === 'number' && Number.isFinite(parsed)) return Math.min(3, Math.max(1, parsed));
  return 1;
}

function normalizeGradientAngle(value: unknown) {
  const parsed = typeof value === 'string' ? Number(value.trim()) : value;
  if (typeof parsed === 'number' && Number.isFinite(parsed)) return Math.min(360, Math.max(0, parsed));
  return Math.floor(Math.random() * 361);
}

/** HDR 高亮 EV：必须大于 0 且不超过上限，否则关闭 HDR。 */
export function parseEvParam(value: unknown): number | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const parsed = Number(typeof value === 'string' ? value.trim() : value);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > STYLE_STICKER_HDR_EV_MAX) return null;
  return parsed;
}

function resolveGradientColors(color1: unknown, color2: unknown, flavor: StickerFlavor): readonly [string, string] {
  const first = normalizeHexColor(color1);
  const second = normalizeHexColor(color2);
  if (first && second) return [first, second];
  if (!first && !second) {
    const [start, end] = randomStickerColors(DEFAULT_STICKER_CONTROLS.envelope.colors[0], { flavor, count: 2 });
    return [start, end];
  }
  const [base, highlight] = resolveGradientStops([first || second], flavor);
  return first ? [base, highlight] : [highlight, base];
}

function resolveStyleStickerInput(
  text: string,
  flavor: StickerFlavor,
  options: { color1?: unknown; color2?: unknown; scale?: unknown; gradientAngle?: unknown; ev?: unknown }
): ResolvedStyleStickerInput {
  return {
    text,
    flavor,
    colors: resolveGradientColors(options.color1, options.color2, flavor),
    renderScale: normalizeRenderScale(options.scale),
    gradientAngle: normalizeGradientAngle(options.gradientAngle),
    flashStops: parseEvParam(options.ev)
  };
}

function renderCacheKey(input: ResolvedStyleStickerInput) {
  return [
    input.flavor,
    input.text,
    input.colors[0],
    input.colors[1],
    input.renderScale,
    input.gradientAngle,
    input.flashStops ?? ''
  ].join(':');
}

function pruneRenderCache() {
  if (renderResultCache.size <= RENDER_CACHE_MAX_ENTRIES) return;
  const now = Date.now();
  for (const [key, entry] of renderResultCache) {
    if (entry.expiresAt <= now) renderResultCache.delete(key);
  }
  if (renderResultCache.size <= RENDER_CACHE_MAX_ENTRIES) return;
  const sorted = [...renderResultCache.entries()].sort((a, b) => a[1].expiresAt - b[1].expiresAt);
  for (const [key] of sorted.slice(0, sorted.length - RENDER_CACHE_MAX_ENTRIES)) renderResultCache.delete(key);
}

export async function closeStyleStickerRenderer() {
  return;
}

async function renderStyleStickerFile(input: ResolvedStyleStickerInput) {
  const cacheKey = renderCacheKey(input);
  const cached = renderResultCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return { image: cached.image, mime: cached.mime, colors: cached.colors, renderScale: cached.renderScale, gradientAngle: cached.gradientAngle };
  }

  const flash = input.flashStops !== null;
  const rendered: StickerImageResult = await runStyleStickerRenderTask(() =>
    renderStickerToImage(
      {
        text: input.text,
        flavor: input.flavor,
        flash,
        flashStops: input.flashStops ?? undefined,
        envelope: { colors: [...input.colors], gradientAngle: input.gradientAngle }
      },
      {
        fontFiles: STYLE_STICKER_FONT_FILES,
        outputScale: input.renderScale,
        maxOutputEdge: Math.round(MAX_OUTPUT_EDGE * input.renderScale)
      }
    )
  );

  const result = {
    image: rendered.buffer,
    mime: rendered.mime,
    colors: input.colors,
    renderScale: input.renderScale,
    gradientAngle: input.gradientAngle
  };
  pruneRenderCache();
  renderResultCache.set(cacheKey, { ...result, expiresAt: Date.now() + RENDER_CACHE_TTL_MS });
  return result;
}

export async function renderStyleStickerImage(
  text: string,
  flavor: StickerFlavor,
  options: { color1?: unknown; color2?: unknown; scale?: unknown; gradientAngle?: unknown; ev?: unknown } = {}
) {
  return renderStyleStickerFile(resolveStyleStickerInput(text, flavor, options));
}

async function handleStyleSticker(req: Request, res: Response, flavor: StickerFlavor) {
  const rawText = typeof req.query.text === 'string' ? req.query.text.trim() : '';
  // Cap the text at the same absolute limit used by the Feishu command paths.
  const text = rawText.slice(0, passiveInteractionConfig().styleStickerMaxCharsLimit);
  if (!text) {
    res.status(400).json({ error: 'text is required' });
    return;
  }

  try {
    const { image, mime, colors, renderScale, gradientAngle } = await renderStyleStickerImage(text, flavor, {
      color1: req.query.color1,
      color2: req.query.color2,
      scale: req.query.scale,
      gradientAngle: req.query.gradientAngle ?? req.query.ga,
      ev: req.query.ev
    });

    const ev = parseEvParam(req.query.ev);
    res.setHeader('Content-Type', mime);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Gradient-Color-1', colors[0]);
    res.setHeader('X-Gradient-Color-2', colors[1]);
    res.setHeader('X-Gradient-Angle', String(gradientAngle));
    res.setHeader('X-Render-Scale', String(renderScale));
    if (ev !== null) res.setHeader('X-HDR-EV', String(ev));
    res.send(image);
  } catch (error) {
    res.status(502).json({ error: error instanceof Error ? error.message : 'failed to render sticker' });
  }
}

export async function renderByteStyle(req: Request, res: Response) {
  await handleStyleSticker(req, res, 'bs');
}

export async function renderScaleNewHeights(req: Request, res: Response) {
  await handleStyleSticker(req, res, 'snh');
}
