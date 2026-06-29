#!/usr/bin/env node
/**
 * AI Influencer Video Generator
 * Claude (script) → HeyGen (avatar video) → local output folder
 *
 * Usage:
 *   node generate.js --all
 *   node generate.js --creator fitness-coach
 */

import Anthropic from "@anthropic-ai/sdk";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

// ─── Bootstrap ───────────────────────────────────────────────────────────────

// Load .env manually so we stay dependency-light (no extra dotenv import quirks)
const __dirname = path.dirname(fileURLToPath(import.meta.url));
loadEnv(path.join(__dirname, ".env"));

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const HEYGEN_API_KEY = process.env.HEYGEN_API_KEY;

if (!ANTHROPIC_API_KEY) fatal("ANTHROPIC_API_KEY is not set in .env");
if (!HEYGEN_API_KEY) fatal("HEYGEN_API_KEY is not set in .env");

const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

const HEYGEN_BASE = "https://api.heygen.com";
const POLL_INTERVAL_MS = 10_000;   // 10 s between status checks
const POLL_TIMEOUT_MS  = 600_000;  // 10 min max wait per video

// ─── CLI Argument Parsing ─────────────────────────────────────────────────────

const args = process.argv.slice(2);
const flagAll      = args.includes("--all");
const creatorIndex = args.indexOf("--creator");
const creatorSlug  = creatorIndex !== -1 ? args[creatorIndex + 1] : null;

if (!flagAll && !creatorSlug) {
  console.error("Usage: node generate.js --all | --creator <slug>");
  process.exit(1);
}

// ─── Main Entry Point ─────────────────────────────────────────────────────────

const personasDir = path.join(__dirname, "personas");
let personaFiles  = [];

if (flagAll) {
  personaFiles = fs
    .readdirSync(personasDir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => path.join(personasDir, f));
} else {
  const target = path.join(personasDir, `${creatorSlug}.json`);
  if (!fs.existsSync(target)) fatal(`Persona file not found: ${target}`);
  personaFiles = [target];
}

const dateSlug = todaySlug();
const results  = [];

for (const filePath of personaFiles) {
  const persona = JSON.parse(fs.readFileSync(filePath, "utf8"));
  log("═".repeat(60));
  log(`▶  Starting pipeline for: ${persona.name} (${persona.slug})`);

  const result = await runPipeline(persona, dateSlug);
  results.push(result);
}

log("═".repeat(60));
log("✅  All done!\n");

for (const r of results) {
  if (r.success) {
    log(`  ${r.slug}: output at ${r.outputDir}`);
    if (!r.videoRendered) log(`  ⚠  ${r.slug}: video render FAILED — script saved, manual retry needed`);
  } else {
    log(`  ✗ ${r.slug}: FAILED — ${r.error}`);
  }
}

// ─── Pipeline ─────────────────────────────────────────────────────────────────

