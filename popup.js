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
  let isFirstResult = true;
  let currentSearchResults = [];

  // Function to render results on the screen
  function renderResults(result, append = false) {
    // If it's the first result, clear any 'Searching...' message
    if (!append && resultsDiv.innerHTML.includes('<i>Searching...</i>')) {
      resultsDiv.innerHTML = '';
    }

    // Remove sentinel before adding new results
    if (sentinel) {
      sentinel.remove();
      sentinel = null; // Clear sentinel reference
    }

    if (result) {
      clearButton.classList.remove('inactive');
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

      const distance = document.createElement('p');
      if (typeof result.distance === 'number' && isFinite(result.distance)) {
        distance.textContent = `Distance: ${result.distance.toFixed(4)}`;
      } else {
        distance.textContent = `Distance: ${result.distance}`;
      }
      distance.style.fontStyle = 'italic';
      distance.style.fontSize = 'small';
      distance.style.color = '#808080';
      resultDiv.appendChild(distance);

      resultsDiv.appendChild(resultDiv);

    } else if (!append && resultsDiv.innerHTML === '') { // Only show 'No results' if nothing has been appended yet
      resultsDiv.innerHTML = 'No results found.';
      clearButton.classList.add('inactive');
    }
  }

  // This function will now be called only when searchComplete is received
  function addSentinelAndSetupObserver() {
    if (resultsDiv.children.length > 0) { // Only add sentinel if there are results to paginate
      sentinel = document.createElement('div');
      sentinel.className = 'loading-indicator';
      resultsDiv.appendChild(sentinel);
      setupObserver();
    }
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
        // If no more results, remove sentinel and don't re-add
        if (results && results.length > 0) {
          currentSearchResults.push(...results); // Add new results to our list
          chrome.storage.session.set({ 
            lastSearchResults: currentSearchResults, // Save the updated list
            currentPage: nextPage 
          });
          results.forEach(result => renderResults(result, true)); // Append each result
          // If we received a full page of results, there might be more
          if (results.length === SEARCH_RESULT_LIMIT) {
            addSentinelAndSetupObserver(); // Re-add sentinel for next page
          }
        } else if (sentinel) {
          sentinel.remove();
          sentinel = null;
        }
      });
    }, 500); // 0.5-second delay
  }

  function performSearch() {
    const query = searchInput.value;

    if (query.length > 2) {
      resultsDiv.innerHTML = '<i>Searching...</i>';
      if (observer) observer.disconnect();

      // Reset state for the new search
      chrome.storage.session.set({ lastSearchQuery: query, lastScrollPosition: 0, currentPage: 1 });
      isFirstResult = true;
      currentSearchResults = [];

      chrome.runtime.sendMessage({ type: 'search', payload: query });
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

  // New message listener for streamed results
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'searchResult') {
      if (isFirstResult) {
        resultsDiv.innerHTML = ''; // Clear "Searching..."
        isFirstResult = false;
      }
      currentSearchResults.push(message.payload); // Collect streamed results
      renderResults(message.payload, true); // Append individual result
    } else if (message.type === 'searchComplete') {
      // All initial results streamed, now set up pagination
      addSentinelAndSetupObserver();
      // Save the complete set of results to session storage
      chrome.storage.session.set({ lastSearchResults: currentSearchResults });
    }
  });

  // Restore state when popup opens
  chrome.storage.session.get(['lastSearchQuery', 'lastSearchResults', 'lastScrollPosition'], (data) => {
    if (data.lastSearchQuery && data.lastSearchResults) {
      searchInput.value = data.lastSearchQuery;
      currentSearchResults = data.lastSearchResults; // Restore currentSearchResults
      // When restoring, we don't stream, we just render the cached page
      data.lastSearchResults.forEach(result => renderResults(result, true));
      // Restore scroll position after results are rendered
      if (data.lastScrollPosition) {
        resultsDiv.scrollTop = data.lastScrollPosition;
      }
      // After restoring, set up the observer for further pagination
      addSentinelAndSetupObserver();
    } else {
      // If there's no state, ensure the button is inactive
      clearButton.classList.add('inactive');
    }
  });
});
