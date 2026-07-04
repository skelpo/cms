# Responsive media pipeline — design

Status: **proposal** (2026-06-19). Owner: media subsystem.

Goal: serve every image **at (near-)exactly the size and format the requesting
device needs**, with **caching that is correct by construction**, fully
integrated into the CMS origin — no generic pre-baked thumbnails, no reliance on
a half-baked CDN image resizer. Because the CMS is (or will be) the native
origin, it can do this better than a bolt-on CDN: it knows the source bytes, the
focal point, *and* the layout.

This doc is runtime-agnostic in its URL/cache/markup design; only the codec
implementation differs between Node (today) and Perry-native (later).

---

## 1. Where we are today

- Media rows already store `width`, `height`, `focalPoint` ({x,y} JSON), `sizeBytes`,
  `mimeType`, and **mandatory `altText`** (`migrations/0001_initial.sql`,
  `src/media/store.ts`).
- `GET /api/v1/media/:id/raw` → original bytes (`Cache-Control: immutable`), or
  302 to a backend public URL via `mediaPublicUrl` (`src/routes/api/media.ts`).
- `GET /api/v1/media/:id/url?w&h&format&quality&fit&gravity=focal` → a signed
  **imgproxy** URL (external service; currently offline).
- Site `Picture` (`verrano/site/src/ui.tsx`): with imgproxy off it points
  `<img>` straight at `/raw` — i.e. **ships the full original to every device**
  (bad LCP/bandwidth/CWV). With imgproxy on it uses `@skelpo/site-kit`
  `buildResponsiveImage` → imgproxy srcset.

**Decision:** `/raw` becomes the **canonical original / fallback**. Page markup
must reference sized, format-negotiated derivatives. Retire imgproxy as the
responsive path; replace with an integrated derivative endpoint.

---

## 2. The core tension: "exact size" vs "cacheable"

The server cannot know an image's *rendered* size unless the client tells it.
Two mechanisms exist, neither complete alone:

1. **`srcset`/`sizes` (universal).** Server offers a *menu* of widths; the
   browser picks the smallest candidate satisfying layout × DPR. Works in every
   browser. Rounds up to the nearest offered width (not pixel-exact).
2. **Client Hints (`Sec-CH-Width`, `Sec-CH-DPR`).** Browser sends the exact
   computed layout width + DPR in request headers → server returns the precise
   size. This is the true "exactly what's needed" path — **Chromium only**
   (Safari/Firefox do not send these). An *enhancement*, never the whole answer.

**The "exact" trap:** honoring arbitrary requested widths makes every viewport a
distinct derivative → unbounded CPU/disk and a trivial DoS (`?w=1,2,3,…`). The
fix is **quantization**: snap any requested width *up* to a fixed ladder, clamp
to source width and a max. Visually indistinguishable from exact; cache-bounded
and safe. This single rule separates a robust system from a toy.

Ladder (initial): `[320, 420, 540, 640, 768, 960, 1080, 1280, 1440, 1680, 1920,
2240, 2560, 3200, 3840]`, clamped to `min(sourceWidth, 3840)`. Tune later
(possibly perceptually spaced). DPR handled by the browser via `srcset`
(picks a 2× candidate) or folded into the client-hint computation.

---

## 3. Architecture

### 3.1 Content-addressed, immutable derivative URLs

Every transform param — including a short hash of the source bytes — lives in
the path, so the URL fully determines the bytes:

```
/api/v1/media/{id}/{srcHash8}/{w}x{h}-{fit}-{focal}-q{q}.{avif|webp|jpeg}
# examples
/api/v1/media/5/9f3a1c7e/824x0-cover-c50_40-q72.avif      # focal crop, AVIF
/api/v1/media/5/9f3a1c7e/640x0-fit-q80.webp               # plain fit, WebP
```

- `srcHash8` = first 8 hex of SHA-256 of the source bytes (stored on the row).
- `w`/`h`: target box; `0` = derive from the other + aspect. Always quantized.
- `fit`: `cover` (crop) | `fit` (contain, no crop).
- `focal`: `c{xx}_{yy}` (focal point ×100) when `fit=cover`, else omitted.
- `q`: quality (or a `t{ssim}` target — see §3.6).
- extension = output format.

Because the URL is a pure function of the output bytes:

```
Cache-Control: public, max-age=31536000, immutable
ETag: "{derivativeHash}"            # strong; enables 304
# NO Vary needed
```

