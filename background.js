// background.js

const DB_NAME = 'semanticBookmarks';
const DB_VERSION = 1;
const BOOKMARKS_STORE = 'bookmarks';
const EMBEDDINGS_STORE = 'embeddings';

let db;

function openDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (event) => {
      db = event.target.result;
      if (!db.objectStoreNames.contains(BOOKMARKS_STORE)) {
        db.createObjectStore(BOOKMARKS_STORE, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(EMBEDDINGS_STORE)) {
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

openDB();

const INDEXED_FOLDERS_KEY = 'indexedFolders';

// ... (keep existing openDB function) ...

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'startIndexing') {
    startIndexing(message.payload);
  } else if (message.type === 'search') {
    search(message.payload).then(sendResponse);
    return true; // Indicates that the response is sent asynchronously
  } else if (message.type === 'clearData') {
    clearAllData().then(() => sendResponse({ success: true }));
    return true;
  } else if (message.type === 'getStats') {
    getStats().then(sendResponse);
    return true;
  }
});

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

async function clearAllData() {
  await new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(DB_NAME);
    request.onsuccess = () => resolve();
    request.onerror = (event) => reject(event.target.error);
    request.onblocked = () => {
      // If the database is blocked, it means a connection is still open.
      // We need to close it before deleting.
      if (db) {
        db.close();
      }
      // Retry the deletion
      const retryRequest = indexedDB.deleteDatabase(DB_NAME);
      retryRequest.onsuccess = () => resolve();
      retryRequest.onerror = (event) => reject(event.target.error);
    };
  });
  await chrome.storage.local.remove(INDEXED_FOLDERS_KEY);
  // Re-open the database after deleting it
  await openDB();
  sendStatus('All data has been cleared.');
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
    // ... (rest of the loop is the same)
    const result = await chrome.runtime.sendMessage({
      type: 'scrape',
      payload: bookmark.url,
    });

    if (result && !result.error) {
      const chunks = chunkText(result.text);
      for (const chunk of chunks) {
        const embedding = await getEmbedding(chunk);
        if (embedding) {
          await storeData(bookmark, chunk, embedding);
        }
      }
    } else {
      console.error(`Failed to scrape ${bookmark.url}:`, result.error);
    }
  }

  await chrome.offscreen.closeDocument();

  // Add the newly indexed folders to our stored list
  const updatedIndexedFolders = [...indexedFolders, ...newFoldersToIndex];
  await chrome.storage.local.set({ [INDEXED_FOLDERS_KEY]: updatedIndexedFolders });

  console.log('Indexing complete.');
  sendStatus('Indexing complete.');
}

function sendStatus(text) {
  chrome.runtime.sendMessage({ type: 'statusUpdate', payload: text });
}

async function storeData(bookmark, chunk, embedding) {
  const tx = db.transaction([BOOKMARKS_STORE, EMBEDDINGS_STORE], 'readwrite');
  const bookmarksStore = tx.objectStore(BOOKMARKS_STORE);
  const embeddingsStore = tx.objectStore(EMBEDDINGS_STORE);

  bookmarksStore.put(bookmark);
  embeddingsStore.put({
    bookmarkId: bookmark.id,
    chunk: chunk,
    embedding: embedding,
  });

  return tx.complete;
}

async function getEmbedding(text) {
  try {
    const response = await fetch('http://localhost:11434/api/embeddings', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'mxbai-embed-large:latest',
        prompt: text,
      }),
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

function chunkText(text, chunkSize = 200) {
  const words = text.split(/\s+/);
  const chunks = [];
  for (let i = 0; i < words.length; i += chunkSize) {
    chunks.push(words.slice(i, i + chunkSize).join(' '));
  }
  return chunks;
}

async function createOffscreenDocument() {
  if (await chrome.offscreen.hasDocument()) {
    return;
  }
  await chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['DOM_PARSER'],
    justification: 'To scrape website content',
  });
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
          bookmarks.push({
            id: node.id,
            title: node.title,
            url: node.url,
          });
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

const SIMILARITY_THRESHOLD = 0.5;

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

  results.sort((a, b) => b.similarity - a.similarity);

  const topResults = results
    .filter((result) => result.similarity >= SIMILARITY_THRESHOLD)
    .slice(0, 10);

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
