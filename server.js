const express = require('express');
const fs = require('fs').promises;
const path = require('path');
const { marked } = require('marked');
const sqlite3 = require('sqlite3').verbose();
const PDFDocument = require('pdfkit');
const session = require('express-session');

// ==== ИМПОРТ OCTOKIT (ОЧЕНЬ ВАЖНО!) ====
let Octokit;
try {
  Octokit = require('@octokit/rest').Octokit;
  console.log('✅ Octokit библиотека загружена');
} catch (error) {
  console.log('❌ Octokit не найден. Убедись что в package.json есть "@octokit/rest": "^20.0.0"');
  process.exit(1); // Останавливаем сервер если библиотеки нет
}

const app = express();
const PORT = process.env.PORT || 3000;

const ARTICLES_BACKUP_DIR = './articles_backup';
let currentRandomArticle = null;
let lastRandomUpdate = null;

// ==== НАСТРОЙКИ GITHUB ====
const GITHUB_OWNER = process.env.GITHUB_OWNER || 'izucamruda';
const GITHUB_REPO = process.env.GITHUB_REPO || 'shuropedia1';
const GITHUB_PATH = 'articles_backup/';

let octokit = null;
if (process.env.GITHUB_TOKEN) {
  try {
    octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });
    console.log('🔑 GitHub клиент инициализирован.');
  } catch (error) {
    console.log('❌ Ошибка создания GitHub клиента:', error.message);
  }
} else {
  console.log('⚠️  GITHUB_TOKEN не задан. Сохранение в GitHub отключено.');
}

// ==== ФУНКЦИЯ СОХРАНЕНИЯ В GITHUB ====
async function saveArticleToGitHub(title, content) {
  if (!octokit) {
    console.log(`⚠️  GitHub отключен. Статья "${title}" сохранена только локально.`);
    return false;
  }

  try {
    const filename = `${title.replace(/[^a-z0-9а-яё]/gi, '_')}.md`;
    const filePath = `${GITHUB_PATH}${filename}`;
    const contentBase64 = Buffer.from(content).toString('base64');

    let sha = null;
    try {
      const { data } = await octokit.repos.getContent({
        owner: GITHUB_OWNER,
        repo: GITHUB_REPO,
        path: filePath
      });
      sha = data.sha;
      console.log(`✏️  Статья "${title}" найдена на GitHub, обновляем...`);
    } catch (error) {
      console.log(`🆕 Статья "${title}" не найдена, создаем новую...`);
    }

    await octokit.repos.createOrUpdateFileContents({
      owner: GITHUB_OWNER,
      repo: GITHUB_REPO,
      path: filePath,
      message: `📝 ${title}`,
      content: contentBase64,
      sha: sha
    });

    console.log(`✅ Статья "${title}" успешно сохранена в GitHub.`);
    return true;
  } catch (error) {
    console.error(`❌ Ошибка при сохранении в GitHub:`, error.message);
    return false;
  }
}

// ==== СТАРЫЕ ФУНКЦИИ ====
async function backupArticle(title, content) {
    try {
        const filename = `${title.replace(/[^a-z0-9а-яё]/gi, '_')}.md`;
        const filepath = path.join(ARTICLES_BACKUP_DIR, filename);
        await fs.writeFile(filepath, content, 'utf8');
        console.log('💾 Статья сохранена в локальный бэкап:', filename);
    } catch (error) {
        console.error('❌ Ошибка локального бэкапа:', error);
    }
}

async function restoreFromBackup() {
    try {
        const files = await fs.readdir(ARTICLES_BACKUP_DIR);
        console.log(`📁 Найдено локальных файлов: ${files.length}`);
        let restoredCount = 0;
        
        for (const file of files) {
            if (file.endsWith('.md')) {
                const filepath = path.join(ARTICLES_BACKUP_DIR, file);
                const content = await fs.readFile(filepath, 'utf8');
                const title = file.replace('.md', '').replace(/_/g, ' ');
                const existing = await db.getAsync('SELECT id FROM articles WHERE title = ?', [title]);
                if (!existing) {
                    await db.runAsync(
                        'INSERT OR IGNORE INTO articles (title, content) VALUES (?, ?)',
                        [title, content]
                    );
                    restoredCount++;
                }
            }
        }
        console.log(`✅ Восстановлено из локального бэкапа: ${restoredCount}`);
    } catch (error) {
        console.error('❌ Ошибка локального восстановления:', error);
    }
}

