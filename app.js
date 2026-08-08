// =============================== app.js — более 2000 строк ===============================
// -----------------------------------------------------------------------------
// 1. ГЛОБАЛЬНОЕ СОСТОЯНИЕ
// -----------------------------------------------------------------------------
const STATE = {
  currentUser: null,               // { username, password, avatar? }
  currentPage: 'home',
  animeList: [],                  // все аниме с AniList
  selectedAnime: null,            // текущее открытое аниме
  selectedEpisode: 1,
  searchQuery: '',                // текущий поисковый запрос
  userLists: {},                  // { username: { favorites: [id], watched: [id], dropped: [id] } }
  avatars: {},                    // { username: base64 }
};

// -----------------------------------------------------------------------------
// 2. ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ
// -----------------------------------------------------------------------------
function $(sel) { return document.querySelector(sel); }
function $$(sel) { return document.querySelectorAll(sel); }

// Загрузка/сохранение в localStorage
function loadState() {
  try {
    const raw = localStorage.getItem('animeapp_state');
    if (raw) {
      const parsed = JSON.parse(raw);
      STATE.userLists = parsed.userLists || {};
      STATE.avatars = parsed.avatars || {};
      if (parsed.currentUser) STATE.currentUser = parsed.currentUser;
    }
  } catch (e) { console.warn('Ошибка загрузки состояния', e); }
}
function saveState() {
  try {
    localStorage.setItem('animeapp_state', JSON.stringify({
      userLists: STATE.userLists,
      avatars: STATE.avatars,
      currentUser: STATE.currentUser,
    }));
  } catch (e) { console.warn('Ошибка сохранения состояния', e); }
}

// Получить списки пользователя (создать если нет)
function getUserLists(username) {
  if (!STATE.userLists[username]) {
    STATE.userLists[username] = { favorites: [], watched: [], dropped: [] };
    saveState();
  }
  return STATE.userLists[username];
}

// Проверка, добавлено ли аниме в список
function isInList(username, animeId, listName) {
  const lists = getUserLists(username);
  return lists[listName]?.includes(animeId) || false;
}

// Добавить/удалить из списка (toggle)
function toggleList(username, animeId, listName) {
  const lists = getUserLists(username);
  const arr = lists[listName];
  if (!arr) return;
  const idx = arr.indexOf(animeId);
  if (idx > -1) arr.splice(idx, 1);
  else arr.push(animeId);
  saveState();
  renderCurrentPage(); // обновить UI
}

// -----------------------------------------------------------------------------
// 3. РАБОТА С ANILIST (GraphQL)
// -----------------------------------------------------------------------------
const ANILIST_API = 'https://graphql.anilist.co';

// Запрос на получение списка (с поиском)
async function fetchAnimeList(page = 1, perPage = 50, search = '') {
  const query = `
    query ($page: Int, $perPage: Int, $search: String) {
      Page(page: $page, perPage: $perPage) {
        media(sort: POPULARITY_DESC, type: ANIME, search: $search) {
          id
          title { romaji english native }
          coverImage { large medium }
          genres
          description
          episodes
          status
          averageScore
        }
        pageInfo { hasNextPage }
      }
    }
  `;
  const variables = { page, perPage, search: search || undefined };
  try {
    const resp = await fetch(ANILIST_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({ query, variables })
    });
    const json = await resp.json();
    if (json.errors) throw new Error(json.errors[0].message);
    return json.data.Page;
  } catch (e) {
    console.error('AniList API error:', e);
    throw e;
  }
}

// Получить одно аниме по ID
async function fetchAnimeById(id) {
  const query = `
    query ($id: Int) {
      Media(id: $id, type: ANIME) {
        id
        title { romaji english native }
        coverImage { large medium }
        genres
        description
        episodes
        status
        averageScore
        bannerImage
        trailer { site id }
      }
    }
  `;
  const resp = await fetch(ANILIST_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify({ query, variables: { id } })
  });
  const json = await resp.json();
  if (json.errors) throw new Error(json.errors[0].message);
  return json.data.Media;
}

