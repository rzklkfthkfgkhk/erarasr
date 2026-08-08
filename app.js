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
  vkToken: '',
  theme: 'light',
};

function $(sel) { return document.querySelector(sel); }
function $$(sel) { return document.querySelectorAll(sel); }

function loadState() {
  try {
    const raw = localStorage.getItem('animeapp_state');
    if (raw) {
      const parsed = JSON.parse(raw);
      STATE.userLists = parsed.userLists || {};
      STATE.avatars = parsed.avatars || {};
      STATE.vkToken = parsed.vkToken || '';
      STATE.theme = parsed.theme || 'light';
      if (parsed.currentUser) STATE.currentUser = parsed.currentUser;
    }
  } catch (e) { console.warn('Ошибка загрузки состояния', e); }
}
function saveState() {
  try {
    localStorage.setItem('animeapp_state', JSON.stringify({
      userLists: STATE.userLists,
      avatars: STATE.avatars,
      vkToken: STATE.vkToken,
      theme: STATE.theme,
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

// ---------- ТРАНСЛИТЕРАЦИЯ ДЛЯ JUT.SU / YAMMUANIME ----------
function transliterate(word) {
  const map = {
    'а':'a','б':'b','в':'v','г':'g','д':'d','е':'e','ё':'e','ж':'zh','з':'z',
    'и':'i','й':'y','к':'k','л':'l','м':'m','н':'n','о':'o','п':'p','р':'r',
    'с':'s','т':'t','у':'u','ф':'f','х':'h','ц':'c','ч':'ch','ш':'sh','щ':'shch',
    'ъ':'','ы':'y','ь':'','э':'e','ю':'yu','я':'ya'
  };
  return word.toLowerCase().split('').map(ch => map[ch] || ch).join('').replace(/[^a-z0-9]/g, '');
}

function generateJutSuUrl(title, episode) {
  const slug = transliterate(title).replace(/\s+/g, '-');
  return `https://jut.su/${slug}/season-1/episode-${episode}.html`;
}

function generateYammuanimeUrl(title, episode) {
  const slug = transliterate(title).replace(/\s+/g, '-');
  return `https://yammuanime.com/anime/${slug}/episode-${episode}`;
}

// ---------- ПОИСК ВИДЕО (YouTube, VK) ----------
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

async function searchVideoPiped(query) {
  try {
    const resp = await fetch(`https://pipedapi.kavin.rocks/search?q=${encodeURIComponent(query)}&filter=video`);
    if (!resp.ok) return null;
    const data = await resp.json();
    if (data && data.items && data.items.length > 0) {
      const url = data.items[0].url;
      const videoId = url.split('watch?v=')[1] || url.split('/')?.pop();
      return { videoId, source: 'piped' };
    }
  } catch (e) { return null; }
}

async function searchVideoVK(query) {
  if (!STATE.vkToken) return { error: 'Токен VK не задан' };
  const url = `https://api.vk.com/method/video.search?q=${encodeURIComponent(query)}&count=1&access_token=${STATE.vkToken}&v=5.131`;
  try {
    const resp = await fetch(url);
    const data = await resp.json();
    if (data.error) return { error: data.error.error_msg || 'Ошибка VK API' };
    if (data.response && data.response.items && data.response.items.length > 0) {
      const video = data.response.items[0];
      const embed = `https://vk.com/video_ext.php?oid=${video.owner_id}&id=${video.id}&hash=${video.access_key || ''}`;
      return { embedUrl: embed, source: 'vk' };
    }
    return { error: 'Видео не найдено' };
  } catch (e) {
    return { error: 'Ошибка запроса к VK' };
  }
}

function getYouTubeSearchUrl(query) {
  return `https://www.youtube.com/embed/?listType=search&list=${encodeURIComponent(query)}`;
}

async function loadVideo(anime, episode, source = 'auto') {
  const iframe = $('#playerIframe');
  if (!iframe) return;
  const title = anime.title.romaji || anime.title.english || anime.title.native || '';
  const query = `${title} серия ${episode} аниме`;

  if (source === 'manual') {
    const manualArea = $('#manualLinkArea');
    if (manualArea) manualArea.style.display = 'flex';
    iframe.src = '';
    return;
  }

  if (source === 'vk') {
    const result = await searchVideoVK(query);
    if (result.embedUrl) {
      iframe.src = result.embedUrl;
      return;
    } else {
      alert(`VK: ${result.error || 'Видео не найдено'}. Попробуйте YouTube.`);
      const youtubeTab = document.querySelector('.player-tabs button[data-source="auto"]');
      if (youtubeTab) youtubeTab.click();
      return;
    }
  }

  if (source === 'jutsu') {
    const url = generateJutSuUrl(title, episode);
    iframe.src = url;
    // Показываем поле для ручной правки
    const manualArea = $('#manualLinkArea');
    manualArea.style.display = 'flex';
    $('#manualLinkInput').value = url;
    // Добавляем кнопку поиска на Jut.su
    const searchBtn = document.createElement('button');
    searchBtn.textContent = '🔍 Поиск на Jut.su';
    searchBtn.onclick = () => {
      window.open(`https://jut.su/search/?q=${encodeURIComponent(title)}`, '_blank');
    };
    // Чтобы не дублировать, очистим предыдущие кнопки
    const oldBtn = manualArea.querySelector('.jutsu-search-btn');
    if (oldBtn) oldBtn.remove();
    searchBtn.className = 'jutsu-search-btn';
    manualArea.appendChild(searchBtn);
    return;
  }

  if (source === 'yammuanime') {
    const url = generateYammuanimeUrl(title, episode);
    iframe.src = url;
    const manualArea = $('#manualLinkArea');
    manualArea.style.display = 'flex';
    $('#manualLinkInput').value = url;
    return;
  }

  // source === 'auto' или 'youtube' – Invidious + Piped
  let videoData = await searchVideoInvidious(query);
  if (!videoData) videoData = await searchVideoPiped(query);
  if (videoData) {
    const embedUrl = videoData.source === 'invidious'
      ? `https://yewtu.be/embed/${videoData.videoId}`
      : `https://www.youtube.com/embed/${videoData.videoId}`;
    iframe.src = embedUrl;
    return;
  }
  iframe.src = getYouTubeSearchUrl(query);
}

// ---------- РЕНДЕРИНГ ----------
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
          <button class="active-tab" data-source="auto">▶ YouTube</button>
          <button data-source="vk">📺 VK</button>
          <button data-source="jutsu">🎬 Jut.su</button>
          <button data-source="yammuanime">🎬 Yammuanime</button>
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
          💡 Для VK нужен сервисный ключ (настройки в профиле). Jut.su / Yammuanime строят ссылки автоматически, но могут не работать – исправьте вручную.
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
        const iframe = $('#playerIframe');
        if (iframe) iframe.src = '';
        // Убираем лишние кнопки поиска
        const oldBtn = manualArea.querySelector('.jutsu-search-btn');
        if (oldBtn) oldBtn.remove();
      } else {
        manualArea.style.display = 'none';
        // Убираем лишние кнопки
        const oldBtn = manualArea.querySelector('.jutsu-search-btn');
        if (oldBtn) oldBtn.remove();
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

  // Загружаем первую серию (авто – YouTube)
  loadVideo(anime, STATE.selectedEpisode, 'auto');
}

// ---------- ОСТАЛЬНЫЕ ФУНКЦИИ (профиль, модалки, темы, поиск) ----------
// ... (они такие же, как в предыдущей версии, не меняются)

// ---------- ИНИЦИАЛИЗАЦИЯ ----------
loadState();
document.documentElement.setAttribute('data-theme', STATE.theme);
if (STATE.currentUser) updateUI();
renderCurrentPage();
console.log('AniList App запущен с поддержкой Jut.su и Yammuanime');