async function getTodaysRandomArticle() {
    try {
        const today = new Date().toDateString();
        if (currentRandomArticle && lastRandomUpdate === today) {
            return currentRandomArticle;
        }
        console.log('🎲 Выбираем случайную статью на сегодня...');
        const files = await fs.readdir(ARTICLES_BACKUP_DIR);
        const mdFiles = files.filter(file => file.endsWith('.md'));
        if (mdFiles.length === 0) {
            console.log('📁 В папке бэкапов нет статей');
            return null;
        }
        const todaySeed = new Date().getDate() + new Date().getMonth() * 100 + new Date().getFullYear() * 10000;
        const randomIndex = todaySeed % mdFiles.length;
        const randomFile = mdFiles[randomIndex];
        const filepath = path.join(ARTICLES_BACKUP_DIR, randomFile);
        const content = await fs.readFile(filepath, 'utf8');
        const title = randomFile.replace('.md', '').replace(/_/g, ' ');
        currentRandomArticle = { title: title, content: content, filename: randomFile, selectedDate: today };
        lastRandomUpdate = today;
        console.log(`✅ Случайная статья на сегодня: "${title}"`);
        return currentRandomArticle;
    } catch (error) {
        console.error('❌ Ошибка при выборе случайной статьи:', error);
        return null;
    }
}

// ==== БАЗА ДАННЫХ ====
const db = new sqlite3.Database(path.join(__dirname, 'wiki.db'), async (err) => {
    if (err) {
        console.error('Ошибка подключения к БД:', err);
    } else {
        console.log('✅ Подключен к SQLite базе данных');
        await initDatabase();
    }
});

