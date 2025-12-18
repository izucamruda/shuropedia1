const express = require('express');
const fs = require('fs').promises;
const path = require('path');
const { marked } = require('marked');
const sqlite3 = require('sqlite3').verbose();
const PDFDocument = require('pdfkit');
const session = require('express-session');

const app = express();
const PORT = process.env.PORT || 3000;

const ARTICLES_BACKUP_DIR = './articles_backup';
let currentRandomArticle = null;
let lastRandomUpdate = null;

// Сохраняем статью в бэкап
async function backupArticle(title, content) {
    try {
        const filename = `${title.replace(/[^a-z0-9а-яё]/gi, '_')}.md`;
        const filepath = path.join(ARTICLES_BACKUP_DIR, filename);
        await fs.writeFile(filepath, content, 'utf8');
        console.log('💾 Статья сохранена в бэкап:', filename);
    } catch (error) {
        console.error('❌ Ошибка бэкапа:', error);
    }
}

// Восстанавливаем статьи из бэкапа при запуске
async function restoreFromBackup() {
    try {
        const files = await fs.readdir(ARTICLES_BACKUP_DIR);
        console.log(`📁 Найдено файлов в бэкапе: ${files.length}`);
        
        let restoredCount = 0;
        
        for (const file of files) {
            if (file.endsWith('.md')) {
                const filepath = path.join(ARTICLES_BACKUP_DIR, file);
                const content = await fs.readFile(filepath, 'utf8');
                const title = file.replace('.md', '').replace(/_/g, ' ');
                
                console.log(`🔍 Проверяем статью: "${title}"`);
                
                // Проверяем есть ли статья в БД
                const existing = await db.getAsync('SELECT id FROM articles WHERE title = ?', [title]);
                
                if (!existing) {
                    console.log(`➕ Добавляем статью: "${title}"`);
                    await db.runAsync(
                        'INSERT OR IGNORE INTO articles (title, content) VALUES (?, ?)',
                        [title, content]
                    );
                    restoredCount++;
                } else {
                    console.log(`⏩ Статья уже существует: "${title}"`);
                }
            }
        }
        console.log(`✅ Восстановлено статей из бэкапа: ${restoredCount}`);
    } catch (error) {
        console.error('❌ Ошибка восстановления:', error);
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
        
        currentRandomArticle = {
            title: title,
            content: content,
            filename: randomFile,
            selectedDate: today
        };
        lastRandomUpdate = today;
        
        console.log(`✅ Случайная статья на сегодня: "${title}"`);
        return currentRandomArticle;
        
    } catch (error) {
        console.error('❌ Ошибка при выборе случайной статьи:', error);
        return null;
    }
}

// Инициализация базы данных
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
    
    await restoreFromBackup();
}

