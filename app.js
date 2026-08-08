// =============================== app.js ===============================
// Глобальное состояние
const STATE = {
  currentUser: null,
  currentPage: 'home',
  animeList: [],
  selectedAnime: null,
  selectedEpisode: 1,
  searchQuery: '',
  userLists: {},
  avatars: {},
};

// Вспомогательные функции
function $(sel) { return document.querySelector(sel); }
function $$(sel) { return document.querySelectorAll(sel); }

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

function getUserLists(username) {
  if (!STATE.userLists[username]) {
    STATE.userLists[username] = { favorites: [], watched: [], dropped: [] };
    saveState();
  }
  return STATE.userLists[username];
}

function toggleList(username, animeId, listName) {
  const lists = getUserLists(username);
  const arr = lists[listName];
  if (!arr) return;
  const idx = arr.indexOf(animeId);
  if (idx > -1) arr.splice(idx, 1);
  else arr.push(animeId);
  saveState();
  renderCurrentPage();
}

// AniList API
const ANILIST_API = 'https://graphql.anilist.co';

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

// ---------- ПОИСК ВИДЕО (несколько источников) ----------
// 1. Invidious (YouTube прокси)
async function searchVideoInvidious(query) {
  const instances = ['https://yewtu.be', 'https://invidious.snopyta.org', 'https://inv.riverside.rocks'];
  for (const base of instances) {
    try {
      const resp = await fetch(`${base}/api/v1/search?q=${encodeURIComponent(query)}&type=video`);
      if (!resp.ok) continue;
      const data = await resp.json();
      if (data && data.length > 0) {
        return { videoId: data[0].videoId, source: 'invidious' };
      }
    } catch (e) { continue; }
  }
  return null;
}

// 2. Piped (альтернативный прокси)
async function searchVideoPiped(query) {
  try {
    const resp = await fetch(`https://pipedapi.kavin.rocks/search?q=${encodeURIComponent(query)}&filter=video`);
    if (!resp.ok) return null;
    const data = await resp.json();
    if (data && data.items && data.items.length > 0) {
      return { videoId: data.items[0].url.split('watch?v=')[1], source: 'piped' };
    }
  } catch (e) { return null; }
}

// 3. Прямой поиск YouTube (встраивание результатов)
function getYouTubeSearchUrl(query) {
  return `https://www.youtube.com/embed/?listType=search&list=${encodeURIComponent(query)}`;
}

// Основная функция загрузки видео
async function loadVideo(anime, episode, source = 'auto') {
  const iframe = $('#playerIframe');
  if (!iframe) return;
  const title = anime.title.romaji || anime.title.english || anime.title.native || '';
  const query = `${title} серия ${episode} аниме`;

  if (source === 'manual') {
    // Показываем поле ввода
    const manualArea = $('#manualLinkArea');
    if (manualArea) manualArea.style.display = 'flex';
    iframe.src = '';
    return;
  }

  // Если auto или youtube - пытаемся найти через прокси
  if (source === 'auto' || source === 'youtube') {
    let videoData = await searchVideoInvidious(query);
    if (!videoData) videoData = await searchVideoPiped(query);
    if (videoData) {
      const embedUrl = videoData.source === 'invidious'
        ? `https://yewtu.be/embed/${videoData.videoId}`
        : `https://www.youtube.com/embed/${videoData.videoId}`;
      iframe.src = embedUrl;
      return;
    }
    // Если не найдено — показываем поиск на YouTube
    iframe.src = getYouTubeSearchUrl(query);
    return;
  }

  if (source === 'vk') {
    // VK Video (попробуем через oEmbed, но это сложно; пока просто показываем поиск YouTube)
    iframe.src = getYouTubeSearchUrl(query);
    return;
  }

  // fallback
  iframe.src = getYouTubeSearchUrl(query);
}

// Рендеринг
const container = $('#pageContainer');

function clearContainer() { container.innerHTML = ''; }