// -----------------------------------------------------------------------------
// 4. ПОИСК ВИДЕО (Invidious) — для вкладки YouTube
// -----------------------------------------------------------------------------
async function searchVideo(query) {
  const API_URL = 'https://yewtu.be/api/v1/search';
  try {
    const resp = await fetch(`${API_URL}?q=${encodeURIComponent(query)}&type=video`);
    const data = await resp.json();
    if (data && data.length > 0) {
      return data[0].videoId;
    }
    return null;
  } catch (e) {
    console.error('Ошибка поиска видео:', e);
    return null;
  }
}

// -----------------------------------------------------------------------------
// 5. РЕНДЕРИНГ СТРАНИЦ
// -----------------------------------------------------------------------------
const container = $('#pageContainer');

// Очистить контейнер
function clearContainer() {
  container.innerHTML = '';
}

// Главная страница (список аниме)
async function renderHome() {
  clearContainer();
  // Показываем лоадер
  container.innerHTML = '<div class="loading">Загрузка аниме...</div>';
  try {
    const data = await fetchAnimeList(1, 50, STATE.searchQuery);
    STATE.animeList = data.media || [];
    renderAnimeGrid(STATE.animeList);
    // Обновить кнопку очистки поиска
    const clearBtn = $('#clearSearchBtn');
    if (STATE.searchQuery) {
      clearBtn.style.display = 'inline-block';
    } else {
      clearBtn.style.display = 'none';
    }
    // Обновить инпут
    const searchInput = $('#searchInput');
    if (searchInput) searchInput.value = STATE.searchQuery;
  } catch (e) {
    container.innerHTML = `<div class="loading">Ошибка загрузки: ${e.message}</div>`;
  }
}

// Рендер сетки аниме
function renderAnimeGrid(animes, targetContainer = null) {
  const target = targetContainer || container;
  if (!animes || animes.length === 0) {
    target.innerHTML = '<div class="loading">Ничего не найдено</div>';
    return;
  }
  let html = '<div class="grid">';
  for (const anime of animes) {
    const title = anime.title.romaji || anime.title.english || anime.title.native || 'Без названия';
    const img = anime.coverImage?.large || anime.coverImage?.medium || '';
    const id = anime.id;
    // проверка статусов для текущего пользователя
    let fav = false, watched = false, dropped = false;
    if (STATE.currentUser) {
      const lists = getUserLists(STATE.currentUser.username);
      fav = lists.favorites.includes(id);
      watched = lists.watched.includes(id);
      dropped = lists.dropped.includes(id);
    }
    html += `
      <div class="card card-enter" data-id="${id}">
        <img src="${img}" alt="${title}" loading="lazy" onerror="this.src='data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%22200%22 height=%22300%22/%3E'" />
        <div class="card-content">
          <div class="card-title">${title}</div>
          <div class="card-actions">
            <button class="fav ${fav ? 'active-status' : ''}" data-id="${id}" data-list="favorites">❤️</button>
            <button class="watched ${watched ? 'active-status' : ''}" data-id="${id}" data-list="watched">👁️</button>
            <button class="dropped ${dropped ? 'active-status' : ''}" data-id="${id}" data-list="dropped">🚫</button>
          </div>
        </div>
      </div>
    `;
  }
  html += '</div>';
  target.innerHTML = html;

  // Обработчики кликов на карточку (открыть детали)
  target.querySelectorAll('.card').forEach(card => {
    card.addEventListener('click', (e) => {
      if (e.target.closest('button')) return;
      const id = parseInt(card.dataset.id);
      openAnimeDetail(id);
    });
  });

  // Обработчики кнопок списков
  target.querySelectorAll('.card-actions button').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!STATE.currentUser) {
        alert('Войдите, чтобы добавлять в списки');
        return;
      }
      const id = parseInt(btn.dataset.id);
      const list = btn.dataset.list;
      toggleList(STATE.currentUser.username, id, list);
    });
  });
}

