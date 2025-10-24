// options.js
const INDEXED_FOLDERS_KEY = 'indexedFolders';

document.addEventListener('DOMContentLoaded', () => {
  const foldersDiv = document.getElementById('folders');
  const startIndexingButton = document.getElementById('startIndexing');
  const clearDataButton = document.getElementById('clearData');
  const statusDiv = document.getElementById('status');
  const statsDiv = document.getElementById('stats');

  function renderFolders() {
    foldersDiv.innerHTML = ''; // Clear existing folders
    chrome.bookmarks.getTree(async (tree) => {
      const { indexedFolders = [] } = await chrome.storage.local.get(INDEXED_FOLDERS_KEY);
      const folders = getFolders(tree);

      folders.forEach((folder) => {
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.id = folder.id;
        checkbox.name = folder.title;
        checkbox.value = folder.id;

        const label = document.createElement('label');
        label.htmlFor = folder.id;
        label.appendChild(document.createTextNode(` ${folder.title}`));

        if (indexedFolders.includes(folder.id)) {
          checkbox.checked = true;
          checkbox.disabled = true;
          label.style.color = '#aaa'; // Visually indicate it's already indexed
        }

        const br = document.createElement('br');

        foldersDiv.appendChild(checkbox);
        foldersDiv.appendChild(label);
        foldersDiv.appendChild(br);
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

  startIndexingButton.addEventListener('click', () => {
    statusDiv.textContent = 'Starting...';
    const selectedFolders = [];
    const checkboxes = document.querySelectorAll('#folders input[type="checkbox"]:checked');
    checkboxes.forEach((checkbox) => {
      selectedFolders.push(checkbox.value);
    });

    chrome.runtime.sendMessage({
      type: 'startIndexing',
      payload: selectedFolders,
    });
  });

  clearDataButton.addEventListener('click', () => {
    if (confirm('Are you sure you want to delete all indexed data? This cannot be undone.')) {
      statusDiv.textContent = 'Clearing data...';
      chrome.runtime.sendMessage({ type: 'clearData' }, (response) => {
        if (response.success) {
          statusDiv.textContent = 'All data has been cleared.';
          renderFolders(); // Re-render the folders to update their state
          updateStats(); // Refresh stats
        }
      });
    }
  });

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'statusUpdate') {
      statusDiv.textContent = message.payload;
      if (message.payload === 'Indexing complete.') {
        renderFolders(); // Re-render to show the new indexed state
        updateStats(); // Refresh stats
      }
    }
  });

  // Initial render and stats load
  renderFolders();
  updateStats();
});

function getFolders(nodes) {
  let folders = [];
  for (const node of nodes) {
    if (node.children) {
      folders.push({ id: node.id, title: node.title });
      folders = folders.concat(getFolders(node.children));
    }
  }
  return folders;
}