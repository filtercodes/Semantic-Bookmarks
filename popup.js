// popup.js

document.addEventListener('DOMContentLoaded', () => {
  // --- Apply Popup Size ---
  const POPUP_SIZE_KEY = 'popupSize';
  chrome.storage.local.get(POPUP_SIZE_KEY, (data) => {
    const size = data[POPUP_SIZE_KEY] || 'medium'; // Default to medium
    document.body.classList.add(`size-${size}`);
  });

  const searchInput = document.getElementById('search');
  const searchButton = document.getElementById('searchButton');
  const clearButton = document.getElementById('clearButton');
  const resultsDiv = document.getElementById('results');
  const SEARCH_RESULT_LIMIT = 30; // Should match the value in background.js

  let observer;
  let sentinel;

  // Function to render results on the screen
  function renderResults(results, append = false) {
    if (!append) {
      resultsDiv.innerHTML = '';
    }

    // Remove sentinel before adding new results
    if (sentinel) {
      sentinel.remove();
    }

    if (results && results.length > 0) {
      clearButton.classList.remove('inactive');
      results.forEach((result) => {
        const resultDiv = document.createElement('div');
        resultDiv.style.padding = '10px';
        resultDiv.style.marginBottom = '10px';

        const title = document.createElement('h3');
        const link = document.createElement('a');
        link.href = result.url;
        link.textContent = result.title;
        link.target = '_blank';
        title.appendChild(link);
        resultDiv.appendChild(title);

        const urlLink = document.createElement('a');
        urlLink.href = result.url;
        urlLink.target = '_blank';
        urlLink.textContent = result.url;
        urlLink.style.fontSize = 'small';
        urlLink.style.color = '#808080';
        urlLink.style.whiteSpace = 'nowrap';
        urlLink.style.overflow = 'hidden';
        urlLink.style.textOverflow = 'ellipsis';
        urlLink.style.display = 'block'; // Block display for overflow to work
        urlLink.style.textDecoration = 'none'; // No underline
        resultDiv.appendChild(urlLink);

        const chunk = document.createElement('p');
        chunk.textContent = result.chunk;
        chunk.style.display = '-webkit-box';
        chunk.style.webkitLineClamp = '6';
        chunk.style.webkitBoxOrient = 'vertical';
        chunk.style.overflow = 'hidden';
        resultDiv.appendChild(chunk);

        const similarity = document.createElement('p');
        similarity.textContent = `Similarity: ${result.similarity.toFixed(4)}`;
        similarity.style.fontStyle = 'italic';
        similarity.style.fontSize = 'small';
        similarity.style.color = '#808080';
        resultDiv.appendChild(similarity);

        resultsDiv.appendChild(resultDiv);
      });

      // If we received a full page of results, there might be more
      if (results.length === SEARCH_RESULT_LIMIT) {
        addSentinel();
      }

    } else if (!append) {
      resultsDiv.innerHTML = 'No results found.';
      clearButton.classList.add('inactive');
    }
  }

  function addSentinel() {
    sentinel = document.createElement('div');
    sentinel.className = 'loading-indicator';
    resultsDiv.appendChild(sentinel);
    setupObserver();
  }

  function setupObserver() {
    if (observer) {
      observer.disconnect();
    }
    observer = new IntersectionObserver(entries => {
      if (entries[0].isIntersecting) {
        loadMoreResults();
      }
    }, { threshold: 1.0 });

    if (sentinel) {
      observer.observe(sentinel);
    }
  }

  async function loadMoreResults() {
    // Stop observing to prevent multiple triggers
    if (observer) {
      observer.disconnect();
    }

    // Show spinner
    if (sentinel) {
      sentinel.innerHTML = '<div class="spinner"></div>';
    }

    const data = await chrome.storage.session.get('currentPage');
    const nextPage = (data.currentPage || 1) + 1;

    // Fake delay for better UX
    setTimeout(() => {
      chrome.runtime.sendMessage({ type: 'getMoreResults', payload: { page: nextPage } }, (results) => {
        renderResults(results, true);
        chrome.storage.session.set({ currentPage: nextPage });
      });
    }, 500); // 0.5-second delay
  }

  function performSearch() {
    const query = searchInput.value;

    if (query.length > 2) {
      resultsDiv.innerHTML = '<i>Searching...</i>';
      if (observer) observer.disconnect();

      // Reset state for the new search
      chrome.storage.session.set({ lastScrollPosition: 0, currentPage: 1 });

      chrome.runtime.sendMessage({ type: 'search', payload: query }, (results) => {
        renderResults(results);
        // Save state to session storage
        chrome.storage.session.set({ lastSearchQuery: query, lastSearchResults: results });
      });
    } else {
      resultsDiv.innerHTML = '';
      if (observer) observer.disconnect();
      chrome.storage.session.remove(['lastSearchQuery', 'lastSearchResults', 'lastScrollPosition', 'currentPage']);
      clearButton.classList.add('inactive');
    }
  }

  function clearSearch() {
    searchInput.value = '';
    resultsDiv.innerHTML = '';
    if (observer) observer.disconnect();
    chrome.storage.session.remove(['lastSearchQuery', 'lastSearchResults', 'lastScrollPosition', 'currentPage']);
    clearButton.classList.add('inactive');
  }

  // Event Listeners
  searchButton.addEventListener('click', performSearch);
  searchInput.addEventListener('keyup', (event) => {
    if (event.key === 'Enter') {
      performSearch();
    }
  });
  clearButton.addEventListener('click', clearSearch);

  // Save scroll position when user scrolls
  let scrollTimeout;
  resultsDiv.addEventListener('scroll', () => {
    clearTimeout(scrollTimeout);
    scrollTimeout = setTimeout(() => {
      chrome.storage.session.set({ lastScrollPosition: resultsDiv.scrollTop });
    }, 200); // Debounce to avoid saving on every single scroll event
  });

  // Restore state when popup opens
  chrome.storage.session.get(['lastSearchQuery', 'lastSearchResults', 'lastScrollPosition'], (data) => {
    if (data.lastSearchQuery && data.lastSearchResults) {
      searchInput.value = data.lastSearchQuery;
      renderResults(data.lastSearchResults);
      // Restore scroll position after results are rendered
      if (data.lastScrollPosition) {
        resultsDiv.scrollTop = data.lastScrollPosition;
      }
    } else {
      // If there's no state, ensure the button is inactive
      clearButton.classList.add('inactive');
    }
  });
});
