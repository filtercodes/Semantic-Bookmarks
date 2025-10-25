// background.js

const DB_NAME = 'semanticBookmarks';
const DB_VERSION = 1;
const BOOKMARKS_STORE = 'bookmarks';
const EMBEDDINGS_STORE = 'embeddings';
const INDEXED_FOLDERS_KEY = 'indexedFolders';
const SIMILARITY_THRESHOLD = 0.5;
const SEARCH_RESULT_LIMIT = 30;
const MIN_SCRAPE_LENGTH = 100; // Minimum number of characters for a scrape to be considered successful

let db;
let SCRAPING_ANTI_PATTERNS = [];

// --- Database and Initialization ---

function openDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (event) => {
      db = event.target.result;
      if (!db.objectStoreNames.contains(BOOKMARKS_STORE)) {
        db.createObjectStore(BOOKMARKS_STORE, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(EMBEDDINGS_STORE)) {
        const embeddingsStore = db.createObjectStore(EMBEDDINGS_STORE, { autoIncrement: true });
        embeddingsStore.createIndex('bookmarkId', 'bookmarkId', { unique: false });
      }
    };

    request.onsuccess = (event) => {
      db = event.target.result;
      resolve(db);
    };

    request.onerror = (event) => {
      reject(event.target.error);
    };
  });
}

async function loadAntiPatterns() {
  try {
    const response = await fetch(chrome.runtime.getURL('scrape_clean.txt'));
    const text = await response.text();
    SCRAPING_ANTI_PATTERNS = text
      .split('\n')
      .map(line => line.trim().toLowerCase())
      .filter(line => line && !line.startsWith('#'));
    console.log('Loaded scraping anti-patterns:', SCRAPING_ANTI_PATTERNS);
  } catch (error) {
    console.error('Failed to load scrape_clean.txt:', error);
  }
}

// --- Message Listeners ---

// Use a promise to ensure initialization is complete before handling messages
const initializationComplete = (async () => {
  await openDB();
  await loadAntiPatterns();
})();

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Wrap the message handling in an async function to wait for initialization
  (async () => {
    await initializationComplete;

    if (message.type === 'startIndexing') {
      // No need to wait for this to finish, so don't await
      startIndexing(message.payload);
    } else if (message.type === 'search') {
      const results = await search(message.payload);
      sendResponse(results);
    } else if (message.type === 'clearData') {
      await clearAllData();
      sendResponse({ success: true });
    } else if (message.type === 'getStats') {
      const stats = await getStats();
      sendResponse(stats);
    }
  })();

  return true; // Return true to indicate we will send a response asynchronously
});


// --- Core Logic: Indexing ---

function isScrapeSuccessful(text) {
  if (!text || text.length < MIN_SCRAPE_LENGTH) {
    return false;
  }
  const lowercasedText = text.toLowerCase();
  for (const pattern of SCRAPING_ANTI_PATTERNS) {
    if (lowercasedText.includes(pattern)) {
      return false;
    }
  }
  return true;
}

async function startIndexing(selectedFolders) {
  sendStatus('Finding bookmarks...');
  const { indexedFolders = [] } = await chrome.storage.local.get(INDEXED_FOLDERS_KEY);
  const newFoldersToIndex = selectedFolders.filter(id => !indexedFolders.includes(id));

  if (newFoldersToIndex.length === 0) {
    sendStatus('All selected folders are already indexed.');
    return;
  }

  const bookmarks = await getBookmarks(newFoldersToIndex);
  console.log('Found new bookmarks to index:', bookmarks);

  await createOffscreenDocument();

  let count = 0;
  for (const bookmark of bookmarks) {
    count++;
    sendStatus(`Indexing ${count} of ${bookmarks.length}: ${bookmark.title}`);
    const result = await chrome.runtime.sendMessage({ type: 'scrape', payload: bookmark.url });

    if (result && !result.error && isScrapeSuccessful(result.text)) {
      // --- Successful Scrape: Prepend title to content ---
      const textWithTitle = `${bookmark.title}\n\n${result.text}`;
      const chunks = chunkText(textWithTitle);
      for (const chunk of chunks) {
        const embedding = await getEmbedding(chunk);
        if (embedding) {
          await storeData(bookmark, chunk, embedding);
        }
      }
    } else {
      // --- Failed Scrape: Fallback to Title Only ---
      console.log(`Scrape failed for ${bookmark.url}. Falling back to title. Reason:`, result.error || "Failed quality check.");
      const embedding = await getEmbedding(bookmark.title);
      if (embedding) {
        await storeData(bookmark, "[Content could not be scraped...]", embedding);
      }
    }
  }

  await chrome.offscreen.closeDocument();

  const updatedIndexedFolders = [...indexedFolders, ...newFoldersToIndex];
  await chrome.storage.local.set({ [INDEXED_FOLDERS_KEY]: updatedIndexedFolders });

  console.log('Indexing complete.');
  sendStatus('Indexing complete.');
}


// --- Core Logic: Searching ---

