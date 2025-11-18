

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
let voyIndex;

// --- Database and Initialization ---

function openDB() {
  return new Promise((resolve, reject) => {
    // Version is hardcoded to 1 to avoid complex upgrade paths.
    const request = indexedDB.open(DB_NAME, 3);

    request.onupgradeneeded = (event) => {
      db = event.target.result;
      if (!db.objectStoreNames.contains(BOOKMARKS_STORE)) {
        db.createObjectStore(BOOKMARKS_STORE, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('voy_index')) {
        db.createObjectStore('voy_index', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(EMBEDDINGS_STORE)) {
        // The index is no longer created, simplifying the schema.
        const embeddingsStore = db.createObjectStore(EMBEDDINGS_STORE, { autoIncrement: true });
        embeddingsStore.createIndex('bookmarkId_index', 'bookmarkId', { unique: false });
      } else {
        const transaction = event.target.transaction;
        const embeddingsStore = transaction.objectStore(EMBEDDINGS_STORE);
        if (!embeddingsStore.indexNames.contains('bookmarkId_index')) {
          embeddingsStore.createIndex('bookmarkId_index', 'bookmarkId', { unique: false });
        }
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
    //console.log('Loaded scraping anti-patterns:', SCRAPING_ANTI_PATTERNS);
  } catch (error) {
    console.error('Failed to load scrape_clean.txt:', error);
  }
}

// --- Service Worker Keepalive ---
let keepAliveInterval;

async function keepAlive() {
  if (keepAliveInterval) {
    return;
  }
  keepAliveInterval = setInterval(() => {
    chrome.runtime.getPlatformInfo(); // A simple API call to keep the SW alive
  }, 20 * 1000); 
}

function stopKeepAlive() {
  if (keepAliveInterval) {
    clearInterval(keepAliveInterval);
    keepAliveInterval = null;
  }
}

function normalize(vector) {
  let sum = 0;
  for (let i = 0; i < vector.length; i++) {
    sum += vector[i] * vector[i];
  }
  const magnitude = Math.sqrt(sum);
  if (magnitude === 0) {
    return vector;
  }
  return vector.map(x => x / magnitude);
}

async function buildVoyIndex() {
  await keepAlive();
  console.log('Building or loading Voy index...');
  try {
    // Try to load the serialized index from IndexedDB
    const serializedIndex = await getFromStore('voy_index', 'main');
    if (serializedIndex) {
      console.log('Found cached index. Deserializing...');
      // The data is now a Uint8Array, which is what deserialize expects
      const newVoyIndex = Voy.deserialize(serializedIndex.data);
      if (newVoyIndex) {
        voyIndex = newVoyIndex;
        console.log('Voy index deserialized successfully.');
        return; // Success, we're done.
      } else {
        console.error('Failed to deserialize Voy index:', Voy.lastError());
        // If deserialization fails, proceed to rebuild.
      }
    }

    // If no cached index, build it from scratch
    console.log('No cached index found. Building from embeddings...');
    const allEmbeddingsData = await getAllFromStore(EMBEDDINGS_STORE);

    if (allEmbeddingsData.length === 0) {
      console.log('No embeddings found to build the index.');
      voyIndex = null;
      return;
    }

    const allBookmarks = await getAllFromStore(BOOKMARKS_STORE);
    const bookmarksById = allBookmarks.reduce((acc, bookmark) => {
      acc[bookmark.id] = bookmark;
      return acc;
    }, {});

    const resources = allEmbeddingsData.map(data => {
      const bookmark = bookmarksById[data.bookmarkId];
      return {
        id: data.bookmarkId,
        title: bookmark ? bookmark.title : 'Untitled',
        url: bookmark ? bookmark.url : '',
        embeddings: Array.from(data.embedding),
      };
    });

    const newVoyIndex = new Voy();
    const BATCH_SIZE = 1000;
    for (let i = 0; i < resources.length; i += BATCH_SIZE) {
      const batch = resources.slice(i, i + BATCH_SIZE);
      const success = newVoyIndex.add_batch({ embeddings: batch });
      if (!success) {
        const error = Voy.lastError();
        throw new Error(`Failed to build Voy index in batch: ${error}`);
      }
    }
    voyIndex = newVoyIndex;
    console.log('Voy index built successfully with', allEmbeddingsData.length, 'embeddings.');

    // Serialize and save the newly built index
    console.log('Serializing and caching new index...');
    const serializedData = voyIndex.serialize();
    if (serializedData) {
      await putInStore('voy_index', { id: 'main', data: serializedData });
      console.log('New index cached successfully.');
    } else {
      console.error('Failed to serialize Voy index:', Voy.lastError());
    }

  } catch (error) {
    console.error('Error during Voy index build/load:', error);
    voyIndex = null;
  } finally {
    stopKeepAlive();
  }
}

// --- Message Listeners ---

import init, { Voy } from './voy_search_bg.js';

// --- Manual WASM Initialization ---
async function initWrapper() {
  const wasmUrl = chrome.runtime.getURL('voy_search_bg.wasm');
  await init(wasmUrl);
}

const initializationComplete = (async () => {
  await openDB();
  await loadAntiPatterns();
  await initWrapper(); // Call our new init function
  await buildVoyIndex(); // Build the Voy index
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

function isDeadLink(scrapeResult) {
  if (!scrapeResult || !scrapeResult.error) {
    return false;
  }
  const errorMsg = scrapeResult.error;
  // Check for client-side errors (4xx) or general network failures.
  return errorMsg.startsWith('[FETCH_FAILED:4') || errorMsg.startsWith('[NETWORK_ERROR]');
}

async function syncBookmarks(selectedFolderIds) {
  await keepAlive();
  
  // Load the existing index or create a new one
  await initializationComplete; // Ensure voyIndex is loaded or created
  if (!voyIndex) {
    voyIndex = new Voy();
    console.log('No existing index found, created a new one.');
  }

  try {
    // Get existing bookmarks and the list of known dead links
    const existingBookmarkIds = new Set(await getAllKeysFromStore(BOOKMARKS_STORE));
    const { deadLinkIds = [] } = await chrome.storage.local.get('deadLinkIds');
    const deadLinkIdsSet = new Set(deadLinkIds);
    console.log(`Found ${existingBookmarkIds.size} existing bookmarks and ${deadLinkIdsSet.size} dead links.`);

    // Get all bookmarks from the user-selected folders
    const bookmarksInSelectedFolders = await getBookmarks(selectedFolderIds);
    const selectedBookmarkIds = new Set(bookmarksInSelectedFolders.map(b => b.id));
    console.log(`Found ${selectedBookmarkIds.size} bookmarks in selected folders.`);

    // --- Cleanup Phase ---
    // Identify bookmarks the user has deleted.
    const allBookmarksInDb = await getAllFromStore(BOOKMARKS_STORE);
    const allBookmarkIdsInDb = new Set(allBookmarksInDb.map(b => b.id));
    const idsToRemove = [...allBookmarkIdsInDb].filter(id => !selectedBookmarkIds.has(id));

    if (idsToRemove.length > 0) {
      sendStatus(`Removing ${idsToRemove.length} old entries...`);
      
      // Get the full bookmark objects for the items we need to remove.
      const bookmarksToRemove = allBookmarksInDb.filter(b => idsToRemove.includes(b.id));
      
      // Incrementally remove from Voy index using the correct title and url
      const embeddingsToRemove = await getEmbeddingsByBookmarkIds(idsToRemove);
      const resourcesToRemove = embeddingsToRemove.map(data => {
        const bookmark = bookmarksToRemove.find(b => b.id === data.bookmarkId);
        return {
          id: data.bookmarkId,
          title: bookmark ? bookmark.title : '',
          url: bookmark ? bookmark.url : '',
          embeddings: Array.from(data.embedding),
        };
      });
      
      if (resourcesToRemove.length > 0) {
        voyIndex.remove({ embeddings: resourcesToRemove });
        console.log(`Incrementally removed ${resourcesToRemove.length} embeddings from Voy index.`);
      }

      await removeBookmarks(idsToRemove); // This now only removes from DB
      console.log(`Cleaned ${idsToRemove.length} obsolete entries from database.`);
    }

    // --- Indexing Phase ---
    // Determine which bookmarks to index: not already in DB and not on the dead list.
    const bookmarksToAdd = bookmarksInSelectedFolders.filter(
      b => !existingBookmarkIds.has(b.id) && !deadLinkIdsSet.has(b.id)
    );
    console.log(`New bookmarks to index: ${bookmarksToAdd.length}`);

    if (bookmarksToAdd.length > 0) {
      await createOffscreenDocument();
      let count = 0;
      const embeddingsToStore = [];

      for (const bookmark of bookmarksToAdd) {
        count++;
        sendStatus(`Indexing ${count} of ${bookmarksToAdd.length}: ${bookmark.title}`);
        const result = await chrome.runtime.sendMessage({ type: 'scrape', payload: bookmark.url });

        if (isDeadLink(result)) {
          console.log(`Skipping dead link for '${bookmark.title}' (${bookmark.url}). Reason:`, result.error);
          deadLinkIdsSet.add(bookmark.id);
          await chrome.storage.local.set({ deadLinkIds: Array.from(deadLinkIdsSet) });
          continue;
        }

        if (result && !result.error && isScrapeSuccessful(result.text)) {
          console.log(`Successfully scraped and indexed '${bookmark.title}' (${bookmark.url}).`);
          const textWithTitle = `${bookmark.title}\n\n${result.text}`;
          const chunks = chunkText(textWithTitle);
          for (const chunk of chunks) {
            console.log(`Attempting to embed chunk of length: ${chunk.length} characters.`);
            console.log('Chunk content:', chunk);
            const embedding = await getEmbedding(chunk);
            if (embedding) {
              const storedData = await storeData(bookmark, chunk, embedding);
              embeddingsToStore.push(storedData);
            }
          }
        } else {
          console.log(`Scrape failed for '${bookmark.title}' (${bookmark.url}), but it's not a dead link. Falling back to title. Reason:`, result.error || "Failed quality check.");
          const titleChunk = chunkText(bookmark.title)[0];
          if (titleChunk) {
            const embedding = await getEmbedding(titleChunk);
            if (embedding) {
              const storedData = await storeData(bookmark, "[Content could not be scraped...]", embedding);
              embeddingsToStore.push(storedData);
            }
          }
        }
      }
      await chrome.offscreen.closeDocument();

      // Store all new embeddings in a single transaction
      if (embeddingsToStore.length > 0) {
        const tx = db.transaction([EMBEDDINGS_STORE], 'readwrite');
        const embeddingsStore = tx.objectStore(EMBEDDINGS_STORE);
        for (const data of embeddingsToStore) {
          embeddingsStore.put(data);
        }
        await tx.complete;
        console.log(`Stored ${embeddingsToStore.length} new embeddings.`);
      }

      // Before rebuilding, invalidate the old index
      const tx = db.transaction('voy_index', 'readwrite');
      const indexStore = tx.objectStore('voy_index');
      indexStore.delete('main');
      await tx.complete;

      // Incrementally add new embeddings to the Voy index
      if (embeddingsToStore.length > 0) {
        const newResources = embeddingsToStore.map(data => ({
          id: data.bookmarkId,
          title: bookmarksToAdd.find(b => b.id === data.bookmarkId)?.title || 'Untitled',
          url: bookmarksToAdd.find(b => b.id === data.bookmarkId)?.url || '',
          embeddings: Array.from(data.embedding),
        }));
        
        voyIndex.add_batch({ embeddings: newResources });
        console.log(`Incrementally added ${newResources.length} new embeddings to Voy index.`);
      }
    }

    // Update the list of indexed folders in storage
    await chrome.storage.local.set({ [INDEXED_FOLDERS_KEY]: selectedFolderIds });

    // Serialize and save the updated index
    console.log('Serializing and caching updated index...');
    const serializedData = voyIndex.serialize();
    if (serializedData) {
      await putInStore('voy_index', { id: 'main', data: serializedData });
      console.log('Updated index cached successfully.');
    } else {
      console.error('Failed to serialize updated Voy index:', Voy.lastError());
    }

    console.log('Sync complete.');
    sendStatus('Sync complete.');
  } finally {
    stopKeepAlive();
  }
}


// --- Searching ---



async function search(query) {
  console.log('Searching for:', query);
  cachedSearchResults = [];

  if (!voyIndex) {
    console.error("Voy index is not ready.");
    return [];
  }

  const queryEmbedding = await getEmbedding(query);
  if (!queryEmbedding) {
    return [];
  }

  const normalizedQueryEmbedding = normalize(queryEmbedding);
  const queryVector = new Float32Array(normalizedQueryEmbedding);

  const searchResult = voyIndex.search(queryVector, 500);
  const neighbors = searchResult.neighbors;

  const neighborBookmarkIds = neighbors.map(n => n.id);
  const relevantEmbeddings = await getEmbeddingsByBookmarkIds(neighborBookmarkIds);
  const embeddingsMap = relevantEmbeddings.reduce((acc, data) => {
    // Store the first chunk found for each bookmarkId
    if (!acc[data.bookmarkId]) {
      acc[data.bookmarkId] = data.chunk;
    }
    return acc;
  }, {});

  const finalResults = neighbors.map(neighbor => ({
    bookmarkId: neighbor.id,
    title: neighbor.title,
    url: neighbor.url,
    chunk: embeddingsMap[neighbor.id] || 'Context not available.',
    distance: neighbor.distance,
  }));

  cachedSearchResults = finalResults;

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
  const tx = db.transaction([BOOKMARKS_STORE], 'readwrite');
  const bookmarksStore = tx.objectStore(BOOKMARKS_STORE);
  bookmarksStore.put(bookmark);
  await tx.complete;
  return { bookmarkId: bookmark.id, chunk: chunk, embedding: embedding };
}

async function removeBookmarks(bookmarkIds) {
  const idsToDelete = new Set(bookmarkIds);
  return new Promise((resolve, reject) => {
    const tx = db.transaction([BOOKMARKS_STORE, EMBEDDINGS_STORE, 'voy_index'], 'readwrite');
    const bookmarksStore = tx.objectStore(BOOKMARKS_STORE);
    const embeddingsStore = tx.objectStore(EMBEDDINGS_STORE);
    const indexStore = tx.objectStore('voy_index');

    tx.oncomplete = () => {
      resolve();
    };
    tx.onerror = (event) => {
      reject(event.target.error);
    };

    // Delete the cached index to force a rebuild
    indexStore.delete('main');

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
  await keepAlive();
  try {
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
    await chrome.storage.local.remove(INDEXED_folders_KEY);
    
    // Re-open the database and clear the index store as well
    await openDB();
    const tx = db.transaction('voy_index', 'readwrite');
    const indexStore = tx.objectStore('voy_index');
    indexStore.clear();
    await tx.complete;

    sendStatus('All data has been cleared.');
  } finally {
    stopKeepAlive();
  }
}

async function getStats() {
  console.log('getStats called');
  try {
    const tx = db.transaction([BOOKMARKS_STORE, EMBEDDINGS_STORE], 'readonly');
    const bookmarksStore = tx.objectStore(BOOKMARKS_STORE);
    const embeddingsStore = tx.objectStore(EMBEDDINGS_STORE);

    const bookmarksCount = await new Promise((resolve, reject) => {
      const request = bookmarksStore.count();
      request.onsuccess = () => resolve(request.result);
      request.onerror = (event) => reject(event.target.error);
    });
    console.log('Bookmarks count from DB:', bookmarksCount);

    const embeddingsCount = await new Promise((resolve, reject) => {
      const request = embeddingsStore.count();
      request.onsuccess = () => resolve(request.result);
      request.onerror = (event) => reject(event.target.error);
    });
    console.log('Embeddings count from DB:', embeddingsCount);

    const stats = { bookmarksCount, embeddingsCount };
    console.log('Returning stats:', stats);
    return stats;
  } catch (error) {
    console.error('Error in getStats:', error);
    return { bookmarksCount: 0, embeddingsCount: 0 };
  }
}

function getFromStore(storeName, key) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const store = tx.objectStore(storeName);
    const request = store.get(key);
    request.onsuccess = () => {
      resolve(request.result);
    };
    request.onerror = (event) => {
      reject(event.target.error);
    };
  });
}

function putInStore(storeName, item) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    const store = tx.objectStore(storeName);
    const request = store.put(item);
    request.onsuccess = () => {
      resolve(request.result);
    };
    request.onerror = (event) => {
      reject(event.target.error);
    };
  });
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

async function getEmbeddingsByBookmarkIds(bookmarkIds) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(EMBEDDINGS_STORE, 'readonly');
    const store = tx.objectStore(EMBEDDINGS_STORE);
    const index = store.index('bookmarkId_index');
    const results = [];
    const idSet = new Set(bookmarkIds);

    index.openCursor().onsuccess = (event) => {
      const cursor = event.target.result;
      if (cursor) {
        if (idSet.has(cursor.key)) {
          results.push(cursor.value);
        }
        cursor.continue();
      } else {
        resolve(results);
      }
    };

    tx.onerror = (event) => {
      reject(event.target.error);
    };
  });
}