async function initDatabase() {
    console.log('Создаем базовые таблицы...');
    // Удаляем старые таблицы если есть
    await db.runAsync('DROP TABLE IF EXISTS users');
    await db.runAsync('DROP TABLE IF EXISTS categories');
    await db.runAsync('DROP TABLE IF EXISTS article_categories');
    await db.runAsync('DROP TABLE IF EXISTS comments');
    await db.runAsync('DROP TABLE IF EXISTS favorites');
    await db.runAsync('DROP TABLE IF EXISTS flags');
    await db.runAsync('DROP TABLE IF EXISTS article_history');
    // Создаем только таблицу articles
    await db.runAsync(`CREATE TABLE IF NOT EXISTS articles (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT UNIQUE NOT NULL,
        content TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    console.log('✅ База инициализирована (только статьи)');
    // Загружаем статьи из папки
    await restoreFromBackup();
}

// ==== MIDDLEWARE ====
app.use(express.static('public'));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Исправляем MemoryStore warning
const SQLiteStore = require('connect-sqlite3')(session);
app.use(session({
  store: new SQLiteStore({ db: 'sessions.db', dir: './' }),
  secret: 'wiki-secret-key-2024',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false, maxAge: 7 * 24 * 60 * 60 * 1000 }
}));

app.set('views', path.join(__dirname, 'views'));
app.set('view engine', 'ejs');

// Promisified DB методы
db.getAsync = function(sql, params = []) {
    return new Promise((resolve, reject) => {
        this.get(sql, params, function(err, row) {
            if (err) reject(err);
            else resolve(row);
        });
    });
};
db.allAsync = function(sql, params = []) {
    return new Promise((resolve, reject) => {
        this.all(sql, params, function(err, rows) {
            if (err) reject(err);
            else resolve(rows);
        });
    });
};
db.runAsync = function(sql, params = []) {
    return new Promise((resolve, reject) => {
        this.run(sql, params, function(err) {
            if (err) reject(err);
            else resolve({ id: this.lastID, changes: this.changes });
        });
    });
};

function requireAuth(req, res, next) { next(); }
function requireAdmin(req, res, next) { next(); }

// ==== ОСНОВНЫЕ РОУТЫ ====
app.post('/save/:title', requireAuth, async (req, res) => {
    try {
        const title = req.params.title;
        const content = req.body.content;

        // 1. Сохраняем в GitHub (если подключен)
        await saveArticleToGitHub(title, content);

        // 2. Сохраняем в локальную базу
        const existingArticle = await db.getAsync('SELECT * FROM articles WHERE title = ?', [title]);
        if (existingArticle) {
            await db.runAsync(
                'UPDATE articles SET content = ?, updated_at = CURRENT_TIMESTAMP WHERE title = ?',
                [content, title]
            );
        } else {
            await db.runAsync(
                'INSERT INTO articles (title, content) VALUES (?, ?)',
                [title, content]
            );
        }

        // 3. Сохраняем в локальную папку
        await backupArticle(title, content);

        res.redirect(`/article/${title}`);
    } catch (error) {
        console.error('Ошибка сохранения:', error);
        res.status(500).send('Ошибка при сохранении статьи');
    }
});

app.post('/create', async (req, res) => {
    try {
        const { title, content } = req.body;
        console.log('Создание статьи:', title);
        if (!title) { return res.send('Введите название статьи'); }
        const articleContent = content || '# ' + title;
        
        // 1. Сохраняем в GitHub
        await saveArticleToGitHub(title, articleContent);
        
        // 2. Сохраняем в локальную базу
        await db.runAsync('INSERT INTO articles (title, content) VALUES (?, ?)', [title, articleContent]);
        
        // 3. Сохраняем в локальную папку
        await backupArticle(title, articleContent);
        
        console.log('✅ Статья создана и сохранена:', title);
        res.redirect(`/article/${title}`);
    } catch (error) {
        console.error('Ошибка создания:', error);
        res.send('Ошибка: ' + error.message);
    }
});

// ==== ВСЕ ОСТАЛЬНЫЕ РОУТЫ ====
app.get('/search', async (req, res) => {
    try {
        const query = req.query.q;
        if (!query) { return res.render('search', { results: [], query: '', user: req.session.user }); }
        const results = await db.allAsync(`SELECT a.* FROM articles a WHERE a.content LIKE ? OR a.title LIKE ? ORDER BY a.updated_at DESC`, [`%${query}%`, `%${query}%`]);
        res.render('search', { results: results, query: query, user: req.session.user });
    } catch (error) {
        console.error('Ошибка поиска:', error); res.status(500).send('Ошибка при поиске');
    }
});

app.post('/comment/:articleId', requireAuth, async (req, res) => {
    try {
        const articleId = req.params.articleId;
        const { content, articleTitle } = req.body;
        await db.runAsync(`CREATE TABLE IF NOT EXISTS comments ( id INTEGER PRIMARY KEY AUTOINCREMENT, article_id INTEGER NOT NULL, content TEXT NOT NULL, created_at DATETIME DEFAULT CURRENT_TIMESTAMP )`);
        await db.runAsync('INSERT INTO comments (article_id, content) VALUES (?, ?)', [articleId, content]);
        res.redirect(`/article/${articleTitle}`);
    } catch (error) {
        console.error('Ошибка при добавлении комментария:', error); res.status(500).send('Ошибка при добавлении комментария');
    }
});

app.get('/article/:title/comments', async (req, res) => {
    try {
        const title = req.params.title;
        const article = await db.getAsync('SELECT id FROM articles WHERE title = ?', [title]);
        if (!article) { return res.status(404).send('Статья не найдена'); }
        const comments = await db.allAsync('SELECT * FROM comments WHERE article_id = ? ORDER BY created_at DESC', [article.id]);
        res.json(comments);
    } catch (error) {
        console.error('Ошибка:', error); res.status(500).json({ error: 'Ошибка при загрузке комментариев' });
    }
});

app.get('/export/pdf/:title', async (req, res) => {
    try {
        const title = req.params.title;
        const article = await db.getAsync('SELECT a.* FROM articles a WHERE a.title = ?', [title]);
        if (!article) { return res.status(404).send('Статья не найдена'); }
        const doc = new PDFDocument();
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="${title}.pdf"`);
        doc.pipe(res);
        doc.fontSize(20).text(article.title, 100, 100);
        doc.fontSize(12).text(`Обновлено: ${new Date(article.updated_at).toLocaleDateString()}`, 100, 130);
        doc.moveDown(2);
        const plainContent = article.content.replace(/^#+/gm, '');
        doc.fontSize(12).text(plainContent, 100, 200, { align: 'justify' });
        doc.end();
    } catch (error) {
        console.error('Ошибка экспорта:', error); res.status(500).send('Ошибка при экспорте в PDF');
    }
});

async function getAllArticles() {
    try {
        const articles = await db.allAsync('SELECT title FROM articles ORDER BY updated_at DESC');
        return articles.map(article => article.title);
    } catch (error) {
        console.log('Ошибка получения статей:', error); return [];
    }
}