async function search(query) {
  console.log('Searching for:', query);
  const queryEmbedding = await getEmbedding(query);
  if (!queryEmbedding) {
    return [];
  }

  const allEmbeddings = await getAllFromStore(EMBEDDINGS_STORE);

  const results = allEmbeddings.map((data) => {
    const similarity = cosineSimilarity(queryEmbedding, data.embedding);
    return {
      bookmarkId: data.bookmarkId,
      chunk: data.chunk,
      similarity: similarity,
    };
  });

  const filteredResults = results.filter((result) => result.similarity >= SIMILARITY_THRESHOLD);

  const bestResults = new Map();
  for (const result of filteredResults) {
    if (!bestResults.has(result.bookmarkId) || result.similarity > bestResults.get(result.bookmarkId).similarity) {
      bestResults.set(result.bookmarkId, result);
    }
  }

  const finalResults = Array.from(bestResults.values());
  finalResults.sort((a, b) => b.similarity - a.similarity);

  const topResults = finalResults.slice(0, SEARCH_RESULT_LIMIT);

  if (topResults.length === 0) {
    return [];
  }

  const bookmarks = await getAllFromStore(BOOKMARKS_STORE);
  const bookmarksById = bookmarks.reduce((acc, bookmark) => {
    acc[bookmark.id] = bookmark;
    return acc;
  }, {});

  const searchResults = [];
  for (const result of topResults) {
    const bookmark = bookmarksById[result.bookmarkId];
    if (bookmark) {
      searchResults.push({
        title: bookmark.title,
        url: bookmark.url,
        chunk: result.chunk,
        similarity: result.similarity,
      });
    }
  }

  return searchResults;
}


// --- Helper Functions ---

async function getEmbedding(text) {
  try {
    const response = await fetch('http://localhost:11434/api/embeddings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'mxbai-embed-large:latest', prompt: text }),
    });
    if (!response.ok) {
      throw new Error(`Failed to get embedding: ${response.statusText}`);
    }
    const data = await response.json();
    return data.embedding;
  } catch (error) {
    console.error('Failed to get embedding:', error);
    return null;
  }
}

function cosineSimilarity(vecA, vecB) {
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < vecA.length; i++) {
    dotProduct += vecA[i] * vecB[i];
    normA += vecA[i] * vecA[i];
    normB += vecB[i] * vecB[i];
  }
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

function chunkText(text, chunkSize = 200) {
  const words = text.split(/\s+/);
  const chunks = [];
  for (let i = 0; i < words.length; i += chunkSize) {
    chunks.push(words.slice(i, i + chunkSize).join(' '));
  }
  return chunks;
}

async function storeData(bookmark, chunk, embedding) {
  const tx = db.transaction([BOOKMARKS_STORE, EMBEDDINGS_STORE], 'readwrite');
  const bookmarksStore = tx.objectStore(BOOKMARKS_STORE);
  const embeddingsStore = tx.objectStore(EMBEDDINGS_STORE);
  bookmarksStore.put(bookmark);
  embeddingsStore.put({ bookmarkId: bookmark.id, chunk: chunk, embedding: embedding });
  return tx.complete;
}

async function getBookmarks(folderIds) {
  return new Promise((resolve) => {
    chrome.bookmarks.getTree((tree) => {
      const bookmarks = [];
      const foldersToSearch = new Set(folderIds);
      function traverse(nodes) {
        for (const node of nodes) {
          if (node.children) {
            if (foldersToSearch.has(node.id)) {
              getAllBookmarksInSubtree(node, bookmarks);
            } else {
              traverse(node.children);
            }
          }
        }
      }
      function getAllBookmarksInSubtree(node, bookmarks) {
        if (node.url) {
          bookmarks.push({ id: node.id, title: node.title, url: node.url });
        }
        if (node.children) {
          for (const child of node.children) {
            getAllBookmarksInSubtree(child, bookmarks);
          }
        }
      }
      traverse(tree);
      resolve(bookmarks);
    });
  });
}

async function createOffscreenDocument() {
  if (await chrome.offscreen.hasDocument()) return;
  await chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['DOM_PARSER'],
    justification: 'To scrape website content',
  });
}

function sendStatus(text) {
  chrome.runtime.sendMessage({ type: 'statusUpdate', payload: text });
}

async function clearAllData() {
  await new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(DB_NAME);
    request.onsuccess = () => resolve();
    request.onerror = (event) => reject(event.target.error);
    request.onblocked = () => {
      if (db) db.close();
      const retryRequest = indexedDB.deleteDatabase(DB_NAME);
      retryRequest.onsuccess = () => resolve();
      retryRequest.onerror = (event) => reject(event.target.error);
    };
  });
  await chrome.storage.local.remove(INDEXED_FOLDERS_KEY);
  await openDB();
  sendStatus('All data has been cleared.');
}

async function getStats() {
  const tx = db.transaction([BOOKMARKS_STORE, EMBEDDINGS_STORE], 'readonly');
  const bookmarksStore = tx.objectStore(BOOKMARKS_STORE);
  const embeddingsStore = tx.objectStore(EMBEDDINGS_STORE);
  const bookmarksCount = await new Promise((resolve, reject) => {
    const request = bookmarksStore.count();
    request.onsuccess = () => resolve(request.result);
    request.onerror = (event) => reject(event.target.error);
  });
  const embeddingsCount = await new Promise((resolve, reject) => {
    const request = embeddingsStore.count();
    request.onsuccess = () => resolve(request.result);
    request.onerror = (event) => reject(event.target.error);
  });
  return { bookmarksCount, embeddingsCount };
}

function getAllFromStore(storeName) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const store = tx.objectStore(storeName);
    const request = store.openCursor();
    const items = [];
    request.onsuccess = (event) => {
      const cursor = event.target.result;
      if (cursor) {
        items.push(cursor.value);
        cursor.continue();
      } else {
        resolve(items);
      }
    };
    request.onerror = (event) => {
      reject(event.target.error);
    };
  });
}
