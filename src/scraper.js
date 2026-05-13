// src/scraper.js
// Specialized handlers for:
//   - leginfo.legislature.ca.gov (JSF site — needs special URL rewrite)
//   - cfb.ca.gov (index pages linking to leginfo)
//   - General .gov regulation sites

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Cache-Control': 'no-cache',
};

async function fetchHtml(url) {
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`HTTP ${res.status}: Could not fetch ${url}`);
  return res.text();
}

function delay(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ─── LEGINFO URL REWRITER ──────────────────────────────────────────
// leginfo uses JSF which needs JavaScript to render.
// BUT it also has a plain-text endpoint we can use instead.
// Convert:
//   /faces/codes_displaySection.xhtml?lawCode=BPC&sectionNum=7600.
// To the printable version which returns real HTML:
//   /faces/codes_displayText.xhtml?lawCode=BPC&sectionNum=7600.
// Or the section range version:
//   /faces/codes_displayText.xhtml?lawCode=BPC&article=1&chapter=1
function rewriteLegInfoUrl(url) {
  try {
    const u = new URL(url);
    if (!u.hostname.includes('leginfo.legislature.ca.gov')) return url;

    // Already a text display URL — use as is
    if (u.pathname.includes('codes_displayText')) return url;

    // Convert displaySection or displayExpand to displayText
    if (u.pathname.includes('codes_display')) {
      u.pathname = '/faces/codes_displayText.xhtml';
      return u.toString();
    }

    // Convert section range URLs
    if (u.pathname.includes('codes_display')) {
      u.pathname = '/faces/codes_displayText.xhtml';
      return u.toString();
    }
  } catch {}
  return url;
}

// Build leginfo text URL from lawCode + section range
function buildLegInfoTextUrl(lawCode, fromSection, toSection) {
  if (toSection) {
    return `https://leginfo.legislature.ca.gov/faces/codes_displayText.xhtml?lawCode=${lawCode}&article=${fromSection}`;
  }
  return `https://leginfo.legislature.ca.gov/faces/codes_displayText.xhtml?lawCode=${lawCode}&sectionNum=${fromSection}`;
}

// ─── SCRAPE SINGLE PAGE ───────────────────────────────────────────
export async function scrapeUrl(url) {
  // Rewrite leginfo URL to get actual content
  const fetchUrl = rewriteLegInfoUrl(url);

  const html = await fetchHtml(fetchUrl);
  const title = extractTitle(html);
  const content = extractContent(html, fetchUrl);
  const jurisdiction = detectJurisdiction(url, html);
  const effectiveDate = detectEffectiveDate(content);
  const category = detectCategory(content, title);

  // If content is too short, leginfo JS rendering may have blocked us
  // Try alternate leginfo endpoints
  if (content.split(/\s+/).length < 50 && url.includes('leginfo')) {
    throw new Error(
      'This page requires JavaScript to load (leginfo JSF). ' +
      'Please use the "Paste Text" method: open the page in your browser, ' +
      'select all text (Ctrl+A), copy it, then paste into the Content field manually.'
    );
  }

  return {
    title,
    content: content,
    url,
    jurisdiction,
    effectiveDate,
    category,
    wordCount: content.split(/\s+/).filter(Boolean).length,
  };
}

// ─── GET LINKS WITH CONTEXT ────────────────────────────────────────
export async function scrapeLinks(url) {
  const html = await fetchHtml(url);
  const baseUrl = new URL(url);
  return extractLinksWithContext(html, baseUrl);
}

// ─── DEEP CRAWL ────────────────────────────────────────────────────
export async function scrapeDeep(indexUrl, maxPages = 20) {
  const html = await fetchHtml(indexUrl);
  const baseUrl = new URL(indexUrl);

  const links = extractLinksWithContext(html, baseUrl);
  const results = [];
  const errors = [];
  const skipped = []; // leginfo JS-rendered pages

  for (let i = 0; i < Math.min(links.length, maxPages); i++) {
    const link = links[i];
    await delay(500);

    try {
      // Check if this is a leginfo URL — needs special handling
      if (link.url.includes('leginfo.legislature.ca.gov')) {
        const result = await scrapeLegInfoPage(link);
        if (result) {
          results.push(result);
        } else {
          skipped.push(link);
        }
        continue;
      }

      // General page fetch
      const pageHtml = await fetchHtml(link.url);
      const content = extractContent(pageHtml, link.url);
      const wordCount = content.split(/\s+/).filter(Boolean).length;

      if (wordCount < 30) {
        skipped.push(link);
        continue;
      }

      results.push({
        title: link.label || extractTitle(pageHtml),
        content: content,
        url: link.url,
        jurisdiction: detectJurisdiction(link.url, pageHtml),
        effectiveDate: detectEffectiveDate(content),
        category: detectCategory(content, link.label || ''),
        wordCount,
        sectionNumbers: link.sectionNumbers || '',
        articleName: link.articleName || '',
      });

    } catch (err) {
      errors.push({ url: link.url, label: link.label, error: err.message });
    }
  }

  return {
    results,
    errors,
    skipped,
    totalLinks: links.length,
    legInfoNote: skipped.length > 0
      ? `${skipped.length} pages are on leginfo.legislature.ca.gov which uses JavaScript rendering. To get those, open each link in your browser, select all text, copy and paste into the Admin CMS manually.`
      : null,
  };
}

// ─── LEGINFO SPECIAL HANDLER ───────────────────────────────────────
// Try multiple URL patterns to extract statute text from leginfo
async function scrapeLegInfoPage(link) {
  const u = new URL(link.url);
  const params = u.searchParams;
  const lawCode = params.get('lawCode') || '';
  const sectionNum = params.get('sectionNum') || '';
  const article = params.get('article') || '';

  // Attempt 1: Try the displayText endpoint (sometimes works without JS)
  const textUrl = rewriteLegInfoUrl(link.url);
  try {
    const html = await fetchHtml(textUrl);
    const content = extractContent(html, textUrl);
    const wordCount = content.split(/\s+/).filter(Boolean).length;

    if (wordCount > 50) {
      return {
        title: link.label || extractTitle(html),
        content: content,
        url: link.url,
        jurisdiction: 'CA',
        effectiveDate: detectEffectiveDate(content),
        category: detectCategory(content, link.label || ''),
        wordCount,
        sectionNumbers: link.sectionNumbers || sectionNum,
        articleName: link.articleName || '',
      };
    }
  } catch {}

  // Attempt 2: Try the section display with print view
  if (sectionNum && lawCode) {
    const printUrl = `https://leginfo.legislature.ca.gov/faces/codes_displaySection.xhtml?lawCode=${lawCode}&sectionNum=${sectionNum}&highlight=true`;
    try {
      await delay(300);
      const html = await fetchHtml(printUrl);
      const content = extractContent(html, printUrl);
      if (content.split(/\s+/).length > 50) {
        return {
          title: link.label || `${lawCode} Section ${sectionNum}`,
          content: content,
          url: link.url,
          jurisdiction: 'CA',
          effectiveDate: detectEffectiveDate(content),
          category: detectCategory(content, link.label || ''),
          wordCount: content.split(/\s+/).filter(Boolean).length,
          sectionNumbers: link.sectionNumbers || sectionNum,
          articleName: link.articleName || '',
        };
      }
    } catch {}
  }

  return null; // couldn't get content
}

// ─── LINK EXTRACTION WITH CONTEXT ─────────────────────────────────
function extractLinksWithContext(html, baseUrl) {
  const items = [];
  const seen = new Set();

  const clean = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '');

  // Find all <a> tags
  const anchorRe = /<a\s+[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let match;

  while ((match = anchorRe.exec(clean)) !== null) {
    let href = match[1].trim();
    const linkText = stripTags(match[2]).replace(/\s+/g, ' ').trim();

    if (!href || /^(mailto:|tel:|javascript:|#)/.test(href)) continue;
    if (!linkText || linkText.length < 1) continue;
    if (/\.(css|js|png|jpg|gif|ico|xml|zip|pdf)$/i.test(href)) continue;

    try { href = new URL(href, baseUrl).href; } catch { continue; }
    if (seen.has(href)) continue;
    seen.add(href);

    // Get up to 800 chars of context before this link
    const pos = match.index;
    const before = clean.slice(Math.max(0, pos - 800), pos);
    const beforeText = stripTags(before).replace(/\s+/g, ' ').trim();

    // Detect section number pattern: digits, dots, dashes (e.g. "7600-7610.1")
    const isSectionRef = /^\d[\d\.\-\s,]+$/.test(linkText.trim()) ||
                         /^[\d\.]+\s*[\-–]\s*[\d\.]+/.test(linkText.trim());

    // Find nearest article/chapter heading before this link
    const headingMatch = beforeText.match(
      /(Article|Chapter|Division|Part|Subarticle|Section)\s+[\d\.A-Z]+\.?\s+[A-Za-z][^.]{2,60}/i
    );

    let label = '';
    let articleName = '';
    let sectionNumbers = '';

    if (isSectionRef) {
      sectionNumbers = linkText.trim();
      if (headingMatch) {
        articleName = headingMatch[0].trim();
        label = `${articleName} (§§ ${sectionNumbers})`;
      } else {
        // Use last meaningful phrase before link
        const phrases = beforeText.split(/\s{2,}|\n/).filter(p => p.trim().length > 4);
        const lastPhrase = phrases[phrases.length - 1] || '';
        articleName = lastPhrase.slice(-100).trim();
        label = articleName ? `${articleName} (§§ ${sectionNumbers})` : `Sections ${sectionNumbers}`;
      }
    } else {
      // Link text is descriptive (not just section numbers)
      label = linkText.length > 5 ? linkText : beforeText.slice(-80).trim() || linkText;
      // Check if there's a section range nearby after the link
      const afterText = clean.slice(match.index + match[0].length, match.index + match[0].length + 200);
      const afterPlain = stripTags(afterText).replace(/\s+/g, ' ').trim();
      const sectionAfter = afterPlain.match(/^\s*[\d][\d\.\-\s,]{2,20}/);
      if (sectionAfter) {
        sectionNumbers = sectionAfter[0].trim();
        label = `${label} (§§ ${sectionNumbers})`;
      }
    }

    items.push({
      text: label || linkText,
      label: label || linkText,
      url: href,
      articleName,
      sectionNumbers,
      linkText,
    });
  }

  return items.slice(0, 200);
}

// ─── CONTENT EXTRACTION ───────────────────────────────────────────
function extractContent(html, url) {
  let clean = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(nav|header|footer|aside|menu)[^>]*>[\s\S]*?<\/\1>/gi, '');

  // Site-specific extractors
  if (url && url.includes('leginfo.legislature.ca.gov')) {
    return extractLegInfoContent(clean);
  }

  const patterns = [
    /<div[^>]+(?:id|class)=["'][^"']*(?:law-body|code-body|statute-text|section-text|lawContent|code-text|displaySection)[^"']*["'][^>]*>([\s\S]+?)<\/div>/i,
    /<main[^>]*>([\s\S]+?)<\/main>/i,
    /<article[^>]*>([\s\S]+?)<\/article>/i,
    /<div[^>]+(?:id|class)=["'][^"']*(?:content-area|page-content|main-content|article-body|entry-content|regulation-content)[^"']*["'][^>]*>([\s\S]+)/i,
    /<div[^>]+(?:id|class)=["'][^"']*(?:content|main|body)[^"']*["'][^>]*>([\s\S]+)/i,
    /<td[^>]+(?:id|class)=["'][^"']*(?:content|main)[^"']*["'][^>]*>([\s\S]+?)<\/td>/i,
  ];

  let contentHtml = '';
  for (const pat of patterns) {
    const m = clean.match(pat);
    if (m) {
      const candidate = m[1] || m[0];
      if (stripTags(candidate).trim().length > 100) {
        contentHtml = candidate;
        break;
      }
    }
  }

  if (!contentHtml) {
    const bodyM = clean.match(/<body[^>]*>([\s\S]+?)<\/body>/i);
    contentHtml = bodyM ? bodyM[1] : clean;
  }

  return htmlToText(contentHtml);
}

// Leginfo-specific extractor — tries known div IDs
function extractLegInfoContent(html) {
  // Leginfo wraps statute text in specific divs
  const legInfoPatterns = [
    /<div[^>]+id=["']codeLawSectionNoDeletedDiv["'][^>]*>([\s\S]+?)<\/div>/i,
    /<div[^>]+id=["']displaySectionBody["'][^>]*>([\s\S]+?)<\/div>/i,
    /<div[^>]+class=["'][^"']*law-body[^"']*["'][^>]*>([\s\S]+)/i,
    /<div[^>]+class=["'][^"']*code-body[^"']*["'][^>]*>([\s\S]+)/i,
    // Generic content fallback
    /<div[^>]+id=["']content["'][^>]*>([\s\S]+)/i,
  ];

  for (const pat of legInfoPatterns) {
    const m = html.match(pat);
    if (m && stripTags(m[1]).trim().length > 50) {
      return htmlToText(m[1]);
    }
  }

  // Last resort: extract all paragraph text
  const paras = [];
  const pRe = /<p[^>]*>([\s\S]*?)<\/p>/gi;
  let pm;
  while ((pm = pRe.exec(html)) !== null) {
    const t = stripTags(pm[1]).trim();
    if (t.length > 20) paras.push(t);
  }
  if (paras.length > 2) return paras.join('\n\n');

  return htmlToText(html);
}

function htmlToText(html) {
  return html
    .replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, (_, t) => `\n\n# ${stripTags(t).trim()}\n\n`)
    .replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, (_, t) => `\n\n## ${stripTags(t).trim()}\n\n`)
    .replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, (_, t) => `\n\n### ${stripTags(t).trim()}\n\n`)
    .replace(/<h4[^>]*>([\s\S]*?)<\/h4>/gi, (_, t) => `\n\n#### ${stripTags(t).trim()}\n\n`)
    .replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_, t) => `\n- ${stripTags(t).trim()}`)
    .replace(/<\/[uo]l>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<p[^>]*>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<th[^>]*>/gi, ' | ').replace(/<td[^>]*>/gi, ' | ').replace(/<\/tr>/gi, '\n')
    .replace(/<\/div>|<\/section>/gi, '\n')
    .replace(/<(strong|b)[^>]*>([\s\S]*?)<\/\1>/gi, '$2')
    .replace(/<(em|i)[^>]*>([\s\S]*?)<\/\1>/gi, '$2')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ').replace(/&mdash;/g, '—').replace(/&ndash;/g, '–')
    .replace(/&ldquo;|&rdquo;/g, '"').replace(/&lsquo;|&rsquo;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/[ \t]+/g, ' ').replace(/\n[ \t]+/g, '\n').replace(/[ \t]+\n/g, '\n')
    .replace(/\n{4,}/g, '\n\n\n').trim();
}

function stripTags(html) {
  return (html || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
}

// ─── METADATA ─────────────────────────────────────────────────────
function extractTitle(html) {
  const og = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i);
  if (og) return decodeEnt(og[1].trim());
  const tt = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  if (tt) return decodeEnt(tt[1].trim().replace(/\s*[|\-–—]\s*.+$/, '').replace(/\s+/g, ' '));
  const h1 = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  if (h1) return stripTags(h1[1]).trim();
  return 'Imported Regulation';
}

function decodeEnt(s) {
  return s.replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>')
          .replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/&nbsp;/g,' ');
}

function detectJurisdiction(url, html) {
  const c = (url || '') + (html || '').slice(0, 500);
  if (/\.ca\.gov|california/i.test(c)) return 'CA';
  if (/\.ny\.gov|new\s*york/i.test(c))  return 'NY';
  if (/\.tx\.gov|texas/i.test(c))        return 'TX';
  if (/\.fl\.gov|florida/i.test(c))      return 'FL';
  if (/\.wa\.gov|washington/i.test(c))   return 'WA';
  if (/federal|usc\.|cfr\.|hud\.gov|ftc\.gov/i.test(c)) return 'federal';
  return 'CA';
}

function detectEffectiveDate(text) {
  const patterns = [
    /effective\s+(?:date\s*[:\-]?\s*)?([A-Z][a-z]+\.?\s+\d{1,2},?\s+\d{4})/i,
    /operative\s+(?:on\s+)?([A-Z][a-z]+\.?\s+\d{1,2},?\s+\d{4})/i,
    /as\s+of\s+([A-Z][a-z]+\.?\s+\d{1,2},?\s+\d{4})/i,
    /amended\s+(?:in\s+)?(\d{4})/i,
  ];
  for (const p of patterns) {
    const m = (text||'').slice(0, 3000).match(p);
    if (m) {
      if (/^\d{4}$/.test(m[1])) return `${m[1]}-01-01`;
      const d = new Date(m[1]);
      if (!isNaN(d.getTime())) return d.toISOString().split('T')[0];
    }
  }
  return '';
}

function detectCategory(text, title) {
  const c = ((title||'') + ' ' + (text||'').slice(0, 500)).toLowerCase();
  if (/rent\s+control|rent\s+increas/i.test(c)) return 'rent_control';
  if (/fair\s+housing|discriminat/i.test(c))     return 'fair_housing';
  if (/security\s+deposit/i.test(c))             return 'deposits';
  if (/evict|unlawful\s+detainer/i.test(c))      return 'evictions';
  if (/habitab|repair|maintenance/i.test(c))     return 'habitability';
  if (/zoning|land\s+use/i.test(c))              return 'zoning';
  if (/mortgage|lending|loan/i.test(c))          return 'landlord_rights';
  if (/inspect|certif/i.test(c))                 return 'inspections';
  return '';
}