async function renderHome() {
  clearContainer();
  container.innerHTML = '<div class="loading">Загрузка аниме...</div>';
  try {
    const data = await fetchAnimeList(1, 50, STATE.searchQuery);
    STATE.animeList = data.media || [];
    renderAnimeGrid(STATE.animeList);
    const clearBtn = $('#clearSearchBtn');
    if (STATE.searchQuery) clearBtn.style.display = 'inline-block';
    else clearBtn.style.display = 'none';
    const searchInput = $('#searchInput');
    if (searchInput) searchInput.value = STATE.searchQuery;
  } catch (e) {
    container.innerHTML = `<div class="loading">Ошибка загрузки: ${e.message}</div>`;
  }
}

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

  target.querySelectorAll('.card').forEach(card => {
    card.addEventListener('click', (e) => {
      if (e.target.closest('button')) return;
      const id = parseInt(card.dataset.id);
      openAnimeDetail(id);
    });
  });
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
          <div class="genres">${genres.map(g => `<span>${g}</span>`).join('')}</div>
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
          <button class="active-tab" data-source="auto">▶ Авто (YouTube)</button>
          <button data-source="manual">🔗 Ссылка</button>
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
        <p style="margin-top:1rem; font-size:0.85rem; opacity:0.7;">
          💡 Если видео не появляется, переключитесь на вкладку «Ссылка» и вставьте прямую ссылку (например, с YouTube, VK).
        </p>
      </div>
    </div>
  `;
  container.innerHTML = html;

  $('#backToHome')?.addEventListener('click', () => {
    STATE.selectedAnime = null;
    STATE.searchQuery = '';
    renderHome();
  });

  const epButtons = container.querySelectorAll('.episode-list button');
  epButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      const ep = parseInt(btn.dataset.ep);
      STATE.selectedEpisode = ep;
      epButtons.forEach(b => b.classList.remove('active-ep'));
      btn.classList.add('active-ep');
      const activeSource = container.querySelector('.player-tabs .active-tab')?.dataset.source || 'auto';
      loadVideo(anime, ep, activeSource);
    });
  });

  const tabButtons = container.querySelectorAll('.player-tabs button');
  tabButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      tabButtons.forEach(b => b.classList.remove('active-tab'));
      btn.classList.add('active-tab');
      const source = btn.dataset.source;
      const manualArea = $('#manualLinkArea');
      if (source === 'manual') {
        manualArea.style.display = 'flex';
        // Оставляем iframe пустым
        const iframe = $('#playerIframe');
        if (iframe) iframe.src = '';
      } else {
        manualArea.style.display = 'none';
        // Загружаем видео для текущей серии с новым источником
        loadVideo(anime, STATE.selectedEpisode, source);
      }
    });
  });

  $('#manualLinkBtn')?.addEventListener('click', () => {
    const link = $('#manualLinkInput').value.trim();
    if (!link) {
      alert('Введите ссылку');
      return;
    }
    const iframe = $('#playerIframe');
    if (iframe) iframe.src = link;
  });

  // Загружаем первую серию автоматически
  loadVideo(anime, STATE.selectedEpisode, 'auto');
}

// Профиль
function renderProfile() {
  if (!STATE.currentUser) { renderHome(); return; }
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

  $('#profileAvatar')?.addEventListener('click', () => openAvatarModal());
  $('#changeAvatarBtn')?.addEventListener('click', () => openAvatarModal());

  container.querySelectorAll('.profile-tabs button').forEach(btn => {
    btn.addEventListener('click', () => {
      container.querySelectorAll('.profile-tabs button').forEach(b => b.classList.remove('active-tab'));
      btn.classList.add('active-tab');
      renderProfileList(btn.dataset.tab);
    });
  });
  renderProfileList('favorites');
}

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
        try { found = await fetchAnimeById(id); } catch (e) { continue; }
      }
      if (found) animes.push(found);
    }
    renderAnimeGrid(animes, containerList);
  } catch (e) {
    containerList.innerHTML = `<div class="loading">Ошибка: ${e.message}</div>`;
  }
}

// Авторизация
const authModal = $('#authModal');
const authForm = $('#authForm');
let isLoginMode = true;

function openAuthModal() {
  authModal.style.display = 'flex';
  isLoginMode = true;
  updateAuthForm();
}
function closeAuthModal() { authModal.style.display = 'none'; }

function updateAuthForm() {
  const title = $('#authTitle');
  const btn = $('#authSubmitBtn');
  const toggleText = $('#authToggleText');
  if (isLoginMode) {
    title.textContent = 'Вход';
    btn.textContent = 'Войти';
    toggleText.innerHTML = 'Нет аккаунта? <a href="#" id="authToggleLink">Зарегистрироваться</a>';
  } else {
    title.textContent = 'Регистрация';
    btn.textContent = 'Создать аккаунт';
    toggleText.innerHTML = 'Уже есть аккаунт? <a href="#" id="authToggleLink">Войти</a>';
  }
  const link = document.getElementById('authToggleLink');
  if (link) {
    link.addEventListener('click', (e) => {
      e.preventDefault();
      isLoginMode = !isLoginMode;
      updateAuthForm();
    });
  }
}

authForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const username = $('#authUsername').value.trim();
  const password = $('#authPassword').value.trim();
  if (!username || !password) { alert('Заполните все поля'); return; }

  if (isLoginMode) {
    const stored = localStorage.getItem(`user_${username}`);
    if (!stored) { alert('Пользователь не найден'); return; }
    const user = JSON.parse(stored);
    if (user.password !== password) { alert('Неверный пароль'); return; }
    STATE.currentUser = { username, password };
    saveState();
    closeAuthModal();
    updateUI();
    renderCurrentPage();
  } else {
    if (localStorage.getItem(`user_${username}`)) { alert('Пользователь уже существует'); return; }
    localStorage.setItem(`user_${username}`, JSON.stringify({ username, password }));
    STATE.currentUser = { username, password };
    getUserLists(username);
    saveState();
    closeAuthModal();
    updateUI();
    renderCurrentPage();
  }
});

document.querySelector('.close')?.addEventListener('click', closeAuthModal);
window.addEventListener('click', (e) => { if (e.target === authModal) closeAuthModal(); });

// Аватарка
const avatarModal = $('#avatarModal');
const avatarInput = $('#avatarInput');
const avatarSaveBtn = $('#avatarSaveBtn');

function openAvatarModal() {
  if (!STATE.currentUser) return;
  avatarModal.style.display = 'flex';
  avatarInput.value = '';
}
function closeAvatarModal() { avatarModal.style.display = 'none'; }

document.querySelector('.close-avatar')?.addEventListener('click', closeAvatarModal);
window.addEventListener('click', (e) => { if (e.target === avatarModal) closeAvatarModal(); });

avatarSaveBtn?.addEventListener('click', () => {
  const file = avatarInput.files[0];
  if (!file) { alert('Выберите файл'); return; }
  const reader = new FileReader();
  reader.onload = function(e) {
    STATE.avatars[STATE.currentUser.username] = e.target.result;
    saveState();
    closeAvatarModal();
    renderCurrentPage();
  };
  reader.readAsDataURL(file);
});

// Навигация
function renderCurrentPage() {
  if (STATE.currentPage === 'home') renderHome();
  else if (STATE.currentPage === 'profile') renderProfile();
  else renderHome();
  updateUI();
}

function updateUI() {
  const isAuth = !!STATE.currentUser;
  $('#loginBtn').style.display = isAuth ? 'none' : 'inline-block';
  $('#logoutBtn').style.display = isAuth ? 'inline-block' : 'none';
  $('#profileLink').style.display = isAuth ? 'inline-block' : 'none';
}

$('#homeLink')?.addEventListener('click', (e) => {
  e.preventDefault();
  STATE.currentPage = 'home';
  STATE.selectedAnime = null;
  STATE.searchQuery = '';
  renderCurrentPage();
});

$('#profileLink')?.addEventListener('click', (e) => {
  e.preventDefault();
  if (!STATE.currentUser) { alert('Войдите в аккаунт'); return; }
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

$('#themeToggle')?.addEventListener('click', () => {
  document.body.classList.toggle('dark');
  const isDark = document.body.classList.contains('dark');
  $('#themeToggle').textContent = isDark ? '☀️ Тема' : '🌙 Тема';
});

// Поиск
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
  if (e.key === 'Enter') searchBtn?.click();
});

clearSearchBtn?.addEventListener('click', () => {
  STATE.searchQuery = '';
  searchInput.value = '';
  STATE.currentPage = 'home';
  STATE.selectedAnime = null;
  renderCurrentPage();
});

// Инициализация
loadState();
if (STATE.currentUser) updateUI();
renderCurrentPage();

console.log('AniList App запущен (с улучшенным плеером)');