// Middleware
app.use(express.static('public'));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(session({
    secret: 'wiki-secret-key-2024',
    resave: false,
    saveUninitialized: false,
    cookie: { 
        secure: false,
        maxAge: 7 * 24 * 60 * 60 * 1000
    }
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

function requireAuth(req, res, next) {
    next();
}

function requireAdmin(req, res, next) {
    next();
}

// ПОИСК ПО СОДЕРЖИМОМУ - ИСПРАВЛЕННЫЙ
app.get('/search', async (req, res) => {
    try {
        const query = req.query.q;
        if (!query) {
            return res.render('search', { 
                results: [], 
                query: '', 
                user: req.session.user 
            });
        }

        const results = await db.allAsync(
            `SELECT a.* 
             FROM articles a 
             WHERE a.content LIKE ? OR a.title LIKE ?
             ORDER BY a.updated_at DESC`,
            [`%${query}%`, `%${query}%`]
        );

        res.render('search', { 
            results: results, 
            query: query, 
            user: req.session.user 
        });
    } catch (error) {
        console.error('Ошибка поиска:', error);
        res.status(500).send('Ошибка при поиске');
    }
});

// КОММЕНТАРИИ (упрощенная версия)
app.post('/comment/:articleId', requireAuth, async (req, res) => {
    try {
        const articleId = req.params.articleId;
        const { content, articleTitle } = req.body;
        
        // Создаем таблицу comments если её нет
        await db.runAsync(`
            CREATE TABLE IF NOT EXISTS comments (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                article_id INTEGER NOT NULL,
                content TEXT NOT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `);
        
        // Добавляем комментарий
        await db.runAsync(
            'INSERT INTO comments (article_id, content) VALUES (?, ?)',
            [articleId, content]
        );

        res.redirect(`/article/${articleTitle}`);
    } catch (error) {
        console.error('Ошибка при добавлении комментария:', error);
        res.status(500).send('Ошибка при добавлении комментария');
    }
});

// Показать комментарии для статьи
app.get('/article/:title/comments', async (req, res) => {
    try {
        const title = req.params.title;
        const article = await db.getAsync('SELECT id FROM articles WHERE title = ?', [title]);
        
        if (!article) {
            return res.status(404).send('Статья не найдена');
        }
        
        const comments = await db.allAsync(
            'SELECT * FROM comments WHERE article_id = ? ORDER BY created_at DESC',
            [article.id]
        );
        
        res.json(comments);
    } catch (error) {
        console.error('Ошибка:', error);
        res.status(500).json({ error: 'Ошибка при загрузке комментариев' });
    }
});

// ЭКСПОРТ В PDF - ИСПРАВЛЕННЫЙ
app.get('/export/pdf/:title', async (req, res) => {
    try {
        const title = req.params.title;
        const article = await db.getAsync(
            'SELECT a.* FROM articles a WHERE a.title = ?',
            [title]
        );

        if (!article) {
            return res.status(404).send('Статья не найдена');
        }

        const doc = new PDFDocument();
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="${title}.pdf"`);

        doc.pipe(res);
        doc.fontSize(20).text(article.title, 100, 100);
        doc.fontSize(12).text(`Обновлено: ${new Date(article.updated_at).toLocaleDateString()}`, 100, 130);
        
        doc.moveDown(2);
        const content = article.content.replace(/^#+/gm, '');
        doc.fontSize(12).text(content, 100, 200, { align: 'justify' });

        doc.end();
    } catch (error) {
        console.error('Ошибка экспорта:', error);
        res.status(500).send('Ошибка при экспорте в PDF');
    }
});

// Функция для получения всех статей
async function getAllArticles() {
    try {
        const articles = await db.allAsync(
            'SELECT title FROM articles ORDER BY updated_at DESC'
        );
        return articles.map(article => article.title);
    } catch (error) {
        console.log('Ошибка получения статей:', error);
        return [];
    }
}

// ГЛАВНАЯ СТРАНИЦА - ИСПРАВЛЕННАЯ
app.get('/', async (req, res) => {
    try {
        const articles = await getAllArticles();
        
        const recentArticles = await db.allAsync(`
            SELECT a.* 
            FROM articles a 
            ORDER BY a.updated_at DESC 
            LIMIT 10
        `);

        const popularArticles = await db.allAsync(`
            SELECT a.* 
            FROM articles a 
            ORDER BY a.updated_at DESC 
            LIMIT 5
        `);

        const randomArticleData = await getTodaysRandomArticle();
        let randomArticle = null;

        if (randomArticleData) {
            randomArticle = {
                title: randomArticleData.title,
                content: randomArticleData.content.substring(0, 150) + '...'
            };
        }

        res.render('index', {
            articles: articles,
            recentArticles: recentArticles,
            popularArticles: popularArticles,
            randomArticle: randomArticle,
            user: req.session.user
        });
    } catch (error) {
        console.error('Ошибка главной страницы:', error);
        res.render('index', {
            articles: [],
            recentArticles: [],
            popularArticles: [],
            randomArticle: null,
            user: req.session.user
        });
    }
});

// Страница статьи - ИСПРАВЛЕННАЯ
app.get('/article/:title', async (req, res) => {
    try {
        const title = req.params.title;
        
        const article = await db.getAsync(
            'SELECT * FROM articles WHERE title = ?',
            [title]
        );

        if (article) {
            const content = marked(article.content);
            return res.render('article', { 
                title: article.title, 
                content: content,
                article: article,
                user: req.session.user
            });
        }

        res.status(404).render('article', { 
            title: 'Статья не найдена', 
            content: '<p>Запрошенная статья не существует.</p><p><a href="/">Вернуться на главную</a></p><p><a href="/create">Создать эту статью</a></p>',
            user: req.session.user
        });

    } catch (error) {
        console.error('Ошибка загрузки статьи:', error);
        res.status(500).send('Ошибка при загрузке статьи');
    }
});

// Страница редактирования статьи
app.get('/edit/:title', requireAuth, async (req, res) => {
    try {
        const title = req.params.title;
        const article = await db.getAsync('SELECT * FROM articles WHERE title = ?', [title]);
        
        let content = '';
        if (article) {
            content = article.content;
        } else {
            content = '# ' + title + '\n\nНачните писать вашу статью здесь...';
        }

        res.render('edit', {
            title: title,
            content: content,
            user: req.session.user
        });
    } catch (error) {
        console.error('Ошибка:', error);
        res.status(500).send('Ошибка при загрузке редактора');
    }
});

// Сохранение статьи
app.post('/save/:title', requireAuth, async (req, res) => {
    try {
        const title = req.params.title;
        const content = req.body.content;

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

        await backupArticle(title, content);
        res.redirect(`/article/${title}`);
    } catch (error) {
        console.error('Ошибка:', error);
        res.status(500).send('Ошибка при сохранении статьи');
    }
});

// Удаление статьи
app.post('/delete/:title', requireAdmin, async (req, res) => {
    try {
        const title = req.params.title;
        
        const article = await db.getAsync('SELECT id FROM articles WHERE title = ?', [title]);
        if (article) {
            await db.runAsync('DELETE FROM articles WHERE id = ?', [article.id]);
        }
        
        res.redirect('/');
    } catch (error) {
        console.error('Ошибка удаления статьи:', error);
        res.status(500).send('Ошибка при удалении статьи');
    }
});

// Админ-панель
app.get('/admin-panel', async (req, res) => {
    if (req.session.user !== 'admin') {
        return res.redirect('/admin');
    }
    
    try {
        const articles = await db.allAsync('SELECT * FROM articles ORDER BY updated_at DESC');
        res.render('admin-panel', {
            articles: articles,
            user: req.session.user
        });
    } catch (error) {
        console.error('Ошибка админки:', error);
        res.status(500).send('Ошибка загрузки админки');
    }
});

// Создание новой статьи
app.get('/create', requireAuth, (req, res) => {
    res.render('create', { user: req.session.user });
});

app.post('/create', async (req, res) => {
    try {
        const { title, content } = req.body;
        console.log('Создание статьи:', title);
        
        if (!title) {
            return res.send('Введите название статьи');
        }

        const articleContent = content || '# ' + title;
        
        await db.runAsync(
            'INSERT INTO articles (title, content) VALUES (?, ?)',
            [title, articleContent]
        );

        await backupArticle(title, articleContent);
        console.log('✅ Статья создана и сохранена в бэкап:', title);
        res.redirect(`/article/${title}`);
        
    } catch (error) {
        console.error('Ошибка создания:', error);
        res.send('Ошибка: ' + error.message);
    }
});

// Админ вход
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

// Запуск сервера
app.listen(PORT, () => {
    console.log('Щуропедия запущена на http://localhost:' + PORT);
    console.log('Используется SQLite база данных');
    console.log('Приложение готово к созданию статей пользователями');
});