Re-edit/replace the image → new `srcHash` → new URLs → automatic cache-bust, no
purge API. **`Vary`-free is the whole point** — it's where generic CDN image
resizers (Vary-on-Width / Vary-on-Accept) cache poorly in shared caches.

### 3.2 First-request generation + persistent derivative cache

1. Request hits the derivative URL.
2. Look up the derivative by key in the cache (disk/S3, behind the existing
   `MediaStorage` interface — new prefix, e.g. `derivatives/`).
3. Hit → stream it (static-file fast path).
4. Miss → decode source, transform, encode, **persist**, then stream.
5. Concurrent misses for the same key coalesce (single-flight lock) so a cold
   popular image isn't transformed N times.

Derivatives are disposable — cheap to regenerate, optional LRU/size-cap eviction.

### 3.3 Format negotiation via `<picture>` (not `Accept`+Vary)

Emit `<source type="image/avif">`, then `image/webp`, then a JPEG `<img>`
fallback. The browser declares its choice by *selecting a source*, so format is
**in the URL** → still no `Vary`. AVIF is typically 30–50% smaller than JPEG at
equal quality → direct LCP win. (Server still validates/limits which formats it
will emit.)

### 3.4 Focal-point art-direction — the structural advantage

We already store `focalPoint`. The endpoint crops to the **exact aspect ratio
the layout asks for**, centered on the focal point, at every breakpoint. A
generic CDN cannot do this — it has no subject metadata. This is what makes
output look hand-cropped everywhere. Default focal `{0.5,0.5}` when unset.

### 3.5 `site-kit` markup generator

Replace `buildResponsiveImage`'s imgproxy target with derivative URLs. It emits:

- `<picture>` with AVIF/WebP/JPEG `<source>`s,
- a quantized `srcset` width ladder (clamped to source width),
- a correct `sizes` per placement (caller-provided; CMS can compute from layout),
- `width`/`height` attrs (kills CLS),
- `loading=lazy` below the fold; `fetchpriority=high` + `<link rel=preload
  imagesrcset>` for the LCP image,
- the LQIP placeholder as inline background (§3.7),
- the mandatory `alt`.

Public API sketch:

```ts
buildResponsiveImage({
  cmsBase, mediaId, srcHash, sourceWidth,
  aspectRatio?,            // forces a focal cover-crop to this ratio
  sizes,                   // e.g. "(max-width:768px) 100vw, 640px"
  formats?: ['avif','webp','jpeg'],
  quality?, ladder?,       // overrides
}) => ResponsiveImage
imageHtml(img, { alt, loading, fetchPriority, className }) => string
```

### 3.6 Quality targeting (optional, phase 3+)

Instead of a fixed `q`, target a perceptual quality (SSIM/butteraugli) or a
target byte-size per derivative, per format. Yields smaller files at equal
perceived quality. Cache key uses the *resolved* `q` so URLs stay immutable.

### 3.7 LQIP / BlurHash

At upload, generate a tiny blur placeholder (BlurHash string or a ~20px inline
data-URI) and store it on the media row. Inline as the element background →
instant first paint, zero layout shift while the real image loads.

### 3.8 Optional Client-Hints "exact" upgrade (phase 3)

Opt in with `Accept-CH: Sec-CH-Width, Sec-CH-DPR` (+ `Critical-CH`). On browsers
that send them, a bare `GET /api/v1/media/:id` (or `/:id/auto`) computes
`ceil(width × dpr)`, **quantizes**, picks format from `<picture>`/Accept, and
**302-redirects to the immutable derivative URL**. Best of both: device-exact
sizing *and* perfect downstream caching. Non-supporting browsers ignore this and
use the `srcset` menu. The redirect response itself: short/no cache, `Vary:
Sec-CH-Width, Sec-CH-DPR, Accept` (only on this thin redirect, never on bytes).

---

## 4. Schema changes

Add to the `media` table (new migration):

| column | type | purpose |
|--------|------|---------|
| `srcHash` | `CHAR(64)` | SHA-256 of source bytes → derivative URL hash + cache-bust |
| `blurhash` | `VARCHAR(64)` NULL | LQIP placeholder |
| `dominantColor` | `CHAR(7)` NULL | optional bg before blur paints |

Backfill `srcHash`/`blurhash` for existing rows via a one-off job (read bytes,
hash, blur). New uploads compute them inline.

---

## 5. `MediaTransformer` interface (runtime-agnostic)