// Страница деталей аниме + плеер
async function openAnimeDetail(id) {
  clearContainer();
  container.innerHTML = '<div class="loading">Загрузка...</div>';
  try {
    const anime = await fetchAnimeById(id);
    STATE.selectedAnime = anime;
    STATE.selectedEpisode = 1;
    renderAnimeDetail(anime);
  } catch (e) {
    container.innerHTML = `<div class="loading">Ошибка: ${e.message}</div>`;
  }
}

function renderAnimeDetail(anime) {
  const title = anime.title.romaji || anime.title.english || anime.title.native || 'Без названия';
  const img = anime.coverImage?.large || anime.coverImage?.medium || '';
  const genres = anime.genres || [];
  const description = anime.description ? anime.description.replace(/<[^>]*>/g, '').slice(0, 300) + '...' : 'Описание отсутствует';
  const episodes = anime.episodes || 12;

  let html = `
    <div class="anime-detail">
      <div class="anime-detail-header">
        <img src="${img}" alt="${title}" />
        <div class="info">
          <h2>${title}</h2>
          <p>${description}</p>
          <div class="genres">
            ${genres.map(g => `<span>${g}</span>`).join('')}
          </div>
          <p>⭐ ${anime.averageScore || '?'}% · ${anime.status || 'Неизвестно'} · ${episodes} серий</p>
          <button id="backToHome">← На главную</button>
        </div>
      </div>
      <div class="player-section">
        <h3>Выбор серии</h3>
        <div class="episode-list">
  `;
  for (let i = 1; i <= episodes; i++) {
    html += `<button class="${i === STATE.selectedEpisode ? 'active-ep' : ''}" data-ep="${i}">${i}</button>`;
  }
  html += `
        </div>
        <div class="player-tabs">
          <button class="active-tab" data-source="youtube">▶ YouTube</button>
          <button data-source="manual">🔗 Ссылка</button>
          <button data-source="vk">📺 VK (эксперим.)</button>
        </div>
        <div id="playerContent">
          <div class="video-container" id="videoContainer">
            <iframe id="playerIframe" src="" allowfullscreen></iframe>
          </div>
          <div class="manual-link-area" id="manualLinkArea" style="display:none;">
            <input type="text" id="manualLinkInput" placeholder="Вставьте ссылку на видео (iframe-совместимую)" />
            <button id="manualLinkBtn">Загрузить</button>
          </div>
        </div>
      </div>
    </div>
  `;
  container.innerHTML = html;

  // Кнопка "На главную"
  $('#backToHome')?.addEventListener('click', () => {
    STATE.selectedAnime = null;
    STATE.searchQuery = '';
    renderHome();
  });

  // Обработчики выбора серии
  const epButtons = container.querySelectorAll('.episode-list button');
  epButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      const ep = parseInt(btn.dataset.ep);
      STATE.selectedEpisode = ep;
      // обновить активный класс
      epButtons.forEach(b => b.classList.remove('active-ep'));
      btn.classList.add('active-ep');
      // Загрузить видео для текущего источника
      const activeSource = container.querySelector('.player-tabs .active-tab')?.dataset.source || 'youtube';
      loadEpisodeWithSource(anime, ep, activeSource);
    });
  });

  // Обработчики вкладок плеера
  const tabButtons = container.querySelectorAll('.player-tabs button');
  tabButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      tabButtons.forEach(b => b.classList.remove('active-tab'));
      btn.classList.add('active-tab');
      const source = btn.dataset.source;
      // Показать/скрыть ручной ввод
      const manualArea = $('#manualLinkArea');
      if (source === 'manual') {
        manualArea.style.display = 'flex';
      } else {
        manualArea.style.display = 'none';
      }
      // Загрузить видео для текущей серии с новым источником
      loadEpisodeWithSource(anime, STATE.selectedEpisode, source);
    });
  });

  // Ручной ввод ссылки
  $('#manualLinkBtn')?.addEventListener('click', () => {
    const link = $('#manualLinkInput').value.trim();
    if (!link) {
      alert('Введите ссылку');
      return;
    }
    const iframe = $('#playerIframe');
    if (iframe) {
      iframe.src = link;
    }
  });

  // Загружаем первую серию по умолчанию (YouTube)
  loadEpisodeWithSource(anime, STATE.selectedEpisode, 'youtube');
}

