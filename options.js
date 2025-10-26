// options.js
const INDEXED_FOLDERS_KEY = 'indexedFolders';

document.addEventListener('DOMContentLoaded', () => {
  const foldersDiv = document.getElementById('folders');
  const syncBookmarksButton = document.getElementById('syncBookmarks');
  const selectAllButton = document.getElementById('selectAll');
  const deselectAllButton = document.getElementById('deselectAll');
  const statusDiv = document.getElementById('status');
  const statsDiv = document.getElementById('stats');

  const folderData = {}; // To store folder titles for confirmation messages

  function renderFolders() {
    foldersDiv.innerHTML = ''; // Clear the list to prevent duplicates

    // This is the correct, original pattern for loading data.
    // The `async` keyword here is essential for `await` to work inside.
    chrome.bookmarks.getTree(async (bookmarkTree) => {
      // Await the promise returned by chrome.storage.local.get().
      // This guarantees we have the data before proceeding.
      const storageData = await chrome.storage.local.get(INDEXED_FOLDERS_KEY);
      const indexedFolders = storageData[INDEXED_FOLDERS_KEY] || [];

      // Build the folder list.
      const folders = getFoldersWithCounts(bookmarkTree);

      folders.forEach((folder) => {
        folderData[folder.id] = folder.title; // Store title for later use

        const folderItem = document.createElement('div');
        folderItem.className = 'folder-item';

        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.id = folder.id;
        checkbox.name = folder.title;
        checkbox.value = folder.id;

        // Set the 'checked' state based on the data we loaded.
        checkbox.checked = indexedFolders.includes(folder.id);

        const countSpan = document.createElement('span');
        countSpan.className = 'bookmark-count';
        countSpan.textContent = folder.count;

        const label = document.createElement('label');
        label.htmlFor = folder.id;
        label.className = 'folder-title';
        label.appendChild(document.createTextNode(` ${folder.title}`));

        folderItem.appendChild(checkbox);
        folderItem.appendChild(countSpan);
        folderItem.appendChild(label);

        foldersDiv.appendChild(folderItem);
      });
    });
  }

  function updateStats() {
    chrome.runtime.sendMessage({ type: 'getStats' }, (stats) => {
      if (stats) {
        statsDiv.innerHTML = `
          <p><strong>Indexed Bookmarks:</strong> ${stats.bookmarksCount}</p>
          <p><strong>Total Chunks Stored:</strong> ${stats.embeddingsCount}</p>
        `;
      }
    });
  }

  syncBookmarksButton.addEventListener('click', async () => {
    // Get the state of indexed folders *before* the sync starts.
    const storageData = await chrome.storage.local.get(INDEXED_FOLDERS_KEY);
    const previouslyIndexedIds = storageData[INDEXED_FOLDERS_KEY] || [];
    
    const selectedCheckboxes = document.querySelectorAll('#folders input[type="checkbox"]:checked');
    const selectedFolderIds = Array.from(selectedCheckboxes).map(cb => cb.value);

    const foldersToUnsyncIds = previouslyIndexedIds.filter(id => !selectedFolderIds.includes(id));

    let proceed = true;
    if (foldersToUnsyncIds.length > 0) {
      const foldersToUnsyncNames = foldersToUnsyncIds.map(id => folderData[id] || `(Unknown Folder ID: ${id})`);
      const confirmationMessage = `You are about to unsync and remove all indexed data for the following folders:\n\n- ${foldersToUnsyncNames.join('\n- ')}\n\nDo you want to proceed?`;
      
      proceed = confirm(confirmationMessage);
    }

    if (proceed) {
      statusDiv.textContent = 'Starting sync...';
      chrome.runtime.sendMessage({
        type: 'syncBookmarks',
        payload: selectedFolderIds,
      });
    } else {
      statusDiv.textContent = 'Sync cancelled.';
    }
  });

  selectAllButton.addEventListener('click', () => {
    const checkboxes = document.querySelectorAll('#folders input[type="checkbox"]');
    checkboxes.forEach(checkbox => checkbox.checked = true);
  });

  deselectAllButton.addEventListener('click', () => {
    const checkboxes = document.querySelectorAll('#folders input[type="checkbox"]');
    checkboxes.forEach(checkbox => checkbox.checked = false);
  });

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'statusUpdate') {
      statusDiv.textContent = message.payload;
      if (message.payload.includes('complete')) {
        // When sync is complete, refresh stats and the folder checkboxes to reflect the new state.
        updateStats();
        renderFolders();
      }
    }
  });

  // Initial render and stats load
  renderFolders();
  updateStats();
});

function getFoldersWithCounts(nodes) {
  let folders = [];
  for (const node of nodes) {
    if (node.children) {
      // This check prevents the root node (id '0') from being added, as it has no title.
      if (node.title) {
        const count = countBookmarksInNode(node);
        folders.push({ id: node.id, title: node.title, count: count });
      }
      folders = folders.concat(getFoldersWithCounts(node.children));
    }
  }
  return folders;
}

function countBookmarksInNode(node) {
  let count = 0;
  if (node.children) {
    for (const child of node.children) {
      if (child.url) {
        count++;
      }
    }
  }
  return count;
}