app.get('/', async (req, res) => {
    try {
        const articles = await getAllArticles();
        const recentArticles = await db.allAsync(`SELECT a.* FROM articles a ORDER BY a.updated_at DESC LIMIT 10`);
        const popularArticles = await db.allAsync(`SELECT a.* FROM articles a ORDER BY a.updated_at DESC LIMIT 5`);
        const randomArticleData = await getTodaysRandomArticle();
        let randomArticle = null;
        if (randomArticleData) {
            randomArticle = { title: randomArticleData.title, content: randomArticleData.content.substring(0, 150) + '...' };
        }
        res.render('index', { articles: articles, recentArticles: recentArticles, popularArticles: popularArticles, randomArticle: randomArticle, user: req.session.user });
    } catch (error) {
        console.error('Ошибка главной страницы:', error);
        res.render('index', { articles: [], recentArticles: [], popularArticles: [], randomArticle: null, user: req.session.user });
    }
});

app.get('/article/:title', async (req, res) => {
    try {
        const title = req.params.title;
        const article = await db.getAsync('SELECT * FROM articles WHERE title = ?', [title]);
        if (article) {
            const content = marked(article.content);
            return res.render('article', { title: article.title, content: content, article: article, user: req.session.user });
        }
        res.status(404).render('article', { title: 'Статья не найдена', content: '<p>Запрошенная статья не существует.</p><p><a href="/">Вернуться на главную</a></p><p><a href="/create">Создать эту статью</a></p>', user: req.session.user });
    } catch (error) {
        console.error('Ошибка загрузки статьи:', error); res.status(500).send('Ошибка при загрузке статьи');
    }
});

app.get('/edit/:title', requireAuth, async (req, res) => {
    try {
        const title = req.params.title;
        const article = await db.getAsync('SELECT * FROM articles WHERE title = ?', [title]);
        let content = '';
        if (article) { content = article.content; } else { content = '# ' + title + '\n\nНачните писать вашу статью здесь...'; }
        res.render('edit', { title: title, content: content, user: req.session.user });
    } catch (error) {
        console.error('Ошибка:', error); res.status(500).send('Ошибка при загрузке редактора');
    }
});

app.post('/delete/:title', requireAdmin, async (req, res) => {
    try {
        const title = req.params.title;
        const article = await db.getAsync('SELECT id FROM articles WHERE title = ?', [title]);
        if (article) { await db.runAsync('DELETE FROM articles WHERE id = ?', [article.id]); }
        res.redirect('/');
    } catch (error) {
        console.error('Ошибка удаления статьи:', error); res.status(500).send('Ошибка при удалении статьи');
    }
});

app.get('/admin-panel', async (req, res) => {
    if (req.session.user !== 'admin') { return res.redirect('/admin'); }
    try {
        const articles = await db.allAsync('SELECT * FROM articles ORDER BY updated_at DESC');
        res.render('admin-panel', { articles: articles, user: req.session.user });
    } catch (error) {
        console.error('Ошибка админки:', error); res.status(500).send('Ошибка загрузки админки');
    }
});

app.get('/create', requireAuth, (req, res) => {
    res.render('create', { user: req.session.user });
});

app.get('/admin', (req, res) => {
    res.send(`
        <!DOCTYPE html>
        <html>
        <head><title>Вход админа</title></head>
        <body>
            <h2>Вход для админа</h2>
            <form method="POST" action="/admin-login">
                <input type="password" name="password" placeholder="Пароль админа" required>
                <button>Войти</button>
            </form>
            <p>Пароль: щура123</p>
        </body>
        </html>
    `);
});

app.post('/admin-login', (req, res) => {
    const { password } = req.body;
    console.log('🔐 Попытка входа:', password);
    if (password === 'щура123') {
        req.session.user = 'admin';
        console.log('✅ Успешный вход!');
        res.redirect('/');
    } else {
        console.log('❌ Неверный пароль');
        res.send('Неверный пароль! Попробуй: щура123');
    }
});

app.post('/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/');
});

app.post('/reset-database', async (req, res) => {
    try {
        db.close();
        await fs.unlink('./wiki.db').catch(() => {});
        await fs.unlink('./sessions.db').catch(() => {});
        console.log('🗑️ База данных удалена');
        res.send('База данных удалена. Перезапусти сервер.');
    } catch (error) {
        console.error('Ошибка сброса:', error);
        res.send('Ошибка: ' + error.message);
    }
});

// ==== ЗАПУСК СЕРВЕРА ====
app.listen(PORT, () => {
    console.log(`🚀 Щуропедия запущена на порту ${PORT}`);
    console.log('🌐 Хранилище статей: GitHub + локальная база');
});