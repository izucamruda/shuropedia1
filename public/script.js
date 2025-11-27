document.addEventListener('DOMContentLoaded', function() {
    const searchInput = document.getElementById('search');
    const articlesList = document.getElementById('articles-list') || document.querySelector('.sidebar ul');

    async function loadArticlesList() {
        if (!articlesList) return;
        if (articlesList.children.length > 0) return;

        try {
            const response = await fetch('/');
            const text = await response.text();
            const parser = new DOMParser();
            const doc = parser.parseFromString(text, 'text/html');
            const mainList = doc.querySelector('.sidebar ul');
            if (mainList) {
                articlesList.innerHTML = mainList.innerHTML;
            }
        } catch (error) {
            console.error('Ошибка загрузки списка статей:', error);
        }
    }

    function performSearch(query) {
        if (!articlesList) return;
        
        const items = articlesList.getElementsByTagName('li');
        for (let item of items) {
            const link = item.getElementsByTagName('a')[0];
            if (link) {
                const text = link.textContent.toLowerCase();
                if (text.includes(query.toLowerCase())) {
                    item.style.display = '';
                } else {
                    item.style.display = 'none';
                }
            }
        }
    }

    if (searchInput) {
        searchInput.addEventListener('input', function() {
            performSearch(this.value);
        });
    }

    loadArticlesList();
    
    console.log('Вики загружена!');
});