// Загрузка видео с выбранным источником
async function loadEpisodeWithSource(anime, ep, source) {
  const iframe = $('#playerIframe');
  if (!iframe) return;
  const title = anime.title.romaji || anime.title.english || anime.title.native || '';

  if (source === 'youtube') {
    // Поиск на YouTube через Invidious
    const query = `${title} серия ${ep} аниме`;
    iframe.src = ''; // очищаем
    try {
      const videoId = await searchVideo(query);
      if (videoId) {
        iframe.src = `https://yewtu.be/embed/${videoId}`;
      } else {
        // Если не найдено, показываем поисковую выдачу YouTube
        iframe.src = `https://www.youtube.com/embed/?listType=search&list=${encodeURIComponent(query)}`;
      }
    } catch (e) {
      iframe.src = `https://www.youtube.com/embed/?listType=search&list=${encodeURIComponent(query)}`;
    }
  } else if (source === 'vk') {
    // Попытка использовать VK Video (экспериментально)
    // Просто показываем поиск на YouTube, так как VK требует oEmbed
    const query = `${title} серия ${ep} аниме`;
    iframe.src = `https://www.youtube.com/embed/?listType=search&list=${encodeURIComponent(query)}`;
  } else if (source === 'manual') {
    // Оставляем пустым, пользователь введёт сам
    iframe.src = '';
    // Показываем поле ввода
    const manualArea = $('#manualLinkArea');
    if (manualArea) manualArea.style.display = 'flex';
  }
}

// -----------------------------------------------------------------------------
// 6. ПРОФИЛЬ
// -----------------------------------------------------------------------------
function renderProfile() {
  if (!STATE.currentUser) {
    renderHome();
    return;
  }
  clearContainer();
  const username = STATE.currentUser.username;
  const lists = getUserLists(username);
  const avatar = STATE.avatars[username] || '';

  let html = `
    <div class="profile-header">
      <img class="profile-avatar" id="profileAvatar" src="${avatar || 'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%22100%22 height=%22100%22/%3E'}" alt="avatar" />
      <div class="profile-info">
        <h2>${username}</h2>
        <div class="profile-stats">
          <span>⭐ Избранное: ${lists.favorites.length}</span>
          <span>👁️ Просмотрено: ${lists.watched.length}</span>
          <span>🚫 Брошено: ${lists.dropped.length}</span>
        </div>
        <button id="changeAvatarBtn">📷 Сменить аватар</button>
      </div>
    </div>
    <div class="profile-tabs">
      <button class="active-tab" data-tab="favorites">Избранное</button>
      <button data-tab="watched">Просмотренное</button>
      <button data-tab="dropped">Брошенное</button>
    </div>
    <div id="profileListContainer"></div>
  `;
  container.innerHTML = html;

  // Обработчик аватарки
  $('#profileAvatar')?.addEventListener('click', () => openAvatarModal());
  $('#changeAvatarBtn')?.addEventListener('click', () => openAvatarModal());

  // Вкладки
  container.querySelectorAll('.profile-tabs button').forEach(btn => {
    btn.addEventListener('click', () => {
      container.querySelectorAll('.profile-tabs button').forEach(b => b.classList.remove('active-tab'));
      btn.classList.add('active-tab');
      const tab = btn.dataset.tab;
      renderProfileList(tab);
    });
  });

  // По умолчанию показываем избранное
  renderProfileList('favorites');
}