async function runPipeline(persona, dateSlug) {
  const outputDir = path.join(__dirname, "output", persona.slug, dateSlug);
  fs.mkdirSync(outputDir, { recursive: true });

  // Validate HeyGen IDs are filled in
  if (
    !persona.heygenAvatarId ||
    persona.heygenAvatarId.startsWith("FILL_IN") ||
    !persona.heygenVoiceId  ||
    persona.heygenVoiceId.startsWith("FILL_IN")
  ) {
    const msg = "heygenAvatarId / heygenVoiceId not filled in — skipping render";
    warn(persona.slug, msg);
    // Still generate the script so the content is useful
  }

  // ── Step 1: Generate script via Claude ──────────────────────────────────────
  log(`[${persona.slug}] 📝  Generating script with Claude...`);

  let content;
  try {
    content = await generateScript(persona);
  } catch (err) {
    error(persona.slug, `Claude script generation failed: ${err.message}`);
    return { slug: persona.slug, success: false, error: err.message };
  }

  log(`[${persona.slug}] ✓   Script generated (hook: "${content.hook}")`);

  // ── Step 2: Save post details ────────────────────────────────────────────────
  const postDetailsPath = path.join(outputDir, "post-details.md");
  savePostDetails(postDetailsPath, persona, content, dateSlug);
  log(`[${persona.slug}] ✓   Post details saved → ${postDetailsPath}`);

  // ── Step 3: Submit to HeyGen ─────────────────────────────────────────────────
  let videoRendered = false;
  let videoPath     = null;

  const idsReady =
    persona.heygenAvatarId &&
    !persona.heygenAvatarId.startsWith("FILL_IN") &&
    persona.heygenVoiceId &&
    !persona.heygenVoiceId.startsWith("FILL_IN");

  if (idsReady) {
    log(`[${persona.slug}] 🎬  Submitting to HeyGen for rendering...`);

    let videoId;
    try {
      videoId = await submitToHeyGen(persona, content.voiceover);
    } catch (err) {
      error(persona.slug, `HeyGen submission failed: ${err.message}`);
      saveFailureNote(outputDir, "submission", err.message);
      // Fall through — script is already saved
      return buildResult(persona.slug, outputDir, false, videoRendered, videoPath);
    }

    log(`[${persona.slug}] ⏳  HeyGen video_id: ${videoId} — polling for completion...`);

    // ── Step 4: Poll until done ────────────────────────────────────────────────
    let downloadUrl;
    try {
      downloadUrl = await pollUntilComplete(videoId, persona.slug);
    } catch (err) {
      error(persona.slug, `HeyGen render failed/timed out: ${err.message}`);
      saveFailureNote(outputDir, "render", err.message);
      return buildResult(persona.slug, outputDir, true, false, null);
    }

    // ── Step 5: Download the MP4 ───────────────────────────────────────────────
    log(`[${persona.slug}] ⬇️   Downloading video...`);
    videoPath = path.join(outputDir, "video.mp4");
    try {
      await downloadFile(downloadUrl, videoPath);
      videoRendered = true;
      log(`[${persona.slug}] ✓   Video saved → ${videoPath}`);
    } catch (err) {
      error(persona.slug, `Video download failed: ${err.message}`);
      saveFailureNote(outputDir, "download", err.message);
    }
  } else {
    warn(persona.slug, "Skipping HeyGen render — fill in heygenAvatarId/heygenVoiceId in persona file");
  }

  // ── Step 6: Write Buffer CSV ──────────────────────────────────────────────────
  const csvPath = path.join(outputDir, "buffer-import.csv");
  saveBufferCsv(csvPath, persona, content, dateSlug, videoPath);
  log(`[${persona.slug}] ✓   Buffer CSV saved → ${csvPath}`);

  return buildResult(persona.slug, outputDir, true, videoRendered, videoPath);
}

// ─── Claude Script Generation ─────────────────────────────────────────────────

