// Responsive image helpers. Produces srcset + <picture> source data from
// a CMS media id, routed through the CMS's signed imgproxy endpoint
// (GET /api/v1/media/:id/url). Returns plain data so any framework can
// render the markup; imageHtml() emits a ready <picture> string.

export interface ImageVariant {
  format: 'avif' | 'webp' | 'jpeg' | 'png';
  srcset: string;
  type: string;
}

export interface ResponsiveImage {
  src: string;            // fallback jpeg/png src
  sources: ImageVariant[];
  width: number;
  height: number;
}

const DEFAULT_WIDTHS = [400, 800, 1200, 1920];

export interface ImageOptions {
  cmsBase: string;        // e.g. https://cms.perry.land
  mediaId: number;
  widths?: number[];
  aspectRatio?: number;   // width/height; default 16/9
  formats?: Array<ImageVariant['format']>;
}

/**
 * Build responsive image data. URLs point at the CMS media endpoint with
 * width/format query params; the CMS returns a signed imgproxy URL (or
 * the caller can request the JSON form). For SSG, pre-resolve via the
 * SDK's media.url; this helper produces the endpoint URLs directly for
 * the common runtime-render case.
 */
export function buildResponsiveImage(opts: ImageOptions): ResponsiveImage {
  const widths = opts.widths ?? DEFAULT_WIDTHS;
  const formats = opts.formats ?? ['avif', 'webp', 'jpeg'];
  const ar = opts.aspectRatio ?? 16 / 9;
  const base = opts.cmsBase.replace(/\/+$/, '');

  const url = (w: number, fmt: string): string =>
    `${base}/api/v1/media/${opts.mediaId}/raw?w=${w}&format=${fmt}`;

  const sources: ImageVariant[] = formats
    .filter((f) => f !== 'jpeg' && f !== 'png')
    .map((fmt) => ({
      format: fmt,
      type: `image/${fmt}`,
      srcset: widths.map((w) => `${url(w, fmt)} ${w}w`).join(', '),
    }));

  const fallbackFmt = formats.includes('png') ? 'png' : 'jpeg';
  const maxW = widths[widths.length - 1] ?? 1200;
  return {
    src: url(maxW, fallbackFmt),
    sources,
    width: maxW,
    height: Math.round(maxW / ar),
  };
}

function attrEsc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}

export function imageHtml(
  img: ResponsiveImage,
  attrs: { alt: string; sizes?: string; loading?: 'lazy' | 'eager'; fetchPriority?: 'high' | 'low' | 'auto'; className?: string },
): string {
  const sizes = attrs.sizes ?? '100vw';
  const sources = img.sources
    .map((s) => `<source type="${s.type}" srcset="${attrEsc(s.srcset)}" sizes="${attrEsc(sizes)}">`)
    .join('');
  const cls = attrs.className ? ` class="${attrEsc(attrs.className)}"` : '';
  return (
    `<picture>${sources}` +
    `<img src="${attrEsc(img.src)}" alt="${attrEsc(attrs.alt)}" ` +
    `width="${img.width}" height="${img.height}" ` +
    `loading="${attrs.loading ?? 'lazy'}" ` +
    `fetchpriority="${attrs.fetchPriority ?? 'auto'}" ` +
    `sizes="${attrEsc(sizes)}"${cls}></picture>`
  );
}