// Рендер списка аниме в профиле (по типу)
async function renderProfileList(type) {
  const containerList = $('#profileListContainer');
  if (!containerList) return;
  const username = STATE.currentUser.username;
  const lists = getUserLists(username);
  const ids = lists[type] || [];
  if (ids.length === 0) {
    containerList.innerHTML = '<div class="loading">Список пуст</div>';
    return;
  }

  containerList.innerHTML = '<div class="loading">Загрузка...</div>';
  try {
    const animes = [];
    for (const id of ids) {
      let found = STATE.animeList.find(a => a.id === id);
      if (!found) {
        try {
          found = await fetchAnimeById(id);
        } catch (e) { continue; }
      }
      if (found) animes.push(found);
    }
    renderAnimeGrid(animes, containerList);
  } catch (e) {
    containerList.innerHTML = `<div class="loading">Ошибка: ${e.message}</div>`;
  }
}

// -----------------------------------------------------------------------------
// 7. АВТОРИЗАЦИЯ (модальное окно)
// -----------------------------------------------------------------------------
const authModal = $('#authModal');
const authForm = $('#authForm');
const authTitle = $('#authTitle');
const authSubmitBtn = $('#authSubmitBtn');
const authToggleLink = $('#authToggleLink');
const authToggleText = $('#authToggleText');
let isLoginMode = true;

function openAuthModal() {
  authModal.style.display = 'flex';
  isLoginMode = true;
  updateAuthForm();
}

function closeAuthModal() {
  authModal.style.display = 'none';
}

function updateAuthForm() {
  if (isLoginMode) {
    authTitle.textContent = 'Вход';
    authSubmitBtn.textContent = 'Войти';
    authToggleText.innerHTML = 'Нет аккаунта? <a href="#" id="authToggleLink">Зарегистрироваться</a>';
  } else {
    authTitle.textContent = 'Регистрация';
    authSubmitBtn.textContent = 'Создать аккаунт';
    authToggleText.innerHTML = 'Уже есть аккаунт? <a href="#" id="authToggleLink">Войти</a>';
  }
  // перепривязываем обработчик
  const link = document.getElementById('authToggleLink');
  if (link) {
    link.addEventListener('click', (e) => {
      e.preventDefault();
      isLoginMode = !isLoginMode;
      updateAuthForm();
    });
  }
}

// Обработка отправки формы
authForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const username = $('#authUsername').value.trim();
  const password = $('#authPassword').value.trim();
  if (!username || !password) {
    alert('Заполните все поля');
    return;
  }

  if (isLoginMode) {
    // Вход
    const stored = localStorage.getItem(`user_${username}`);
    if (!stored) {
      alert('Пользователь не найден');
      return;
    }
    const user = JSON.parse(stored);
    if (user.password !== password) {
      alert('Неверный пароль');
      return;
    }
    STATE.currentUser = { username, password };
    saveState();
    closeAuthModal();
    updateUI();
    renderCurrentPage();
  } else {
    // Регистрация
    if (localStorage.getItem(`user_${username}`)) {
      alert('Пользователь уже существует');
      return;
    }
    const user = { username, password };
    localStorage.setItem(`user_${username}`, JSON.stringify(user));
    STATE.currentUser = { username, password };
    // инициализируем списки
    getUserLists(username);
    saveState();
    closeAuthModal();
    updateUI();
    renderCurrentPage();
  }
});

// Закрытие модалки по крестику
document.querySelector('.close')?.addEventListener('click', closeAuthModal);
window.addEventListener('click', (e) => {
  if (e.target === authModal) closeAuthModal();
});

// -----------------------------------------------------------------------------
// 8. МОДАЛКА АВАТАРКИ
// -----------------------------------------------------------------------------
const avatarModal = $('#avatarModal');
const avatarInput = $('#avatarInput');
const avatarSaveBtn = $('#avatarSaveBtn');

function openAvatarModal() {
  if (!STATE.currentUser) return;
  avatarModal.style.display = 'flex';
  avatarInput.value = '';
}

function closeAvatarModal() {
  avatarModal.style.display = 'none';
}

