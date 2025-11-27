const express = require('express');
const fs = require('fs').promises;
const path = require('path');
const { marked } = require('marked');
const bcrypt = require('bcryptjs');
const session = require('express-session');
const sqlite3 = require('sqlite3').verbose();

const app = express();
const PORT = 3000;

// Инициализация базы данных
const db = new sqlite3.Database('./wiki.db', (err) => {
    if (err) {
        console.error('Ошибка подключения к БД:', err);
    } else {
        console.log('Подключен к SQLite базе данных');
        initDatabase();
    }
});

function initDatabase() {
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
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(author_id) REFERENCES users(id)
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS article_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        article_id INTEGER,
        content TEXT NOT NULL,
        author_id INTEGER,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(article_id) REFERENCES articles(id),
        FOREIGN KEY(author_id) REFERENCES users(id)
    )`);
}

app.use(express.static('public'));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(session({
    secret: 'wiki-secret-key',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 24 * 60 * 60 * 1000 }
}));

app.set('views', path.join(__dirname, 'views'));
app.set('view engine', 'ejs');

function requireAuth(req, res, next) {
    if (req.session.user) {
        next();
    } else {
        res.redirect('/login');
    }
}

// Проверка админских прав
function requireAdmin(req, res, next) {
    if (req.session.user === 'admin' || req.session.user === 'щура') {
        next();
    } else {
        res.status(403).send('Доступ запрещен. Требуются права администратора.');
    }
}

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

// Создание демо-статей
async function createDemoArticles() {
    const demoArticles = [
        {
            title: 'Главная',
            content: '# Добро пожаловать в Щуропедию!\n\n' +
                     'Это главная страница Щуропедии.\n\n' +
                     '## Возможности\n\n' +
                     '- Создание статей\n' +
                     '- Редактирование статей\n' +
                     '- История изменений\n' +
                     '- Поиск по статьям\n\n' +
                     '## Быстрый старт\n\n' +
                     '[Создайте свою первую статью!](/create)'
        },
        {
            title: 'Дядя Щура',
            content: '# Дядя Щура\n\n' +
                     '**Дядя Щура** (легендарный 1488 вв. до н.э.) — великий волхв и духовный учитель.\n\n' +
                     '## Биография\n\n' +
                     '### Ранние годы\n' +
                     'Согласно древним преданиям, Дядя Щура родился в семье жрецов в регионе Восточной Скифии.\n\n' +
                     '### Духовное пробуждение\n' +
                     'В возрасте 30 лет пережил великое откровение, после которого начал проповедовать новое учение.'
        }
    ];

    for (const article of demoArticles) {
        try {
            await db.runAsync(
                'INSERT OR IGNORE INTO articles (title, content, author_id) VALUES (?, ?, ?)',
                [article.title, article.content, 1]
            );
            console.log('Создана статья:', article.title);
        } catch (error) {
            console.log('Ошибка создания статьи:', article.title, error);
        }
    }
}

// Функция для получения статей (только из БД)
async function getArticles() {
    try {
        const articles = await db.allAsync(
            'SELECT title, articles.created_at, articles.updated_at, username FROM articles LEFT JOIN users ON articles.author_id = users.id ORDER BY articles.updated_at DESC'
        );
        
        if (articles && articles.length > 0) {
            return articles.map(article => article.title);
        }
        
        // Если в БД нет статей, создаем демо-статьи
        console.log('Создаем демо-статьи...');
        await createDemoArticles();
        
        // Пробуем снова
        const newArticles = await db.allAsync('SELECT title FROM articles ORDER BY created_at DESC');
        return newArticles.map(article => article.title);
        
    } catch (error) {
        console.log('Ошибка получения статей:', error);
        return ['Главная', 'Дядя Щура', 'Щуризм'];
    }
}

// Главная страница
app.get('/', async (req, res) => {
    try {
        const articles = await getArticles();
        res.render('index', { 
            articles: articles,
            user: req.session.user 
        });
    } catch (error) {
        console.error('Ошибка главной страницы:', error);
        res.render('index', { 
            articles: ['Главная', 'Дядя Щура', 'Щуризм'],
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
            await db.runAsync(
                'INSERT INTO article_history (article_id, content, author_id) VALUES (?, ?, ?)',
                [existingArticle.id, existingArticle.content, user.id]
            );
            
            await db.runAsync(
                'UPDATE articles SET content = ?, author_id = ?, updated_at = CURRENT_TIMESTAMP WHERE title = ?',
                [content, user.id, title]
            );
        } else {
            await db.runAsync(
                'INSERT INTO articles (title, content, author_id) VALUES (?, ?, ?)',
                [title, content, user.id]
            );
            
            const newArticle = await db.getAsync('SELECT * FROM articles WHERE title = ?', [title]);
            
            await db.runAsync(
                'INSERT INTO article_history (article_id, content, author_id) VALUES (?, ?, ?)',
                [newArticle.id, content, user.id]
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
        await db.runAsync(
            'INSERT INTO article_history (article_id, content, author_id) VALUES (?, ?, ?)',
            [history.article_id, currentArticle.content, user.id]
        );

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
        const safeTitle = title.toLowerCase().replace(/[^a-z0-9а-яё\-]/g, '-');
        const existing = await db.getAsync('SELECT id FROM articles WHERE title = ?', [safeTitle]);
        if (existing) {
            return res.render('create', { 
                error: 'Статья с таким названием уже существует',
                user: req.session.user
            });
        }

        const result = await db.runAsync(
            'INSERT INTO articles (title, content, author_id) VALUES (?, ?, ?)',
            [safeTitle, content, user.id]
        );

        await db.runAsync(
            'INSERT INTO article_history (article_id, content, author_id) VALUES (?, ?, ?)',
            [result.id, content, user.id]
        );

        res.redirect(`/article/${safeTitle}`);
    } catch (error) {
        console.error('Ошибка:', error);
        res.status(500).send('Ошибка при создании статьи');
    }
});

// Регистрация
app.get('/register', (req, res) => {
    res.render('register', { user: req.session.user });
});

app.post('/register', async (req, res) => {
    try {
        const { username, password } = req.body;

        const existing = await db.getAsync('SELECT id FROM users WHERE username = ?', [username]);
        if (existing) {
            return res.render('register', { 
                error: 'Пользователь уже существует',
                user: req.session.user
            });
        }

        const hashedPassword = await bcrypt.hash(password, 10);
        await db.runAsync(
            'INSERT INTO users (username, password) VALUES (?, ?)',
            [username, hashedPassword]
        );

        req.session.user = username;
        res.redirect('/');
    } catch (error) {
        console.error('Ошибка:', error);
        res.status(500).send('Ошибка при регистрации');
    }
});

// Логин
app.get('/login', (req, res) => {
    res.render('login', { user: req.session.user });
});

app.post('/login', async (req, res) => {
    try {
        const { username, password } = req.body;

        const user = await db.getAsync('SELECT * FROM users WHERE username = ?', [username]);
        if (!user || !(await bcrypt.compare(password, user.password))) {
            return res.render('login', { 
                error: 'Неверное имя пользователя или пароль',
                user: req.session.user
            });
        }

        req.session.user = username;
        res.redirect('/');
    } catch (error) {
        console.error('Ошибка:', error);
        res.status(500).send('Ошибка при входе');
    }
});

// Выход
app.post('/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/');
});

// Запуск сервера
app.listen(PORT, () => {
    console.log('Щуропедия запущена на http://localhost:' + PORT);
    console.log('Используется SQLite база данных');
});