async function generateScript(persona) {
  const systemPrompt = `You are an expert short-form video scriptwriter for social media influencers.
You write authentic, scroll-stopping scripts tailored to each creator's specific persona, niche, and audience.
Your scripts feel natural when spoken — conversational, punchy, no filler words.
Always respond with valid JSON only, no markdown fences, no extra text.`;

  const userPrompt = `Generate ONE complete video concept for this creator. Today's date: ${todaySlug()}.

CREATOR PROFILE:
- Name: ${persona.name}
- Niche: ${persona.niche}
- Platforms: ${persona.platforms.join(", ")}
- Audience: Ages ${persona.audience.ageRange}, ${persona.audience.gender}
- Audience pain points: ${persona.audience.painPoints.join("; ")}
- Voice/tone: ${persona.voiceTone.join(", ")}
- Content pillars: ${persona.contentPillars.join("; ")}
- CTA: "${persona.cta}"

REQUIREMENTS:
- Hook: A single opening line (spoken in first 3 seconds). Must be ultra-specific, provocative, or counterintuitive. NO generic openers like "Hey guys" or "Today I want to talk about". Make the viewer NEED to keep watching.
- Voiceover: 15-30 seconds of spoken content (approximately 60-120 words). Natural speech rhythm. No bullet points — written as it will be SPOKEN. End with the CTA woven in naturally.
- Caption: 150-300 characters. Persona's authentic voice. CTA worked in organically. No emojis unless they fit the niche.
- Hashtags: 15-20 hashtags, mostly niche and long-tail (avoid generic ones like #fyp alone). Mix of sizes.
- Overlays: 3-5 short on-screen text lines (5 words max each) that appear at key moments to reinforce the spoken points.
- Topic: Pick the most timely/relevant content pillar for today. Vary from what a typical creator in this space would post.

Respond with ONLY this JSON structure:
{
  "topic": "one-line topic description",
  "hook": "the hook line as it will be spoken",
  "voiceover": "the full voiceover script as it will be spoken",
  "caption": "the full social caption text",
  "hashtags": ["hashtag1", "hashtag2"],
  "overlays": ["overlay line 1", "overlay line 2", "overlay line 3"]
}`;

  const message = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 1024,
    messages: [{ role: "user", content: userPrompt }],
    system: systemPrompt,
  });

  const raw = message.content[0].text.trim();
  try {
    return JSON.parse(raw);
  } catch {
    // Try to extract JSON if Claude wrapped it in any extra text
    const match = raw.match(/\{[\s\S]*\}/);
    if (match) return JSON.parse(match[0]);
    throw new Error(`Claude returned non-JSON response: ${raw.slice(0, 200)}`);
  }
}

// ─── HeyGen API Calls ─────────────────────────────────────────────────────────

async function submitToHeyGen(persona, voiceover) {
  const style  = persona.videoStyle || {};
  const bgColor = style.background || "#FAFAFA";
  const dim    = style.dimension   || { width: 1080, height: 1920 };

  const payload = {
    video_inputs: [
      {
        character: {
          type: "avatar",
          avatar_id: persona.heygenAvatarId,
          avatar_style: "normal",
        },
        voice: {
          type: "text",
          input_text: voiceover,
          voice_id: persona.heygenVoiceId,
        },
        background: {
          type: "color",
          value: bgColor,
        },
      },
    ],
    dimension: dim,
    title: `${persona.slug}-${todaySlug()}`,
  };

  const res  = await heygenPost("/v2/video/generate", payload);
  const data = await res.json();

  if (!res.ok) {
    throw new Error(
      `HeyGen generate returned ${res.status}: ${JSON.stringify(data)}`
    );
  }

  const videoId = data?.data?.video_id;
  if (!videoId) {
    throw new Error(`No video_id in HeyGen response: ${JSON.stringify(data)}`);
  }

  return videoId;
}

async function pollUntilComplete(videoId, slug) {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  let attempt    = 0;

  while (Date.now() < deadline) {
    attempt++;
    const res  = await heygenGet(`/v1/video_status.get?video_id=${videoId}`);
    const data = await res.json();

    if (!res.ok) {
      throw new Error(
        `Status check ${attempt} returned ${res.status}: ${JSON.stringify(data)}`
      );
    }

    const status   = data?.data?.status;
    const progress = data?.data?.progress ?? null;
    const progressStr = progress !== null ? ` (${progress}%)` : "";

    log(`[${slug}] ⏳  Poll #${attempt}: status=${status}${progressStr}`);

    if (status === "completed") {
      const url = data?.data?.video_url;
      if (!url) throw new Error("status=completed but no video_url in response");
      return url;
    }

    if (status === "failed") {
      const reason = data?.data?.error ?? "unknown";
      throw new Error(`HeyGen render failed: ${reason}`);
    }

    // status is "pending" or "processing" — keep waiting
    await sleep(POLL_INTERVAL_MS);
  }

  throw new Error(`Timed out after ${POLL_TIMEOUT_MS / 1000}s waiting for HeyGen render`);
}

