import * as cheerio from 'cheerio';

function parseNaverUrl(input) {
  const u = new URL(input);
  const m = u.pathname.match(/^\/([^/]+)\/(\d+)/);
  if (!m) throw new Error('네이버 블로그 글 주소 형식이 아닙니다.');
  return { blogId: m[1], logNo: m[2] };
}

function cleanText(s = '') {
  return s
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function decodeLoose(s = '') {
  return String(s)
    .replace(/\\u0026/g, '&')
    .replace(/\\u003d/g, '=')
    .replace(/\\\//g, '/')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function normalizeUrl(src = '') {
  src = decodeLoose(src).trim();
  if (!src) return '';
  if (src.startsWith('//')) src = 'https:' + src;
  if (src.startsWith('http://')) src = 'https://' + src.slice(7);
  return src;
}

function looksLikeNaverImage(url = '') {
  const s = url.toLowerCase();
  if (!/^https?:\/\//.test(s)) return false;

  // Naver blog images are commonly served from these CDN patterns.
  const naverCdn =
    /(?:postfiles|blogfiles|post-phinf|blogpfthumb-phinf|blogthumb|phinf)\.(?:pstatic|naver)\.net/.test(s) ||
    /(?:pstatic|naver)\.net/.test(s);

  const imageLike = /\.(?:jpg|jpeg|png|gif|webp)(?:\?|$)/i.test(s) ||
    /(?:postfiles|blogfiles|post-phinf|phinf)/i.test(s);

  const unwanted = /profile|emoji|sticker|icon|banner|logo|spacer|favicon|map_static|ogq_/i.test(s);

  return naverCdn && imageLike && !unwanted;
}

function imageKey(url = '') {
  // Same photo can appear with different Naver resize query strings.
  return url
    .replace(/[?&]type=[^&]+/i, '')
    .replace(/[?&]w=\d+/i, '')
    .replace(/[?&]h=\d+/i, '')
    .replace(/[?&]+$/, '');
}

function collectUrlsFromString(raw = '') {
  const text = decodeLoose(raw);
  const found = [];

  // Whole string may itself be a URL.
  const whole = normalizeUrl(text);
  if (looksLikeNaverImage(whole)) found.push(whole);

  // Also catch URLs embedded inside JSON / attributes / script data.
  const re = /https?:\/\/[^\s"'<>\\]+/gi;
  for (const m of text.matchAll(re)) {
    const u = normalizeUrl(m[0].replace(/[),}\]]+$/, ''));
    if (looksLikeNaverImage(u)) found.push(u);
  }

  const protocolRelative = /\/\/[^\s"'<>\\]+/gi;
  for (const m of text.matchAll(protocolRelative)) {
    const u = normalizeUrl(m[0].replace(/[),}\]]+$/, ''));
    if (looksLikeNaverImage(u)) found.push(u);
  }

  return found;
}

function parseContent(html) {
  const $ = cheerio.load(html);

  const title = cleanText(
    $('.se-title-text').first().text() ||
    $('.pcol1 .se_textarea').first().text() ||
    $('meta[property="og:title"]').attr('content') ||
    $('title').text()
  );

  const container = $('.se-main-container').first().length
    ? $('.se-main-container').first()
    : ($('#postViewArea').first().length ? $('#postViewArea').first() : $('body'));

  // IMPORTANT: collect images BEFORE removing scripts/UI.
  // Naver can keep image URLs in lazy attributes or serialized data attributes.
  const images = [];
  const seen = new Set();

  function addImage(value) {
    if (!value) return;
    const candidates = collectUrlsFromString(value);
    for (const src of candidates) {
      const key = imageKey(src);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      images.push(src);
    }
  }

  // 1) Normal/lazy-loaded image attributes.
  container.find('img').each((_, el) => {
    const attrs = el.attribs || {};
    [
      attrs['data-lazy-src'],
      attrs['data-src'],
      attrs['data-original'],
      attrs['data-img-src'],
      attrs['data-image-url'],
      attrs['src'],
      attrs['srcset']
    ].forEach(addImage);
  });

  // 2) SmartEditor ONE often stores the original image URL in JSON-ish data attributes.
  container.find('*').each((_, el) => {
    const attrs = el.attribs || {};
    for (const [name, value] of Object.entries(attrs)) {
      if (!value) continue;
      if (/src|image|photo|linkdata|module|url/i.test(name)) addImage(value);
    }
  });

  // 3) Open Graph fallback.
  addImage($('meta[property="og:image"]').attr('content') || '');

  // 4) Last-resort scan of the raw HTML for Naver CDN image URLs.
  // This catches URLs embedded in scripts/JSON that have no visible <img>.
  for (const u of collectUrlsFromString(html)) addImage(u);

  // Now extract text after removing UI/non-content nodes.
  const textContainer = container.clone();
  textContainer.find('script,style,button,svg,noscript').remove();
  const text = cleanText(textContainer.text());

  return { title, text, images: images.slice(0, 60) };
}

async function fetchHtml(url) {
  const r = await fetch(url, {
    headers: {
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/142 Safari/537.36',
      'accept-language': 'ko-KR,ko;q=0.9,en;q=0.8',
      'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8'
    },
    redirect: 'follow'
  });

  if (!r.ok) throw new Error(`네이버 응답 오류: ${r.status}`);
  return await r.text();
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  try {
    const { url } = req.body || {};
    if (!url) return res.status(400).json({ error: '블로그 URL이 필요합니다.' });

    const { blogId, logNo } = parseNaverUrl(url);

    // Try several Naver representations. Some contain text but no image tags,
    // while others contain the actual SmartEditor image metadata.
    const candidates = [
      `https://m.blog.naver.com/${blogId}/${logNo}`,
      `https://m.blog.naver.com/PostView.naver?blogId=${encodeURIComponent(blogId)}&logNo=${encodeURIComponent(logNo)}`,
      `https://blog.naver.com/PostView.naver?blogId=${encodeURIComponent(blogId)}&logNo=${encodeURIComponent(logNo)}&redirect=Dlog&widgetTypeCall=true&directAccess=false`
    ];

    let bestText = '';
    let bestTitle = '';
    const mergedImages = [];
    const mergedSeen = new Set();
    const errors = [];

    for (const target of candidates) {
      try {
        const html = await fetchHtml(target);
        const parsed = parseContent(html);

        if (parsed.text.length > bestText.length) {
          bestText = parsed.text;
          if (parsed.title) bestTitle = parsed.title;
        } else if (!bestTitle && parsed.title) {
          bestTitle = parsed.title;
        }

        for (const img of parsed.images) {
          const key = imageKey(img);
          if (!key || mergedSeen.has(key)) continue;
          mergedSeen.add(key);
          mergedImages.push(img);
        }
      } catch (e) {
        errors.push(`${target} → ${String(e?.message || e)}`);
      }
    }

    if (bestText.length < 80) {
      return res.status(422).json({
        error: '네이버가 자동 수집을 막았습니다. 아래 수동 입력란에 본문을 붙여넣으면 계속 진행할 수 있습니다.',
        details: errors
      });
    }

    res.status(200).json({
      ok: true,
      blogId,
      logNo,
      title: bestTitle,
      text: bestText.slice(0, 30000),
      images: mergedImages.slice(0, 60),
      debug: {
        imageCount: mergedImages.length,
        candidateErrors: errors
      }
    });
  } catch (e) {
    res.status(500).json({ error: e?.message || '추출 중 오류가 발생했습니다.' });
  }
}
