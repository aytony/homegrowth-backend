// src/builder.js
// Knowledge base builder — fetches a URL and uses AI to extract
// clean, structured regulation content. Works even on JS-heavy sites
// by extracting whatever text is available and letting AI clean it up.

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
};

// ─── FETCH + CLEAN HTML ───────────────────────────────────────────
async function fetchAndClean(url) {
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`HTTP ${res.status}: Cannot fetch ${url}`);
  const html = await res.text();

  // Strip noise
  const clean = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(nav|header|footer|aside|menu)[^>]*>[\s\S]*?<\/\1>/gi, '');

  // Extract title
  const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  const title = titleMatch
    ? titleMatch[1].trim().replace(/\s*[|\-–—]\s*.+$/, '').replace(/\s+/g, ' ')
    : 'Regulation';

  // Convert to plain text — no character limit here, get everything
  const text = clean
    .replace(/<h[1-4][^>]*>([\s\S]*?)<\/h[1-4]>/gi, '\n\n$1\n\n')
    .replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, '\n- $1')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n)))
    .replace(/[ \t]+/g, ' ').replace(/\n{4,}/g, '\n\n\n').trim();

  return { title: decodeEntities(title), rawText: text }; // NO slice — full text
}

function decodeEntities(s) {
  return s.replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>')
          .replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/&nbsp;/g,' ');
}

// ─── GET ALL LINKS FROM A PAGE ────────────────────────────────────
export async function getLinksFromPage(url) {
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`HTTP ${res.status}: Cannot fetch ${url}`);
  const html = await res.text();
  const baseUrl = new URL(url);
  const seen = new Set();
  const links = [];

  const re = /<a\s+[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    let href = m[1].trim();
    const rawText = m[2].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

    if (!href || !rawText || rawText.length < 2) continue;
    if (/^(mailto:|tel:|javascript:|#)/.test(href)) continue;
    if (/\.(css|js|png|jpg|gif|ico|zip|exe)$/i.test(href)) continue;

    try { href = new URL(href, baseUrl).href; } catch { continue; }
    if (seen.has(href)) continue;
    seen.add(href);

    // Get surrounding context (text near the link)
    const pos = m.index;
    const before = html.slice(Math.max(0, pos - 400), pos)
      .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    const context = before.slice(-150);

    links.push({ text: rawText.slice(0, 200), url: href, context });
  }

  return links;
}

// ─── BUILD ONE DOC FROM URL USING AI ─────────────────────────────
export async function buildDocFromUrl(url, geminiKey, geminiModel) {
  const { title, rawText } = await fetchAndClean(url);
  const CHUNK_SIZE = 12000;
  const geminiGenUrl = `https://generativelanguage.googleapis.com/v1beta/models/${geminiModel}:generateContent?key=${geminiKey}`;

  if (rawText.length < 100) {
    throw new Error('Page returned too little text. This site likely requires JavaScript to render. Please use the "Paste Text" option instead.');
  }

  console.log(`  Raw text: ${rawText.length} chars`);
  const chunks = splitIntoChunks(rawText, CHUNK_SIZE);
  console.log(`  Processing in ${chunks.length} chunk(s)`);
  const extractedChunks = [];

  for (let i = 0; i < chunks.length; i++) {
    const prompt = i === 0
      ? `Extract regulation/law/policy content from this page for a knowledge base.
URL: ${url}
Title: ${title}
Part ${i + 1} of ${chunks.length}.

Raw text:
---
${chunks[i]}
---

Remove navigation, menus, footers, breadcrumbs, and website UI text.
Keep ALL: section numbers, legal text, definitions, requirements, dates, code references.
Format with markdown headings (# ## ###).
Return ONLY the content text — no introduction or explanation.`
      : `Continue extracting content. Part ${i + 1} of ${chunks.length}.

Raw text:
---
${chunks[i]}
---

Extract ONLY the actual content from this portion. Remove any website navigation or UI text.
Return ONLY the content text.`;

    try {
      if (i > 0) await new Promise(r => setTimeout(r, 1500));
      const aiRes = await fetch(geminiGenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: { maxOutputTokens: 8192, temperature: 0.1 }
        })
      });
      if (!aiRes.ok) {
        if (aiRes.status === 429) { extractedChunks.push(chunks[i]); continue; }
        throw new Error(`AI failed (${aiRes.status})`);
      }
      const aiData = await aiRes.json();
      const extracted = aiData?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '';
      extractedChunks.push(extracted && extracted !== 'NO_REGULATION_CONTENT' ? extracted : chunks[i]);
    } catch(err) {
      console.log(`  Chunk ${i+1} error: ${err.message} — using raw text`);
      extractedChunks.push(chunks[i]);
    }
  }

  if (!extractedChunks.length) throw new Error('Could not extract any content from this page.');

  const fullContent = extractedChunks.join('\n\n').replace(/\n{4,}/g, '\n\n\n').trim();
  const jurisdiction = detectJurisdiction(url, rawText);
  const effectiveDate = detectEffectiveDate(fullContent);
  const category = detectCategory(fullContent, title);

  console.log(`  Final: ${fullContent.length} chars, ${fullContent.split(/\s+/).filter(Boolean).length} words`);

  return {
    title: cleanTitle(title, fullContent),
    content: fullContent,
    url,
    jurisdiction,
    effectiveDate,
    category,
    wordCount: fullContent.split(/\s+/).filter(Boolean).length,
    aiExtracted: true,
    chunks: chunks.length,
  };
}

