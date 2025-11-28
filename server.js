const express = require('express');
const fs = require('fs').promises;
const path = require('path');
const { marked } = require('marked');
const bcrypt = require('bcryptjs');
const sqlite3 = require('sqlite3').verbose();
const PDFDocument = require('pdfkit');
const session = require('express-session');
const SQLiteStore = require('connect-sqlite3')(session);

const app = express();
const PORT = process.env.PORT || 3000;

// Инициализация базы данных
const db = new sqlite3.Database(path.join(__dirname, 'wiki.db'), (err) => {
    if (err) {
        console.error('Ошибка подключения к БД:', err);
    } else {
        console.log('✅ Подключен к SQLite базе данных');
        initDatabase();
    }
});

function initDatabase() {
    console.log('Создаем базовые таблицы...');
    db.run(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE NOT NULL,
        password TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    
    db.run(`CREATE TABLE IF NOT EXISTS articles (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT UNIQUE NOT NULL,
        content TEXT NOT NULL,
        author_id INTEGER,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    
    console.log('✅ База инициализирована');
}


// Middleware с 30-дневной сессией
app.use(express.static('public'));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(session({
    store: new SQLiteStore({
        db: 'sessions.db',
        dir: './'
    }),
    secret: process.env.SESSION_SECRET || 'wiki-secret-key-2024',
    resave: false,
    saveUninitialized: false,
    cookie: { 
        secure: process.env.NODE_ENV === 'production',
        maxAge: 30 * 24 * 60 * 60 * 1000 // 30 ДНЕЙ!
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
    if (req.session.user === 'admin') {
        next();
    } else {
        res.redirect('/admin');
    }
}

function requireAdmin(req, res, next) {
    if (req.session.user === 'admin') {
        next();
    } else {
        res.status(403).send('Доступ запрещен');
    }
}

// ПОИСК ПО СОДЕРЖИМОМУ
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
            `SELECT a.*, u.username, 
                    (SELECT GROUP_CONCAT(c.name) 
                     FROM article_categories ac 
                     JOIN categories c ON ac.category_id = c.id 
                     WHERE ac.article_id = a.id) as categories
             FROM articles a 
             LEFT JOIN users u ON a.author_id = u.id 
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

// КАТЕГОРИИ
app.get('/categories', async (req, res) => {
    try {
        const categories = await db.allAsync(`
            SELECT c.*, COUNT(ac.article_id) as articles_count
            FROM categories c
            LEFT JOIN article_categories ac ON c.id = ac.category_id
            GROUP BY c.id
            ORDER BY articles_count DESC
        `);

        res.render('categories', {
            categories: categories,
            user: req.session.user
        });
    } catch (error) {
        console.error('Ошибка:', error);
        res.status(500).send('Ошибка при загрузке категорий');
    }
});

app.get('/category/:name', async (req, res) => {
    try {
        const categoryName = req.params.name;
        const articles = await db.allAsync(`
            SELECT a.*, u.username
            FROM articles a
            JOIN article_categories ac ON a.id = ac.article_id
            JOIN categories c ON ac.category_id = c.id
            LEFT JOIN users u ON a.author_id = u.id
            WHERE c.name = ?
            ORDER BY a.updated_at DESC
        `, [categoryName]);

        res.render('category', {
            category: categoryName,
            articles: articles,
            user: req.session.user
        });
    } catch (error) {
        console.error('Ошибка:', error);
        res.status(500).send('Ошибка при загрузке категории');
    }
});

// КОММЕНТАРИИ
app.post('/comment/:articleId', requireAuth, async (req, res) => {
    try {
        const articleId = req.params.articleId;
        const { content } = req.body;
        const user = await db.getAsync('SELECT id FROM users WHERE username = ?', [req.session.user]);

        await db.runAsync(
            'INSERT INTO comments (article_id, user_id, content) VALUES (?, ?, ?)',
            [articleId, user.id, content]
        );

        res.redirect(`/article/${req.body.articleTitle}`);
    } catch (error) {
        console.error('Ошибка:', error);
        res.status(500).send('Ошибка при добавлении комментария');
    }
});

// ИЗБРАННОЕ
app.post('/favorite/:articleId', requireAuth, async (req, res) => {
    try {
        const articleId = req.params.articleId;
        const user = await db.getAsync('SELECT id FROM users WHERE username = ?', [req.session.user]);

        // Проверяем нет ли уже в избранном
        const existing = await db.getAsync(
            'SELECT id FROM favorites WHERE user_id = ? AND article_id = ?',
            [user.id, articleId]
        );

        if (existing) {
            // Удаляем из избранного
            await db.runAsync(
                'DELETE FROM favorites WHERE user_id = ? AND article_id = ?',
                [user.id, articleId]
            );
        } else {
            // Добавляем в избранное
            await db.runAsync(
                'INSERT INTO favorites (user_id, article_id) VALUES (?, ?)',
                [user.id, articleId]
            );
        }

        res.json({ success: true });
    } catch (error) {
        console.error('Ошибка:', error);
        res.status(500).json({ success: false, error: 'Ошибка при изменении избранного' });
    }
});

// ФЛАГИ/ЖАЛОБЫ
app.post('/flag/:articleId', requireAuth, async (req, res) => {
    try {
        const articleId = req.params.articleId;
        const { reason } = req.body;
        const user = await db.getAsync('SELECT id FROM users WHERE username = ?', [req.session.user]);

        await db.runAsync(
            'INSERT INTO flags (article_id, user_id, reason) VALUES (?, ?, ?)',
            [articleId, user.id, reason]
        );

        res.redirect(`/article/${req.body.articleTitle}?flagged=true`);
    } catch (error) {
        console.error('Ошибка:', error);
        res.status(500).send('Ошибка при отправке жалобы');
    }
});

// ЭКСПОРТ В PDF
app.get('/export/pdf/:title', async (req, res) => {
    try {
        const title = req.params.title;
        const article = await db.getAsync(
            'SELECT a.*, u.username FROM articles a LEFT JOIN users u ON a.author_id = u.id WHERE a.title = ?',
            [title]
        );

        if (!article) {
            return res.status(404).send('Статья не найдена');
        }

        const doc = new PDFDocument();
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="${title}.pdf"`);

        doc.pipe(res);

        // Заголовок
        doc.fontSize(20).text(article.title, 100, 100);
        doc.fontSize(12).text(`Автор: ${article.username}`, 100, 130);
        doc.fontSize(12).text(`Обновлено: ${new Date(article.updated_at).toLocaleDateString()}`, 100, 150);
        
        // Содержание
        doc.moveDown(2);
        const content = article.content.replace(/^#+/gm, ''); // Убираем markdown заголовки
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

// ГЛАВНАЯ СТРАНИЦА - УПРОЩЕННАЯ ВЕРСИЯ
app.get('/', async (req, res) => {
    try {
        // Получаем все статьи для списка
        const articles = await getAllArticles();
        
        // Получаем последние статьи для блока "Недавние правки"
        const recentArticles = await db.allAsync(`
            SELECT a.*, u.username 
            FROM articles a 
            LEFT JOIN users u ON a.author_id = u.id 
            ORDER BY a.updated_at DESC 
            LIMIT 10
        `);

        // Получаем популярные статьи (по просмотрам)
        const popularArticles = await db.allAsync(`
            SELECT a.*, u.username 
            FROM articles a 
            LEFT JOIN users u ON a.author_id = u.id 
            ORDER BY a.views DESC 
            LIMIT 5
        `);

        // Получаем случайную статью
        const randomArticle = await db.getAsync(`
            SELECT a.*, u.username 
            FROM articles a 
            LEFT JOIN users u ON a.author_id = u.id 
            ORDER BY RANDOM() 
            LIMIT 1
        `);

        res.render('index', {
            articles: articles,
            recentArticles: recentArticles,
            popularArticles: popularArticles,
            randomArticle: randomArticle,
            user: req.session.user
        });
    } catch (error) {
        console.error('Ошибка главной страницы:', error);
        // В случае ошибки показываем пустую главную страницу
        res.render('index', {
            articles: [],
            recentArticles: [],
            popularArticles: [],
            randomArticle: null,
            user: req.session.user
        });
    }
});

// Страница статьи
app.get('/article/:title', async (req, res) => {
    try {
        const title = req.params.title;
        console.log('Загрузка статьи:', title);
        
        // Ищем статью в БД
        const article = await db.getAsync(
            'SELECT articles.*, users.username FROM articles LEFT JOIN users ON articles.author_id = users.id WHERE articles.title = ?',
            [title]
        );

        if (article) {
            console.log('Статья найдена в БД');
            
            // Увеличиваем счетчик просмотров
            await db.runAsync(
                'UPDATE articles SET views = views + 1 WHERE id = ?',
                [article.id]
            );
            
            const content = marked(article.content);
            return res.render('article', { 
                title: article.title, 
                content: content,
                article: article,
                user: req.session.user
            });
        }

        // Если статья не найдена
        console.log('Статья не найдена:', title);
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
        const user = await db.getAsync('SELECT id FROM users WHERE username = ?', [req.session.user]);

        const existingArticle = await db.getAsync('SELECT * FROM articles WHERE title = ?', [title]);
        
        if (existingArticle) {
            // Сохраняем в историю предыдущую версию
            await db.runAsync(
                'INSERT INTO article_history (article_id, content, author_id) VALUES (?, ?, ?)',
                [existingArticle.id, existingArticle.content, user.id]
            );
            
            // Обновляем статью
            await db.runAsync(
                'UPDATE articles SET content = ?, author_id = ?, updated_at = CURRENT_TIMESTAMP WHERE title = ?',
                [content, user.id, title]
            );
        } else {
            // Создаем новую статью
            const result = await db.runAsync(
                'INSERT INTO articles (title, content, author_id) VALUES (?, ?, ?)',
                [title, content, user.id]
            );
            
            // Сохраняем в историю
            await db.runAsync(
                'INSERT INTO article_history (article_id, content, author_id) VALUES (?, ?, ?)',
                [result.id, content, user.id]
            );
        }

        res.redirect(`/article/${title}`);
    } catch (error) {
        console.error('Ошибка:', error);
        res.status(500).send('Ошибка при сохранении статьи');
    }
});

// История статьи
app.get('/history/:title', async (req, res) => {
    try {
        const title = req.params.title;
        const article = await db.getAsync('SELECT * FROM articles WHERE title = ?', [title]);
        
        if (!article) {
            return res.status(404).send('Статья не найдена');
        }

        const history = await db.allAsync(
            'SELECT article_history.*, users.username FROM article_history LEFT JOIN users ON article_history.author_id = users.id WHERE article_history.article_id = ? ORDER BY article_history.created_at DESC',
            [article.id]
        );

        res.render('history', {
            title: title,
            history: history,
            user: req.session.user
        });
    } catch (error) {
        console.error('Ошибка:', error);
        res.status(500).send('Ошибка при загрузке истории');
    }
});

// Восстановление версии
app.post('/restore/:history_id', requireAuth, async (req, res) => {
    try {
        const historyId = req.params.history_id;
        
        const history = await db.getAsync(
            'SELECT article_history.*, articles.title FROM article_history JOIN articles ON article_history.article_id = articles.id WHERE article_history.id = ?',
            [historyId]
        );

        if (!history) {
            return res.status(404).send('Версия не найдена');
        }

        const user = await db.getAsync('SELECT id FROM users WHERE username = ?', [req.session.user]);
        const currentArticle = await db.getAsync('SELECT * FROM articles WHERE id = ?', [history.article_id]);
        
        // Сохраняем текущую версию в историю
        await db.runAsync(
            'INSERT INTO article_history (article_id, content, author_id) VALUES (?, ?, ?)',
            [history.article_id, currentArticle.content, user.id]
        );

        // Восстанавливаем старую версию
        await db.runAsync(
            'UPDATE articles SET content = ?, author_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
            [history.content, user.id, history.article_id]
        );

        res.redirect(`/article/${history.title}`);
    } catch (error) {
        console.error('Ошибка:', error);
        res.status(500).send('Ошибка при восстановлении версии');
    }
});

// Удаление статьи
app.post('/delete/:title', requireAdmin, async (req, res) => {
    try {
        const title = req.params.title;
        
        // Удаляем статью и её историю
        const article = await db.getAsync('SELECT id FROM articles WHERE title = ?', [title]);
        if (article) {
            await db.runAsync('DELETE FROM article_history WHERE article_id = ?', [article.id]);
            await db.runAsync('DELETE FROM articles WHERE id = ?', [article.id]);
        }
        
        res.redirect('/');
    } catch (error) {
        console.error('Ошибка удаления статьи:', error);
        res.status(500).send('Ошибка при удалении статьи');
    }
});

// Панель администратора
app.get('/admin', requireAdmin, async (req, res) => {
    try {
        const articles = await db.allAsync(
            'SELECT articles.*, users.username, (SELECT COUNT(*) FROM article_history WHERE article_id = articles.id) as history_count FROM articles LEFT JOIN users ON articles.author_id = users.id ORDER BY articles.updated_at DESC'
        );
        
        const users = await db.allAsync('SELECT * FROM users ORDER BY created_at DESC');
        
        res.render('admin', {
            articles: articles,
            users: users,
            user: req.session.user
        });
    } catch (error) {
        console.error('Ошибка загрузки админки:', error);
        res.status(500).send('Ошибка при загрузке панели администратора');
    }
});

// Создание новой статьи
app.get('/create', requireAuth, (req, res) => {
    res.render('create', { user: req.session.user });
});

app.post('/create', requireAuth, async (req, res) => {
    try {
        const title = req.body.title;
        const content = req.body.content || '# ' + title + '\n\nНачните писать вашу статью здесь...';
        const user = await db.getAsync('SELECT id FROM users WHERE username = ?', [req.session.user]);
        
        // Проверяем существование статьи
        const existing = await db.getAsync('SELECT id FROM articles WHERE title = ?', [title]);
        if (existing) {
            return res.render('create', { 
                error: 'Статья с таким названием уже существует',
                user: req.session.user
            });
        }

        // Создаем статью
        const result = await db.runAsync(
            'INSERT INTO articles (title, content, author_id) VALUES (?, ?, ?)',
            [title, content, user.id]
        );

        // Сохраняем в историю
        await db.runAsync(
            'INSERT INTO article_history (article_id, content, author_id) VALUES (?, ?, ?)',
            [result.id, content, user.id]
        );

        res.redirect(`/article/${title}`);
    } catch (error) {
        console.error('Ошибка:', error);
        res.status(500).send('Ошибка при создании статьи');
    }
});

// Простой вход для админа
app.post('/admin-login', (req, res) => {
    const { password } = req.body;
    
    if (password === 'щура123') { // любой простой пароль
        req.session.user = 'admin';
        res.redirect('/');
    } else {
        res.send('Неверный пароль');
    }
});

// Простая форма входа (добавь в главную страницу)
app.get('/admin', (req, res) => {
    res.send(`
        <form method="POST" action="/admin-login">
            <input type="password" name="password" placeholder="Пароль админа">
            <button>Войти</button>
        </form>
    `);
});

// Запуск сервера
app.listen(PORT, () => {
    console.log('Щуропедия запущена на http://localhost:' + PORT);
    console.log('Используется SQLite база данных');
    console.log('Приложение готово к созданию статей пользователями');
});

