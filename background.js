// background.js

const DB_NAME = 'semanticBookmarks';
const BOOKMARKS_STORE = 'bookmarks';
const EMBEDDINGS_STORE = 'embeddings';
const INDEXED_FOLDERS_KEY = 'indexedFolders';
const SIMILARITY_THRESHOLD = 0.5;
const SEARCH_RESULT_LIMIT = 30;
const MIN_SCRAPE_LENGTH = 100; // Minimum number of characters for a scrape to be considered successful

let db;
let SCRAPING_ANTI_PATTERNS = [];
let cachedSearchResults = [];

// --- Database and Initialization ---

function openDB() {
  return new Promise((resolve, reject) => {
    // Version is hardcoded to 1 to avoid complex upgrade paths.
    const request = indexedDB.open(DB_NAME, 1);

    request.onupgradeneeded = (event) => {
      db = event.target.result;
      if (!db.objectStoreNames.contains(BOOKMARKS_STORE)) {
        db.createObjectStore(BOOKMARKS_STORE, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(EMBEDDINGS_STORE)) {
        // The index is no longer created, simplifying the schema.
        db.createObjectStore(EMBEDDINGS_STORE, { autoIncrement: true });
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
  const messageHandlers = {
    syncBookmarks: (payload) => syncBookmarks(payload),
    search: async (payload) => sendResponse(await search(payload)),
    getMoreResults: (payload) => sendResponse(getMoreResults(payload)),
    clearData: async () => sendResponse(await clearAllData()),
    getStats: async () => sendResponse(await getStats()),
  };

  const handler = messageHandlers[message.type];

  if (handler) {
    (async () => {
      await initializationComplete;
      // The handler for getMoreResults is synchronous and doesn't need awaiting
      if (message.type === 'getMoreResults') {
        handler(message.payload);
      } else {
        await handler(message.payload);
      }
    })();

    // Return true only for messages that expect a response.
    return ['search', 'getMoreResults', 'clearData', 'getStats'].includes(message.type);
  }

  // It's good practice to return false or undefined for unhandled messages.
  return false;
});


// --- Core Logic: Syncing ---

function isScrapeSuccessful(text) {
  if (!text || text.length < MIN_SCRAPE_LENGTH) {
    return false;
  }

  // Sanity check: Ensure the text is not mostly gibberish/encoded data.
  // We calculate the percentage of alphanumeric characters.
  const alphanumeric = text.match(/[a-zA-Z0-9]/g);
  if (!alphanumeric) {
    return false; // No alphanumeric characters
  }
  const alphanumericRatio = alphanumeric.length / text.length;
  if (alphanumericRatio < 0.5) { // If less than 50% of chars are alphanumeric
    console.log(`Scrape failed quality check: low alphanumeric ratio (${alphanumericRatio.toFixed(2)})`);
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

async function syncBookmarks(selectedFolderIds) {
  sendStatus('Starting sync...');

  // Get all bookmark IDs currently in the database
  const existingBookmarkIds = new Set(await getAllKeysFromStore(BOOKMARKS_STORE));
  console.log(`Found ${existingBookmarkIds.size} existing bookmarks in DB.`);

  // Get all bookmarks from the user-selected folders
  const bookmarksInSelectedFolders = await getBookmarks(selectedFolderIds);
  const selectedBookmarkIds = new Set(bookmarksInSelectedFolders.map(b => b.id));
  console.log(`Found ${selectedBookmarkIds.size} bookmarks in selected folders.`);

  // Determine what to add and what to remove
  const bookmarksToAdd = bookmarksInSelectedFolders.filter(b => !existingBookmarkIds.has(b.id));
  const bookmarkIdsToRemove = [...existingBookmarkIds].filter(id => !selectedBookmarkIds.has(id));

  console.log(`New bookmarks to index: ${bookmarksToAdd.length}`);
  console.log(`Bookmarks to remove: ${bookmarkIdsToRemove.length}`);

  // Remove bookmarks that are no longer in selected folders
  if (bookmarkIdsToRemove.length > 0) {
    sendStatus(`Removing ${bookmarkIdsToRemove.length} old bookmarks...`);
    await removeBookmarks(bookmarkIdsToRemove);
  }

  // Index the bookmarks
  if (bookmarksToAdd.length > 0) {
    await createOffscreenDocument();
    let count = 0;
    for (const bookmark of bookmarksToAdd) {
      count++;
      sendStatus(`Indexing ${count} of ${bookmarksToAdd.length}: ${bookmark.title}`);
      const result = await chrome.runtime.sendMessage({ type: 'scrape', payload: bookmark.url });

      if (result && !result.error && isScrapeSuccessful(result.text)) {
        const textWithTitle = `${bookmark.title}\n\n${result.text}`;
        const chunks = chunkText(textWithTitle);
        for (const chunk of chunks) {
          // Log the chunk details for diagnosis before sending to the embedding model.
          console.log(`Attempting to embed chunk of length: ${chunk.length} characters.`);
          console.log('Chunk content:', chunk);
          const embedding = await getEmbedding(chunk);
          if (embedding) {
            await storeData(bookmark, chunk, embedding);
          }
        }
      } else {
        console.log(`Scrape failed for ${bookmark.url}. Falling back to title. Reason:`, result.error || "Failed quality check.");
        // Chunk the title as it might be too long, but only use the first chunk.
        const titleChunk = chunkText(bookmark.title)[0];
        if (titleChunk) {
          const embedding = await getEmbedding(titleChunk);
          if (embedding) {
            // Store with a placeholder to indicate the content was not scraped.
            await storeData(bookmark, "[Content could not be scraped...]", embedding);
          }
        }
      }
    }
    await chrome.offscreen.closeDocument();
  }

  // Update the list of indexed folders in storage
  await chrome.storage.local.set({ [INDEXED_FOLDERS_KEY]: selectedFolderIds });

  console.log('Sync complete.');
  sendStatus('Sync complete.');
}


// --- Searching ---

async function search(query) {
  console.log('Searching for:', query);
  cachedSearchResults = []; // Clear previous results

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

  if (finalResults.length === 0) {
    return [];
  }

  const bookmarks = await getAllFromStore(BOOKMARKS_STORE);
  const bookmarksById = bookmarks.reduce((acc, bookmark) => {
    acc[bookmark.id] = bookmark;
    return acc;
  }, {});

  // Store the full list of rich results in the cache
  cachedSearchResults = finalResults.map(result => {
    const bookmark = bookmarksById[result.bookmarkId];
    if (bookmark) {
      return {
        title: bookmark.title,
        url: bookmark.url,
        chunk: result.chunk,
        similarity: result.similarity,
      };
    }
    return null;
  }).filter(Boolean); // Filter out any nulls if a bookmark wasn't found

  // Return only the first page
  return cachedSearchResults.slice(0, SEARCH_RESULT_LIMIT);
}

function getMoreResults({ page }) {
  const startIndex = (page - 1) * SEARCH_RESULT_LIMIT;
  const endIndex = startIndex + SEARCH_RESULT_LIMIT;
  return cachedSearchResults.slice(startIndex, endIndex);
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
      const errorText = await response.text();
      // Check for the specific context length error to retry
      if (errorText.includes('the input length exceeds the context length')) {
        console.warn('Embedding failed due to length, retrying with truncated text.');
        const truncatedText = text.substring(0, 800);
        const retryResponse = await fetch('http://localhost:11434/api/embeddings', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: 'mxbai-embed-large:latest', prompt: truncatedText }),
        });

        if (!retryResponse.ok) {
          const retryErrorText = await retryResponse.text();
          console.error(`Failed to get embedding on retry. Status: ${retryResponse.status}, Response: ${retryErrorText}`);
          throw new Error(`Failed to get embedding on retry: ${retryResponse.statusText}`);
        }
        const data = await retryResponse.json();
        return data.embedding;
      } else {
        // Handle other non-ok responses
        console.error(`Failed to get embedding. Status: ${response.status}, Response: ${errorText}`);
        throw new Error(`Failed to get embedding: ${response.statusText}`);
      }
    }

    const data = await response.json();
    return data.embedding;
  } catch (error) {
    console.error('Exception in getEmbedding:', error);
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

function chunkText(text, maxLength = 1400) {
  const chunks = [];
  while (text.length > 0) {
    if (text.length <= maxLength) {
      chunks.push(text);
      break;
    }
    // Find the last space within the maxLength to avoid breaking words.
    let splitPos = text.lastIndexOf(' ', maxLength);
    
    // If no space is found (e.g., in CJK languages or a long URL),
    // perform hard cut at maxLength.
    if (splitPos <= 0) {
      splitPos = maxLength;
    }
    
    // Push the chunk and update the remaining text.
    chunks.push(text.substring(0, splitPos));
    text = text.substring(splitPos).trim(); // .trim() to remove leading space
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

async function removeBookmarks(bookmarkIds) {
  const idsToDelete = new Set(bookmarkIds);
  return new Promise((resolve, reject) => {
    const tx = db.transaction([BOOKMARKS_STORE, EMBEDDINGS_STORE], 'readwrite');
    const bookmarksStore = tx.objectStore(BOOKMARKS_STORE);
    const embeddingsStore = tx.objectStore(EMBEDDINGS_STORE);

    tx.oncomplete = () => {
      resolve();
    };
    tx.onerror = (event) => {
      reject(event.target.error);
    };

    // Delete the main bookmark entries from the bookmarks store.
    for (const id of idsToDelete) {
      bookmarksStore.delete(id);
    }

    // Iterate over the embeddings to delete related chunks.
    const cursorRequest = embeddingsStore.openCursor();
    cursorRequest.onsuccess = (event) => {
      const cursor = event.target.result;
      if (cursor) {
        if (idsToDelete.has(cursor.value.bookmarkId)) {
          cursor.delete();
        }
        cursor.continue();
      }
    };
  });
}


async function getBookmarks(folderIds) {
  return new Promise((resolve) => {
    chrome.bookmarks.getTree((tree) => {
      const bookmarks = [];
      const foldersToSearch = new Set(folderIds);
      function traverse(nodes) {
        for (const node of nodes) {
          if (foldersToSearch.has(node.id) && node.children) {
            for (const child of node.children) {
              if (child.url) {
                bookmarks.push({ id: child.id, title: child.title, url: child.url });
              }
            }
          }
          if (node.children) {
            traverse(node.children);
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

function getAllKeysFromStore(storeName) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const store = tx.objectStore(storeName);
    const request = store.getAllKeys();
    request.onsuccess = () => {
      resolve(request.result);
    };
    request.onerror = (event) => {
      reject(event.target.error);
    };
  });
}
