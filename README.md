# AI Influencer Video Generator

One command generates a full short-form video for every persona — Claude writes the script, HeyGen renders the avatar video, everything lands in `/output`.

```
node generate.js --all                     # run all personas
node generate.js --creator fitness-coach   # run one persona
```

---

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Create your `.env` file

```bash
cp .env.example .env
```

Then fill in both keys:

```
ANTHROPIC_API_KEY=sk-ant-...
HEYGEN_API_KEY=your-heygen-api-key-here
```

**Getting your Anthropic API key:** [console.anthropic.com](https://console.anthropic.com) → API Keys

**Getting your HeyGen API key:** HeyGen dashboard → Settings → API tab

---

### 3. Fill in your HeyGen avatar & voice IDs

Each persona JSON has two placeholder fields you **must** fill in before video rendering will work:

```json
"heygenAvatarId": "FILL_IN_YOUR_AVATAR_ID_HERE",
"heygenVoiceId":  "FILL_IN_YOUR_VOICE_ID_HERE"
```

#### How to find your Avatar ID

1. Log in to [app.heygen.com](https://app.heygen.com)
2. Go to **Avatars** in the left sidebar
3. Click on the avatar you want to use
4. The `avatar_id` appears in the URL, or you can retrieve it via the API:

```bash
curl -H "X-Api-Key: YOUR_HEYGEN_API_KEY" \
  https://api.heygen.com/v2/avatars
```

Look for `"avatar_id"` in the response JSON for each avatar.

#### How to find your Voice ID

```bash
curl -H "X-Api-Key: YOUR_HEYGEN_API_KEY" \
  https://api.heygen.com/v2/voices
```

Each voice has a `"voice_id"` field. Match the name/language to the voice you want for that persona.
The `default_voice_id` on each avatar record is the voice HeyGen recommends for that avatar.

Paste the IDs directly into the persona's JSON file, e.g.:

```json
"heygenAvatarId": "Angela-inTshirt-20220820",
"heygenVoiceId":  "1bd001e7e50f421d891986aad5158bc8"
```

---

## Project Structure

```
/personas/
  fitness-coach.json       ← persona definitions (edit these)
  finance-creator.json
  mindset-coach.json

/output/
  <slug>/
    <YYYY-MM-DD>/
      video.mp4            ← rendered avatar video (after HeyGen completes)
      post-details.md      ← hook, script, caption, hashtags, overlays
      buffer-import.csv    ← ready to bulk-schedule in Buffer
      RENDER_FAILED.txt    ← only if HeyGen render failed

generate.js                ← main pipeline script
.env                       ← your API keys (never commit this)
.env.example               ← template
```

---

## Adding a New Persona

Copy any existing persona JSON, change the slug (filename and `"slug"` field), fill in the details, and add your HeyGen avatar + voice IDs. That's it — it'll be picked up automatically by `--all`.

**Required persona fields:**

| Field | Description |
|-------|-------------|
| `slug` | Unique ID, matches filename (no spaces) |
| `name` | Creator display name |
| `niche` | What they cover (used in Claude prompt) |
| `platforms` | Array — determines rows in Buffer CSV |
| `audience.ageRange` | Helps Claude target content correctly |
| `audience.painPoints` | Drives hook and script relevance |
| `voiceTone` | Adjectives — shapes Claude's writing style |
| `contentPillars` | Themes Claude picks from each day |
| `cta` | Woven into the voiceover naturally |
| `heygenAvatarId` | From your HeyGen account |
| `heygenVoiceId` | From your HeyGen account |
| `videoStyle.background` | Hex color behind the avatar |
| `videoStyle.dimension` | `{"width": 1080, "height": 1920}` for vertical |

---

## Output Files

### `post-details.md`
Contains the complete content package:
- **Hook** — the scroll-stopping first line
- **Voiceover script** — full spoken text (sent to HeyGen)
- **Caption** — ready to paste into the platform
- **Hashtags** — niche + long-tail mix
- **On-screen text overlays** — cue cards for the editor

### `buffer-import.csv`
One row per platform, ready to import into Buffer's bulk scheduler:

| Column | Description |
|--------|-------------|
| `platform` | TikTok / Instagram Reels / YouTube Shorts |
| `caption` | Full caption text |
| `hashtags` | All hashtags space-separated |
| `video_file` | Relative path to `video.mp4` |
| `suggested_post_time` | Platform-optimized time defaults |

---

## Error Handling

- **HeyGen render fails or times out:** The script, caption, and hashtags are saved to `post-details.md`. A `RENDER_FAILED.txt` note is written to the output folder. You can manually paste the voiceover into HeyGen Studio.
- **One persona fails entirely:** The pipeline logs the error and moves on to the next persona — a full `--all` run won't be stopped by a single failure.
- **HeyGen IDs not filled in:** The script and content are still generated and saved; only the render step is skipped with a warning.

---

## HeyGen Video Rendering Time

HeyGen typically takes **1–5 minutes** to render a short avatar video. The pipeline polls every 10 seconds and times out after 10 minutes. If you hit the timeout, the video is still being rendered — check your HeyGen dashboard and download it manually.