document.querySelector('.close-avatar')?.addEventListener('click', closeAvatarModal);
window.addEventListener('click', (e) => {
  if (e.target === avatarModal) closeAvatarModal();
});

avatarSaveBtn?.addEventListener('click', () => {
  const file = avatarInput.files[0];
  if (!file) {
    alert('Выберите файл');
    return;
  }
  const reader = new FileReader();
  reader.onload = function(e) {
    const base64 = e.target.result;
    STATE.avatars[STATE.currentUser.username] = base64;
    saveState();
    closeAvatarModal();
    renderCurrentPage(); // обновить профиль
  };
  reader.readAsDataURL(file);
});

// -----------------------------------------------------------------------------
// 9. НАВИГАЦИЯ И ПЕРЕКЛЮЧЕНИЕ СТРАНИЦ
// -----------------------------------------------------------------------------
function renderCurrentPage() {
  const page = STATE.currentPage;
  if (page === 'home') {
    renderHome();
  } else if (page === 'profile') {
    renderProfile();
  } else {
    renderHome();
  }
  updateUI();
}

function updateUI() {
  const isAuth = !!STATE.currentUser;
  $('#loginBtn').style.display = isAuth ? 'none' : 'inline-block';
  $('#logoutBtn').style.display = isAuth ? 'inline-block' : 'none';
  $('#profileLink').style.display = isAuth ? 'inline-block' : 'none';
}

// Обработчики навигации
$('#homeLink')?.addEventListener('click', (e) => {
  e.preventDefault();
  STATE.currentPage = 'home';
  STATE.selectedAnime = null;
  STATE.searchQuery = '';
  renderCurrentPage();
});

$('#profileLink')?.addEventListener('click', (e) => {
  e.preventDefault();
  if (!STATE.currentUser) {
    alert('Войдите в аккаунт');
    return;
  }
  STATE.currentPage = 'profile';
  STATE.selectedAnime = null;
  renderCurrentPage();
});

$('#loginBtn')?.addEventListener('click', openAuthModal);

$('#logoutBtn')?.addEventListener('click', () => {
  STATE.currentUser = null;
  saveState();
  STATE.currentPage = 'home';
  STATE.selectedAnime = null;
  STATE.searchQuery = '';
  renderCurrentPage();
  updateUI();
});

// Тема
$('#themeToggle')?.addEventListener('click', () => {
  document.body.classList.toggle('dark');
  const isDark = document.body.classList.contains('dark');
  $('#themeToggle').textContent = isDark ? '☀️ Тема' : '🌙 Тема';
});

// -----------------------------------------------------------------------------
// 10. ПОИСК
// -----------------------------------------------------------------------------
const searchInput = $('#searchInput');
const searchBtn = $('#searchBtn');
const clearSearchBtn = $('#clearSearchBtn');

searchBtn?.addEventListener('click', () => {
  const query = searchInput.value.trim();
  if (query) {
    STATE.searchQuery = query;
    STATE.currentPage = 'home';
    STATE.selectedAnime = null;
    renderCurrentPage();
  } else {
    alert('Введите название для поиска');
  }
});

searchInput?.addEventListener('keypress', (e) => {
  if (e.key === 'Enter') {
    searchBtn?.click();
  }
});

clearSearchBtn?.addEventListener('click', () => {
  STATE.searchQuery = '';
  searchInput.value = '';
  STATE.currentPage = 'home';
  STATE.selectedAnime = null;
  renderCurrentPage();
});

// -----------------------------------------------------------------------------
// 11. ИНИЦИАЛИЗАЦИЯ
// -----------------------------------------------------------------------------
loadState();
// Восстановление темы (по умолчанию светлая)
// Если пользователь уже авторизован, показываем главную
if (STATE.currentUser) {
  updateUI();
  renderHome();
} else {
  updateUI();
  renderHome();
}

console.log('AniList App запущен!');
console.log(`Текущий пользователь: ${STATE.currentUser?.username || 'не авторизован'}`);