// Split text into chunks at paragraph boundaries
function splitIntoChunks(text, chunkSize) {
  if (text.length <= chunkSize) return [text];
  const chunks = [];
  let start = 0;
  while (start < text.length) {
    let end = start + chunkSize;
    if (end >= text.length) { chunks.push(text.slice(start)); break; }
    const slice = text.slice(start, end);
    const lastBreak = Math.max(slice.lastIndexOf('\n\n'), slice.lastIndexOf('\n'));
    if (lastBreak > chunkSize * 0.5) end = start + lastBreak;
    chunks.push(text.slice(start, end).trim());
    start = end;
  }
  return chunks.filter(c => c.length > 0);
}

// ─── BUILD MULTIPLE DOCS FROM INDEX PAGE ─────────────────────────
export async function buildDocsFromIndex(indexUrl, geminiKey, geminiModel, maxPages = 10) {
  // 1. Get all links from index page
  const links = await getLinksFromPage(indexUrl);

  // 2. Filter to likely regulation content links
  const baseHost = new URL(indexUrl).hostname;
  const candidates = links.filter(l => {
    try {
      const lUrl = new URL(l.url);
      // Same domain or leginfo (CA law site)
      return lUrl.hostname === baseHost ||
             lUrl.hostname.includes('leginfo.legislature.ca.gov');
    } catch { return false; }
  }).slice(0, maxPages);

  const results = [];
  const errors = [];

  for (let i = 0; i < candidates.length; i++) {
    const link = candidates[i];
    try {
      await new Promise(r => setTimeout(r, 600)); // polite delay
      const doc = await buildDocFromUrl(link.url, geminiKey, geminiModel);
      // Use link context to enrich the title
      if (link.context && link.context.length > 10) {
        const contextClean = link.context.replace(/\s+/g, ' ').trim();
        if (!doc.title.includes(contextClean.slice(0, 20))) {
          doc.linkContext = contextClean;
        }
      }
      results.push(doc);
    } catch (err) {
      errors.push({ url: link.url, text: link.text, error: err.message });
    }
  }

  return { results, errors, totalLinks: links.length, processed: candidates.length };
}

// ─── HELPERS ──────────────────────────────────────────────────────
function cleanTitle(htmlTitle, content) {
  // Try to get a better title from the first heading in content
  const headingMatch = content.match(/^#\s+(.+)$/m);
  if (headingMatch && headingMatch[1].length > 5 && headingMatch[1].length < 120) {
    return headingMatch[1].trim();
  }
  return htmlTitle;
}

function detectJurisdiction(url, text) {
  const c = (url + text.slice(0, 500)).toLowerCase();
  if (/\.ca\.gov|california/i.test(c)) return 'CA';
  if (/\.ny\.gov|new\s*york/i.test(c))  return 'NY';
  if (/\.tx\.gov|texas/i.test(c))        return 'TX';
  if (/\.fl\.gov|florida/i.test(c))      return 'FL';
  if (/\.wa\.gov|washington/i.test(c))   return 'WA';
  if (/federal|usc\.|cfr\.|hud\.gov/i.test(c)) return 'federal';
  return 'CA';
}

function detectEffectiveDate(text) {
  const patterns = [
    /effective\s+(?:date\s*[:\-]?\s*)?([A-Z][a-z]+\.?\s+\d{1,2},?\s+\d{4})/i,
    /operative\s+(?:on\s+)?([A-Z][a-z]+\.?\s+\d{1,2},?\s+\d{4})/i,
    /amended\s+(?:in\s+)?(\d{4})/i,
  ];
  for (const p of patterns) {
    const m = (text || '').slice(0, 3000).match(p);
    if (m) {
      if (/^\d{4}$/.test(m[1])) return `${m[1]}-01-01`;
      const d = new Date(m[1]);
      if (!isNaN(d.getTime())) return d.toISOString().split('T')[0];
    }
  }
  return '';
}

function detectCategory(text, title) {
  const c = ((title || '') + ' ' + (text || '').slice(0, 500)).toLowerCase();
  if (/rent\s+control|rent\s+increas/i.test(c)) return 'rent_control';
  if (/fair\s+housing|discriminat/i.test(c))     return 'fair_housing';
  if (/security\s+deposit/i.test(c))             return 'deposits';
  if (/evict|unlawful\s+detainer/i.test(c))      return 'evictions';
  if (/habitab|repair|maintenance/i.test(c))     return 'habitability';
  if (/zoning|land\s+use/i.test(c))              return 'zoning';
  if (/mortgage|lending|loan/i.test(c))          return 'landlord_rights';
  if (/inspect|certif/i.test(c))                 return 'inspections';
  if (/cemetery|funeral|burial|cremation/i.test(c)) return 'other';
  return '';
}