Mirror the storage-backend pattern (`MEDIA_BACKEND`). Routes/markup/cache never
change between implementations.

```ts
interface TransformRequest {
  source: Uint8Array;
  width: number; height: number; fit: 'cover' | 'fit';
  focal?: { x: number; y: number };
  format: 'avif' | 'webp' | 'jpeg';
  quality: number;
}
interface MediaTransformer {
  transform(req: TransformRequest): Promise<Uint8Array>;
  probe(bytes: Uint8Array): Promise<{ width: number; height: number; mime: string }>;
  blurhash(bytes: Uint8Array): Promise<string>;
}
```

- **Node impl (now):** `sharp` (libvips) — decode/resize/encode AVIF/WebP/JPEG,
  focal crop, blurhash. Ships today on the current Node deployment.
- **Perry-native impl (later):** a `@perryts/image`-style lib wrapping a Rust
  stack — `fast_image_resize` + `ravif`/`rav1e` (AVIF), `webp`, `mozjpeg`,
  decoders via `image`/`zune-image`. This is the real engineering cost of "fully
  native"; `sharp` is a native Node addon Perry can't run. The interface lets us
  defer it without blocking the rest.

Selected via `MEDIA_TRANSFORMER=sharp|perry` (default `sharp`).

---

## 6. Caching, correctness, security

- Derivative bytes: `immutable` + strong `ETag`; honor `If-None-Match` → 304.
- No `Vary` on byte responses (format/size are in the URL). `Vary` only on the
  thin client-hint redirect.
- **Anti-flood:** only quantized ladder widths accepted; clamp to source width +
  hard max (3840) and max megapixels; allowlist formats; cap quality range.
  Reject/normalize off-ladder params (302 to nearest, or 400). Optionally sign
  derivative URLs (HMAC) so only CMS-emitted variants generate — prevents a
  derivative-cache DoS.
- Single-flight generation lock per key.
- A dumb CDN or any HTTP cache in front "just works" because URLs are immutable —
  the native origin does the smart part, the edge does distribution.

---

## 7. SEO

- Stable, crawlable derivative + canonical original URLs.
- Correct `Content-Type`; `width`/`height` attrs (CLS); modern formats (LCP).
- Eager + `preload` the LCP image; `loading=lazy` the rest.
- Mandatory descriptive `alt` (already enforced).
- Image sitemap entries. All emitted by the one `site-kit` renderer → consistent.

---

## 8. Why integrated/native beats a CDN here

- **One hop:** origin = transformer; no origin→CDN→resizer indirection.
- **Metadata-aware:** focal point + layout `sizes` live in the CMS; a generic CDN
  resizer has neither, so its crops/sizes are guesses.
- **Markup + bytes from one place:** `srcset`/`sizes`/`<picture>`/preload/LQIP
  stay consistent with what the endpoint can actually produce.
- **Immutable URLs** make every downstream cache correct for free.
- **Policy control:** format/quality/quantization decided centrally, per image.

The genuinely "further than everyone else" parts: **focal-exact art-direction at
every breakpoint**, **content-addressed immutability**, and the
**client-hints→immutable redirect** — all clean *only because* we own the origin.

---

## 9. Phased plan

1. **Derivative endpoint + disk cache + quantization** (Node/`sharp`):
   content-addressed immutable URLs, focal-aware crops, single-flight, 304s.
   Add `srcHash`/`blurhash` columns + backfill job. CLI/API parity per repo rule.
2. **`site-kit` `<picture>`/srcset generator** wired to it; flip site `Picture`
   off `/raw`. → **~95% of the win, on Node, today.**
3. **Client-Hints exact upgrade + LQIP inlining + LCP preload** (+ quality
   targeting, optional).
4. **Perry-native transformer** (`@perryts/image`) behind `MediaTransformer` —
   drop-in once the codec lib exists.

Steps 1–2 are high-leverage, low-risk, and shippable on the current Node prod.
Step 3 is an incremental enhancement, not a prerequisite. Step 4 unblocks
"fully native" and is gated on a Perry-linkable image codec stack.

---

## 10. Open questions

- Derivative storage location/eviction policy (disk vs S3; size cap?).
- Sign derivative URLs (HMAC) vs allowlist-only? (DoS posture.)
- Exact width ladder + whether to space it perceptually.
- Client-Hints: enable globally or per high-traffic template first.
- Backfill strategy for the existing ~140 media rows (one-off job vs lazy on
  first transform).
