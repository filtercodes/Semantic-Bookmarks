// offscreen.js
const SCRAPE_TIMEOUT_MS = 15000; // 15 seconds

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'scrape') {
    scrape(message.payload).then(sendResponse);
    return true;
  }
});

async function scrape(url) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), SCRAPE_TIMEOUT_MS);

  try {
    const response = await fetch(url, { signal: controller.signal });
    clearTimeout(timeoutId); // Clear the timeout if the fetch succeeds

    if (!response.ok) {
      return { error: `Failed to fetch ${url}: ${response.statusText}` };
    }

    // --- Content-Type Check ---
    // We are only processing HTML content.
    const contentType = response.headers.get('Content-Type');
    if (!contentType || !contentType.includes('text/html')) {
      return { error: `Unsupported content type: ${contentType || 'N/A'}` };
    }

    const html = await response.text();
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, 'text/html');

    // Remove script, style, nav, footer, and header elements
    doc.querySelectorAll('script, style, nav, footer, header, aside').forEach((el) => el.remove());

    // Try to find the main content of the page
    const mainContent = doc.querySelector('article') || doc.querySelector('main') || doc.body;

    if (!mainContent) {
      return { text: '' };
    }

    // Get text and clean it up
    let rawText = mainContent.innerText;

    // --- Comprehensive Cleaning ---
    // Define a list of regex patterns to remove unwanted content like URLs, file paths, and code snippets.
    const cleaningPatterns = [
      /https?:\/\/[^\s/$.?#].[^\s]*/g, // URLs
      /(?:[a-zA-Z]:)?(?:\\|\/)[^\s:"|*?<>]+\/[^\s:"|*?<>]*/g, // File Paths
      /^\s*[\$#%>]\s*.*/gm, // Lines starting with shell prompts
      /^\s*\w+\s*=\s*.*$/gm, // Lines with variable assignments (e.g., x = 10)
      /^\s*.*\b\w+\.\w+\(.*?\).*$/gm, // Lines with method calls (e.g., object.method())
      /^\s*\[.*,.*\]\s*$/gm, // Lines that look like lists/arrays
      /^\s*".*"\s*:\s*".*",?\s*$/gm, // Lines that look like key-value pairs (JSON/Headers)
      /^\s*(.)\1{4,}\s*$/gm, // Lines with repeated characters (e.g., -----, =====)
      /^\s*[\w.-]+\s*\(\d{4}-\d{2}-\d{2}\)\s*$/gm, // Changelog entries (e.g., 1.2.3 (2023-01-01))
      /b(["']).*?\1/g, // Python-style byte strings (e.g., b'...')
      /^.*\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\s*→\s*\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}.*$/gm, // Network logs (e.g., 127.0.0.1 -> 127.0.0.1)
      /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\+\d{2}:\d{2}/g // ISO-formatted timestamps
    ];

    // Apply all cleaning patterns
    for (const pattern of cleaningPatterns) {
      rawText = rawText.replace(pattern, '');
    }

    // --- Word Length Filter ---
    // Define a reasonable maximum length for a single "word".
    const MAX_WORD_LENGTH = 150;
    const words = rawText.split(/\s+/);
    const saneWords = words.flatMap(word => {
        if (word.length > MAX_WORD_LENGTH) {
            const chunks = [];
            for (let i = 0; i < word.length; i += MAX_WORD_LENGTH) {
                chunks.push(word.substring(i, i + MAX_WORD_LENGTH));
            }
            return chunks;
        }
        return [word];
    });
    const text = saneWords.join(' ').replace(/\s\s+/g, ' ').trim();

    return { text };
  } catch (error) {
    clearTimeout(timeoutId);
    if (error.name === 'AbortError') {
      return { error: `Failed to scrape ${url}: Request timed out after ${SCRAPE_TIMEOUT_MS / 1000} seconds.` };
    }
    return { error: `Failed to scrape ${url}: ${error.message}` };
  }
}