async function downloadFile(url, destPath) {
  const { default: fetch } = await import("node-fetch");
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed: HTTP ${res.status} from ${url}`);

  const buffer = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(destPath, buffer);
}

// ─── HeyGen HTTP Helpers ──────────────────────────────────────────────────────

async function heygenPost(path, body) {
  const { default: fetch } = await import("node-fetch");
  return fetch(`${HEYGEN_BASE}${path}`, {
    method: "POST",
    headers: {
      "X-Api-Key": HEYGEN_API_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

async function heygenGet(path) {
  const { default: fetch } = await import("node-fetch");
  return fetch(`${HEYGEN_BASE}${path}`, {
    method: "GET",
    headers: { "X-Api-Key": HEYGEN_API_KEY },
  });
}

// ─── File Savers ──────────────────────────────────────────────────────────────

function savePostDetails(filePath, persona, content, dateSlug) {
  const lines = [
    `# Post Details — ${persona.name} — ${dateSlug}`,
    "",
    `**Topic:** ${content.topic}`,
    "",
    "---",
    "",
    "## Hook",
    "",
    content.hook,
    "",
    "## Voiceover Script",
    "",
    content.voiceover,
    "",
    "## Caption",
    "",
    content.caption,
    "",
    "## Hashtags",
    "",
    content.hashtags.map((h) => (h.startsWith("#") ? h : `#${h}`)).join(" "),
    "",
    "## On-Screen Text Overlays",
    "",
    ...content.overlays.map((o, i) => `${i + 1}. ${o}`),
    "",
  ];
  fs.writeFileSync(filePath, lines.join("\n"), "utf8");
}

function saveBufferCsv(filePath, persona, content, dateSlug, videoPath) {
  const caption  = `"${content.caption.replace(/"/g, '""')}"`;
  const hashtags = `"${content.hashtags.map((h) => (h.startsWith("#") ? h : `#${h}`)).join(" ").replace(/"/g, '""')}"`;
  const videoFile = videoPath ? path.relative(__dirname, videoPath) : "VIDEO_RENDER_FAILED";

  const suggestedTimes = {
    TikTok: "18:00",
    "Instagram Reels": "19:00",
    "YouTube Shorts": "20:00",
    LinkedIn: "08:00",
  };

  const rows = ["platform,caption,hashtags,video_file,suggested_post_time"];
  for (const platform of persona.platforms) {
    const time = suggestedTimes[platform] ?? "18:00";
    rows.push(`${platform},${caption},${hashtags},${videoFile},${time}`);
  }

  fs.writeFileSync(filePath, rows.join("\n") + "\n", "utf8");
}

function saveFailureNote(outputDir, stage, message) {
  const notePath = path.join(outputDir, "RENDER_FAILED.txt");
  const note = [
    `FAILURE STAGE: ${stage}`,
    `TIME: ${new Date().toISOString()}`,
    `ERROR: ${message}`,
    "",
    "The script, caption, and hashtags have been saved to post-details.md.",
    "You can manually re-submit the voiceover script to HeyGen Studio.",
  ].join("\n");
  fs.writeFileSync(notePath, note, "utf8");
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function buildResult(slug, outputDir, success, videoRendered, videoPath) {
  return { slug, outputDir, success, videoRendered, videoPath };
}

function todaySlug() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function loadEnv(envPath) {
  if (!fs.existsSync(envPath)) return;
  const lines = fs.readFileSync(envPath, "utf8").split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim().replace(/^['"]|['"]$/g, "");
    if (key && !(key in process.env)) process.env[key] = val;
  }
}

function log(msg)   { console.log(msg); }
function warn(slug, msg) { console.warn(`[${slug}] ⚠  ${msg}`); }
function error(slug, msg) { console.error(`[${slug}] ✗  ${msg}`); }
function fatal(msg) { console.error(`FATAL: ${msg}`); process.exit(1); }
