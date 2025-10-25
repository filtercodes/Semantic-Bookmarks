// offscreen.js
const SCRAPE_TIMEOUT_MS = 20000; // 20 seconds

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
    const text = mainContent.innerText.replace(/\s\s+/g, ' ').trim();

    return { text };
  } catch (error) {
    clearTimeout(timeoutId);
    if (error.name === 'AbortError') {
      return { error: `Failed to scrape ${url}: Request timed out after ${SCRAPE_TIMEOUT_MS / 1000} seconds.` };
    }
    return { error: `Failed to scrape ${url}: ${error.message}` };
  }
}
