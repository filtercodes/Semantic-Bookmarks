// popup.js

document.addEventListener('DOMContentLoaded', () => {
  const searchInput = document.getElementById('search');
  const searchButton = document.getElementById('searchButton');
  const resultsDiv = document.getElementById('results');

  function performSearch() {
    const query = searchInput.value;

    if (query.length > 2) {
      resultsDiv.innerHTML = '<i>Searching...</i>';
      // Send a message to the background script to perform the search
      chrome.runtime.sendMessage({
        type: 'search',
        payload: query,
      }, (results) => {
        resultsDiv.innerHTML = '';
        if (results && results.length > 0) {
          results.forEach((result) => {
            const resultDiv = document.createElement('div');
            resultDiv.style.border = '1px solid #ccc';
            resultDiv.style.padding = '10px';
            resultDiv.style.marginBottom = '10px';

            const title = document.createElement('h3');
            const link = document.createElement('a');
            link.href = result.url;
            link.textContent = result.title;
            link.target = '_blank';
            title.appendChild(link);
            resultDiv.appendChild(title);

            const chunk = document.createElement('p');
            chunk.textContent = result.chunk;
            resultDiv.appendChild(chunk);

            const similarity = document.createElement('p');
            similarity.textContent = `Similarity: ${result.similarity.toFixed(4)}`;
            similarity.style.fontStyle = 'italic';
            resultDiv.appendChild(similarity);

            resultsDiv.appendChild(resultDiv);
          });
        } else {
          resultsDiv.innerHTML = 'No results found.';
        }
      });
    } else {
      resultsDiv.innerHTML = '';
    }
  }

  searchButton.addEventListener('click', performSearch);
  searchInput.addEventListener('keyup', (event) => {
    if (event.key === 'Enter') {
      performSearch();
    }
  });
});
