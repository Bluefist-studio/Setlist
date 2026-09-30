import { createFirebaseSync } from './firebase-sync.js';
import exerciseDatabase from './exercises.json' with { type: 'json' };

const normalizeLabel = value => String(value).replaceAll('_', ' ').replace(/\b\w/g, letter => letter.toUpperCase());
const normalizeEquipment = value => ({
  bodyweight: 'Bodyweight', barbell: 'Barbell', dumbbells: 'Dumbbells', kettlebell: 'Kettlebell',
  'resistance bands': 'Resistance bands', machine: 'Machines', machines: 'Machines'
}[String(value).toLowerCase()] || normalizeLabel(value));
const EXERCISES = exerciseDatabase.map(record => {
  const sets = Number(record.defaultSets) || 3;
  const rest = Number(record.defaultRestSeconds) || 60;
  const estimatedMinutes = Number(record.estimatedTime) || 5;
  return {
    id: record.id,
    name: record.name,
    equipment: record.equipment.map(normalizeEquipment),
    parts: record.bodyParts.map(normalizeLabel),
    categories: record.categories.map(normalizeLabel),
    description: record.description || '',
    howTo: record.howTo || '',
    sets,
    reps: Number(record.defaultReps) || 10,
    weight: Number(record.defaultWeight) || 0,
    rest,
    work: Math.max(15, Math.round(estimatedMinutes * 60 / sets - rest)),
    estimatedMinutes,
    unit: record.unit === 'seconds' ? 'sec' : 'reps'
  };
});
const EQUIPMENT = [...new Set([...EXERCISES.flatMap(exercise => exercise.equipment), 'Other'])];
const BODY_PARTS = [...new Set(['Full Body', 'Upper Body', 'Lower Body', ...EXERCISES.flatMap(exercise => exercise.parts)])];
const DURATIONS = [15, 20, 30, 45, 60];
const STORAGE_KEY = 'setlist.v1';
let firebaseSync = null;

const Store = {
  hasLocalData: false,
  read() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const data = JSON.parse(raw);
        this.hasLocalData = true;
        if (!Number.isFinite(Number(data._updatedAt))) data._updatedAt = Date.now();
        return data;
      }
    } catch (error) { console.warn('Setlist data could not be read.', error); }
    return this.createInitialData();
  },
  createInitialData() {
    return {
      user: { name: '', equipment: ['Bodyweight', 'Kettlebell', 'Dumbbells', 'Resistance bands', 'Machines'], favorites: ['kb-row', 'kb-press', 'push-up', 'goblet-squat', 'dead-bug', 'db-row', 'face-pull', 'kb-swing'], duration: 30, xp: 0, onboarded: false },
      workouts: [], history: [], active: null, _updatedAt: 0
    };
  },
  data: null,
  persistLocal() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(this.data));
    this.hasLocalData = true;
  },
  save() {
    this.data._updatedAt = Math.max(Date.now(), Number(this.data._updatedAt || 0) + 1);
    this.persistLocal();
    firebaseSync?.saveLocalSnapshot();
  }
};
Store.data = Store.read();

const state = { view: 'home', query: '', equipmentFilter: 'All equipment', partFilter: 'All body parts', categoryFilter: 'All categories', favoritesOnly: false, timerHandle: null, quickDraft: null, builderDraft: null, modalMode: null, modalReturn: null, cloudStatus: 'Checking Firebase connection…' };
const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const exerciseById = id => EXERCISES.find(exercise => exercise.id === id);
const safeText = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
const formatDuration = seconds => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
const dateLabel = date => date ? new Date(date).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : 'Not yet';
const currentWorkout = () => Store.data.active;
const workoutElapsed = workout => {
  if (!workout?.startedAt) return 0;
  if (workout.completed) return workout.elapsedSeconds || 0;
  const pauseOffset = workout.pausedSeconds || 0;
  const currentPause = workout.pausedAt ? Date.now() - workout.pausedAt : 0;
  return Math.max(0, Math.floor((Date.now() - workout.startedAt - pauseOffset - currentPause) / 1000));
};
const itemExercise = item => exerciseById(item.exerciseId);
const itemSets = item => item.sets ?? itemExercise(item)?.sets ?? 3;
const itemReps = item => item.reps ?? itemExercise(item)?.reps ?? 10;
const itemWeight = item => item.weight ?? itemExercise(item)?.weight ?? 0;
const itemMetric = item => `${itemReps(item)} ${itemExercise(item)?.unit === 'sec' ? 'sec' : 'reps'}`;
const estimateWorkout = items => Math.round(items.reduce((total, item) => total + ((itemExercise(item)?.work || 40) + (itemExercise(item)?.rest || 60)) * itemSets(item), 0) / 60);
const totalSets = workout => (workout?.items || []).reduce((sum, item) => sum + itemSets(item), 0);
const completedSets = workout => (workout?.items || []).reduce((sum, item) => sum + (item.completedSets?.length || 0), 0);
const itemDone = item => item.skipped || item.completedSets?.length >= itemSets(item);
const workoutDoneItems = workout => (workout?.items || []).filter(itemDone).length;
const activeItem = workout => workout?.items?.[workout.currentIndex];
const xpLevel = xp => Math.floor(Math.max(0, xp) / 500) + 1;
const xpProgress = xp => Math.max(0, xp) % 500;
const volumeFor = workout => (workout.items || []).reduce((total, item) => total + (item.completedSets || []).reduce((sum, set) => sum + (Number(set.weight) || 0) * (Number(set.reps) || 0), 0), 0);

function toast(message) {
  const element = $('#toast'); element.textContent = message; element.classList.add('visible');
  clearTimeout(toast.timeout); toast.timeout = setTimeout(() => element.classList.remove('visible'), 2400);
}
function saveAndRender() { Store.save(); render(); }
function setView(view) {
  state.view = view; closeModal(); render(); window.scrollTo({ top: 0, behavior: 'smooth' });
}
function updateProfile() {
  const name = Store.data.user.name || 'Your space';
  const initials = name.trim().charAt(0).toUpperCase() || 'S';
  $('#sidebar-name').textContent = name; $('#sidebar-level').textContent = `Level ${xpLevel(Store.data.user.xp)} · ${Store.data.user.xp} XP`;
  $('#user-avatar').textContent = initials; $('#top-avatar').textContent = initials;
}
function render() {
  updateProfile();
  const labels = { home: 'YOUR TRAINING, YOUR CALL', exercises: 'MOVE LIBRARY', workouts: 'YOUR WORKOUT BANK', stats: 'THE WORK YOU PUT IN', active: 'IN PROGRESS' };
  $('#topbar-context').textContent = labels[state.view] || labels.home;
  $$('.nav-link, .mobile-nav-link').forEach(link => link.classList.toggle('active', link.dataset.view === state.view));
  const view = $('#view-container');
  if (state.view === 'active' && currentWorkout()) view.innerHTML = renderActiveWorkout();
  else if (state.view === 'exercises') view.innerHTML = renderExercises();
  else if (state.view === 'workouts') view.innerHTML = renderWorkouts();
  else if (state.view === 'stats') view.innerHTML = renderStats();
  else view.innerHTML = renderHome();
  if (state.view === 'active' && currentWorkout()) linkExerciseLabels(view, currentWorkout().items, '.remaining-row');
  if (state.view === 'workouts') addWorkoutCardControls(view);
  if (state.view === 'stats') addHistoryControls(view);
  if (state.view === 'active' && currentWorkout()?.completed) {
    const saveButton = $('[data-action="save-completed"]', view);
    if (saveButton) {
      const discardButton = document.createElement('button');
      discardButton.className = 'button button-secondary button-full completion-secondary';
      discardButton.dataset.action = 'finish-without-saving';
      discardButton.textContent = 'FINISH WITHOUT SAVING';
      saveButton.after(discardButton);
    }
  } else if (state.view === 'active' && currentWorkout()) {
    $$('.remaining-row', view).forEach((row, index) => {
      if (itemDone(currentWorkout().items[index])) return;
      const removeButton = document.createElement('button');
      removeButton.dataset.action = 'remove-active-item'; removeButton.dataset.index = index;
      removeButton.setAttribute('aria-label', `Remove ${itemExercise(currentWorkout().items[index])?.name || 'exercise'}`);
      removeButton.textContent = 'REMOVE'; row.append(removeButton);
    });
  }
  if (state.view === 'active' && currentWorkout()) updateTimedExerciseLabels(view);
  renderDock();
  if (!Store.data.user.onboarded) renderOnboarding();
  else if ($('#onboarding-root')) $('#onboarding-root').remove();
  if (state.view === 'active' && currentWorkout() && !currentWorkout().pausedAt && !currentWorkout().completed) startTicker();
  else stopTicker();
}
function renderHome() {
  const workouts = Store.data.workouts.slice(0, 3);
  const savedCount = Store.data.history.length;
  const minutes = Store.data.history.reduce((sum, item) => sum + (item.duration || 0), 0);
  const volume = Store.data.history.reduce((sum, item) => sum + (item.volume || 0), 0);
  const xp = Store.data.user.xp, percentage = Math.round(xpProgress(xp) / 5);
  return `<section class="home-intro"><div><div class="eyebrow">A LITTLE MOVEMENT ADDS UP</div><h1>Make today<br>your own.</h1></div><div class="streak-chip"><span class="streak-flame">✳</span>${currentStreak()} day${currentStreak() === 1 ? '' : 's'} active</div></section>
    <section class="hero-grid"><article class="quick-card"><div class="quick-kicker"><span>✳</span> QUICK START</div><h2>Pick a focus.<br>We’ll shape the session.</h2><p>${Store.data.user.duration} min · Based on your gear &amp; favorites</p><div class="quick-actions"><button class="button button-primary" data-action="quick-start">QUICK WORKOUT <span>↗</span></button><span class="quick-action-note">No plan required</span></div></article>
    <article class="level-card"><div><div class="level-top"><span class="eyebrow">YOUR PACE</span><span class="streak-flame">✳</span></div><div class="level-number">${xpLevel(xp)}<small>LEVEL</small></div></div><div><div class="xp-label"><span>${xpProgress(xp)} / 500 XP</span><span>${percentage}%</span></div><div class="progress-track"><div class="progress-fill" style="width:${percentage}%"></div></div><p class="level-caption">Consistency counts. Every session.</p></div></article></section>
    <section class="section-head"><h2>Your workouts</h2><button class="text-button" data-view="workouts">VIEW ALL &nbsp;→</button></section>
    ${workouts.length ? `<div class="workout-list">${workouts.map((workout, index) => `<div class="workout-row" data-action="open-template" data-id="${workout.id}"><div class="workout-stamp">${String(index + 1).padStart(2, '0')}</div><div class="workout-row-main"><strong>${safeText(workout.name)}</strong><small>${workout.items.length} exercises · ${estimateWorkout(workout.items)} min${workout.lastUsed ? ` · last ${dateLabel(workout.lastUsed)}` : ''}</small></div><span class="row-arrow">→</span></div>`).join('')}</div>` : `<div class="empty-state">Your workout bank is ready when you are.</div>`}
    <div class="create-strip"><div><strong>Have a session in mind?</strong><small>Build it your way, then save it for later.</small></div><button class="button button-secondary button-small" data-action="create-workout">＋ CREATE WORKOUT</button></div>
    <div class="home-bottom"><div class="metric-mini"><strong>${savedCount}</strong><span>Workouts logged</span></div><div class="metric-mini"><strong>${formatHours(minutes)}</strong><span>Training time</span></div><div class="metric-mini"><strong>${formatNumber(volume)} <small>lb</small></strong><span>Volume moved</span></div></div>`;
}
function formatHours(minutes) { const hours = Math.floor(minutes / 60), remainder = minutes % 60; return hours ? `${hours}h ${remainder}m` : `${remainder}m`; }
function formatNumber(value) { return Math.round(value).toLocaleString(); }
function updateTimedExerciseLabels(root) {
  const item = activeItem(currentWorkout()), exercise = item && itemExercise(item);
  if (exercise?.unit !== 'sec') return;
  const suggestion = $('.suggestion', root), metricHeader = $('.set-table th:nth-child(3)', root);
  if (suggestion) suggestion.textContent = `${item.reps} sec hold × ${itemSets(item)} · Suggested`;
  if (metricHeader) metricHeader.textContent = 'TIME';
  $$('.set-table tbody tr', root).forEach(row => {
    const cell = $$('td', row)[2];
    if (!cell) return;
    const input = $('input', cell);
    if (input) cell.insertAdjacentHTML('beforeend', '<small class="set-unit">sec</small>');
    else if (!cell.textContent.includes('sec')) cell.textContent = `${cell.textContent} sec`;
  });
}
function currentStreak() {
  const dates = [...new Set(Store.data.history.map(workout => new Date(workout.endedAt).toDateString()))].map(value => new Date(value).setHours(0, 0, 0, 0)).sort((a, b) => b - a);
  if (!dates.length) return 0;
  let expected = new Date().setHours(0, 0, 0, 0), streak = 0;
  if (dates[0] < expected - 86400000) expected -= 86400000;
  for (const date of dates) { if (date === expected) { streak++; expected -= 86400000; } else if (date < expected) break; }
  return streak;
}
function renderExercises() {
  const exercises = EXERCISES.filter(exercise => {
    const query = state.query.toLowerCase();
    return (!query || exercise.name.toLowerCase().includes(query) || exercise.parts.join(' ').toLowerCase().includes(query)) &&
      (state.equipmentFilter === 'All equipment' || exercise.equipment.includes(state.equipmentFilter)) &&
      (state.partFilter === 'All body parts' || exercise.parts.includes(state.partFilter) || state.partFilter === 'Full Body') &&
      (state.categoryFilter === 'All categories' || exercise.categories.includes(state.categoryFilter)) &&
      (!state.favoritesOnly || Store.data.user.favorites.includes(exercise.id));
  });
  const categories = ['All categories', ...new Set(EXERCISES.flatMap(exercise => exercise.categories))];
  return `<div class="page-heading"><div><div class="eyebrow">MOVE LIBRARY</div><h1>Exercises</h1><p>Find a movement, check your history, make it yours.</p></div>${currentWorkout() ? '<button class="button button-primary" data-action="add-exercise-active">＋ ADD TO WORKOUT</button>' : ''}</div>
    <div class="tool-row"><label class="search-wrap"><span>⌕</span><input class="search-input" id="exercise-search" placeholder="Search movements" value="${safeText(state.query)}" autocomplete="off"></label><select class="select filter-select" id="equipment-filter">${['All equipment', ...EQUIPMENT].map(item => `<option ${item === state.equipmentFilter ? 'selected' : ''}>${item}</option>`).join('')}</select><select class="select filter-select" id="part-filter">${['All body parts', ...BODY_PARTS.filter(part => part !== 'Full Body' && part !== 'Upper Body' && part !== 'Lower Body')].map(item => `<option ${item === state.partFilter ? 'selected' : ''}>${item}</option>`).join('')}</select></div>
    <div class="filter-pills">${categories.map(category => `<button class="filter-pill ${category === state.categoryFilter ? 'selected' : ''}" data-category="${category}">${category}</button>`).join('')}<button class="filter-pill ${state.favoritesOnly ? 'selected' : ''}" data-action="toggle-favorites">♡ Favorites</button></div>
    <div class="library-count">${exercises.length} MOVEMENTS</div><div class="exercise-list">${exercises.length ? exercises.map(renderExerciseRow).join('') : '<div class="empty-state">No movements match those filters.</div>'}</div>`;
}
function renderExerciseRow(exercise) {
  const favorite = Store.data.user.favorites.includes(exercise.id), history = latestExerciseHistory(exercise.id);
  const last = history ? `Last: ${history.weight ? `${history.weight} lb × ` : ''}${history.reps}${exercise.unit === 'sec' ? ' sec' : ''} × ${history.sets}` : `${exercise.equipment.join(' · ')} · ${exercise.parts.join(', ')}`;
  return `<div class="exercise-row"><button type="button" class="exercise-open" data-action="exercise-detail" data-id="${exercise.id}" aria-label="View details for ${safeText(exercise.name)}"><span class="exercise-glyph">${exercise.categories.includes('Core') ? '◌' : exercise.categories.includes('Mobility') ? '⌁' : '↗'}</span><span class="exercise-details"><strong>${safeText(exercise.name)}</strong><small>${safeText(last)}</small></span><span class="exercise-open-arrow" aria-hidden="true">↗</span></button><button class="favorite-button ${favorite ? 'is-favorite' : ''}" data-action="favorite" data-id="${exercise.id}" aria-label="${favorite ? 'Remove favorite' : 'Add favorite'}">${favorite ? '★' : '☆'}</button>${currentWorkout() ? `<button class="exercise-more" data-action="add-active-item" data-id="${exercise.id}" title="Add to active workout">＋</button>` : ''}</div>`;
}
function latestExerciseHistory(id) { return Store.data.history.flatMap(workout => (workout.items || []).filter(item => item.exerciseId === id).map(item => ({ item, endedAt: workout.endedAt }))).sort((a, b) => new Date(b.endedAt) - new Date(a.endedAt))[0]?.item; }
function renderWorkouts() {
  const workouts = Store.data.workouts;
  return `<div class="page-heading"><div><div class="eyebrow">YOUR WORKOUT BANK</div><h1>Workouts</h1><p>Reusable plans, ready when you are.</p></div><button class="button button-primary" data-action="create-workout">＋ CREATE WORKOUT</button></div>
    ${workouts.length ? `<div class="template-grid">${workouts.map(workout => `<article class="template-card"><div class="template-card-top"><div><h3>${safeText(workout.name)}</h3><p>${workout.items.length} exercises · ${estimateWorkout(workout.items)} min</p></div><span class="template-count">${workout.uses || 0}×</span></div><div class="template-exercises">${workout.items.slice(0, 6).map(item => `<span class="exercise-tag">${safeText(itemExercise(item)?.name || 'Exercise')}</span>`).join('')}${workout.items.length > 6 ? `<span class="exercise-tag">+${workout.items.length - 6}</span>` : ''}</div><div class="template-footer"><span class="template-meta">${workout.lastUsed ? `LAST ${dateLabel(workout.lastUsed).toUpperCase()}` : 'NOT STARTED YET'}</span><div class="template-actions"><button data-action="edit-template" data-id="${workout.id}">EDIT</button><button class="start-template" data-action="start-template" data-id="${workout.id}">START</button></div></div></article>`).join('')}</div>` : '<div class="empty-state">No saved workouts yet. Create one to get started.</div>'}
    <div class="create-strip"><div><strong>Want a different mix today?</strong><small>Quick Start builds a fresh session around your preferences.</small></div><button class="button button-secondary button-small" data-action="quick-start">QUICK START ↗</button></div>`;
}
function renderStats() {
  const history = Store.data.history;
  const now = new Date(), thisMonth = history.filter(item => { const date = new Date(item.endedAt); return date.getMonth() === now.getMonth() && date.getFullYear() === now.getFullYear(); });
  const monthSets = thisMonth.reduce((sum, item) => sum + item.items.reduce((count, exercise) => count + (exercise.completedSets?.length || 0), 0), 0);
  const monthMinutes = thisMonth.reduce((sum, item) => sum + item.duration, 0), monthVolume = thisMonth.reduce((sum, item) => sum + item.volume, 0);
  const totalMinutes = history.reduce((sum, item) => sum + item.duration, 0), totalSetsDone = history.reduce((sum, item) => sum + item.items.reduce((count, exercise) => count + (exercise.completedSets?.length || 0), 0), 0);
  const avgRest = averageRest(history.flatMap(item => item.restIntervals || []));
  const weekly = Array.from({ length: 8 }, (_, index) => { const start = new Date(); start.setDate(start.getDate() - index * 7 - 6); start.setHours(0, 0, 0, 0); const end = new Date(start); end.setDate(end.getDate() + 7); return history.filter(item => new Date(item.endedAt) >= start && new Date(item.endedAt) < end).length; }).reverse();
  const maxWeekly = Math.max(1, ...weekly);
  const monthlyAverage = thisMonth.length ? (thisMonth.length / Math.max(1, now.getDate()) * 7).toFixed(1) : '0.0';
  const mostRecent = [...history].sort((a, b) => new Date(b.endedAt) - new Date(a.endedAt));
  return `<div class="page-heading"><div><div class="eyebrow">THE WORK YOU PUT IN</div><h1>Stats</h1><p>A clear look back. No scorecards.</p></div></div>
    <div class="eyebrow">THIS MONTH</div><div class="stats-summary"><div class="stat-block"><span>Workouts</span><strong>${thisMonth.length}</strong><small>${history.length} all time</small></div><div class="stat-block"><span>Training time</span><strong>${formatHours(monthMinutes)}</strong><small>${formatHours(totalMinutes)} all time</small></div><div class="stat-block"><span>Sets</span><strong>${monthSets}</strong><small>${totalSetsDone} all time</small></div><div class="stat-block"><span>Volume</span><strong>${formatNumber(monthVolume)} <small>lb</small></strong><small>${formatNumber(history.reduce((sum, item) => sum + item.volume, 0))} all time</small></div></div>
    <div class="chart-panel"><div class="chart-title"><h2>Workout frequency</h2><span>LAST 8 WEEKS</span></div><div class="bar-chart">${weekly.map((value, index) => `<div class="chart-column"><div class="chart-bar" style="height:${Math.max(3, value / maxWeekly * 100)}%" title="${value} workouts"></div><small>${index % 2 === 0 ? `${index === 0 ? '8' : 8 - index}w` : ''}</small></div>`).join('')}</div></div>
    <div class="stats-lower"><section><div class="section-head"><h2>Training rhythm</h2></div><div class="simple-metric"><span>Frequency this month</span><strong>${monthlyAverage} / week</strong></div><div class="simple-metric"><span>Average workout</span><strong>${formatDuration(history.length ? Math.round(totalMinutes * 60 / history.length) : 0)}</strong></div><div class="simple-metric"><span>Average rest</span><strong>${formatDuration(avgRest)}</strong></div><div class="simple-metric"><span>Current streak</span><strong>${currentStreak()} days</strong></div></section><section><div class="section-head"><h2>Recent sessions</h2></div><div class="history-list">${mostRecent.length ? mostRecent.map(workout => `<div class="history-row"><strong>${safeText(workout.name)}</strong><span>${dateLabel(workout.endedAt)} · ${formatDuration(workout.duration * 60)}</span></div>`).join('') : '<div class="empty-state">Completed workouts will show up here.</div>'}</div></section></div>`;
}
function averageRest(intervals) { return intervals.length ? Math.round(intervals.reduce((sum, value) => sum + value, 0) / intervals.length) : 0; }
function addHistoryControls(root) {
  const orderedHistory = [...Store.data.history].sort((a, b) => new Date(b.endedAt) - new Date(a.endedAt));
  $$('.history-row', root).forEach((row, index) => {
    const workout = orderedHistory[index];
    if (!workout) return;
    const button = document.createElement('button');
    button.className = 'history-delete'; button.dataset.action = 'remove-history'; button.dataset.id = workout.id;
    button.setAttribute('aria-label', `Remove ${workout.name} from history`); button.title = 'Remove from history'; button.textContent = '×';
    row.append(button);
  });
}
function completedTemplateUses(template) {
  return Store.data.history.filter(session => !session.quick && (session.templateId === template.id || (!session.templateId && session.name === template.name))).length;
}
function addWorkoutCardControls(root) {
  $$('.template-card', root).forEach((card, index) => {
    const template = Store.data.workouts[index], actions = $('.template-actions', card);
    if (!template || !actions) return;
    $('.template-count', card).textContent = `${completedTemplateUses(template)}×`;
    $$('.exercise-tag', card).slice(0, Math.min(6, template.items.length)).forEach((tag, exerciseIndex) => {
      const exercise = itemExercise(template.items[exerciseIndex]);
      if (!exercise) return;
      const button = document.createElement('button');
      button.type = 'button'; button.className = 'exercise-tag exercise-tag-button'; button.dataset.action = 'exercise-detail'; button.dataset.id = exercise.id;
      button.textContent = exercise.name; button.setAttribute('aria-label', `View details for ${exercise.name}`); tag.replaceWith(button);
    });
    const remove = document.createElement('button');
    remove.className = 'delete-template'; remove.dataset.action = 'delete-template'; remove.dataset.id = template.id;
    remove.setAttribute('aria-label', `Delete ${template.name}`); remove.title = 'Delete workout'; remove.textContent = '×';
    actions.append(remove);
  });
}
function renderDock() {
  const workout = currentWorkout(), dock = $('#active-dock');
  if (!workout || workout.completed || workout.discarded) { dock.className = 'active-dock'; dock.innerHTML = ''; return; }
  const item = activeItem(workout), exercise = itemExercise(item), setNumber = Math.min((item?.completedSets?.length || 0) + 1, itemSets(item));
  dock.className = 'active-dock visible';
  dock.innerHTML = `<span class="dock-pulse"></span><div class="dock-info"><strong>${workout.pausedAt ? 'WORKOUT PAUSED' : 'WORKOUT ACTIVE'} · ${formatDuration(workoutElapsed(workout))}</strong><span>${safeText(exercise?.name || workout.name)} · Set ${setNumber}/${itemSets(item)}</span></div><span class="dock-time">${formatDuration(workoutElapsed(workout))}</span><button class="button dock-return" data-action="return-workout">RETURN ↗</button>`;
}
function renderActiveWorkout() {
  const workout = currentWorkout();
  if (workout.completed) return renderCompletion(workout);
  const done = workoutDoneItems(workout), total = workout.items.length, item = activeItem(workout);
  if (!item || workout.currentIndex >= workout.items.length) {
    const nextIndex = workout.items.findIndex(entry => !itemDone(entry));
    if (nextIndex < 0) return renderCompletion(workout);
    workout.currentIndex = nextIndex;
  }
  if (workout.items.every(itemDone)) { completeWorkoutState(workout); Store.save(); return renderCompletion(workout); }
  const active = activeItem(workout), exercise = itemExercise(active), doneSets = active.completedSets?.length || 0;
  const isExerciseDone = doneSets >= itemSets(active);
  return `<div class="active-header"><div><div class="eyebrow">${workout.pausedAt ? 'SESSION PAUSED' : 'IN SESSION'}</div><h1>${safeText(workout.name)}</h1></div><div class="timer-display" id="workout-timer">${formatDuration(workoutElapsed(workout))}</div></div>
    <div class="workout-progress"><div class="progress-caption"><span>${done} / ${total} EXERCISES</span><span>${totalSets(workout) ? Math.round(completedSets(workout) / totalSets(workout) * 100) : 0}%</span></div><div class="progress-track"><div class="progress-fill" style="width:${total ? done / total * 100 : 0}%"></div></div></div>
    <article class="active-exercise-card"><div class="active-exercise-top"><div><div class="eyebrow">${isExerciseDone ? 'EXERCISE COMPLETE' : `EXERCISE ${Math.min(done + 1, total)} OF ${total}`}</div><h2>${safeText(exercise?.name || 'Choose an exercise')}</h2><div class="suggestion">${active.weight > 0 ? `${active.weight} lb × ${active.reps} × ${itemSets(active)}` : `${active.reps}${exercise?.unit === 'sec' ? ' sec' : ''} reps × ${itemSets(active)}`} · Suggested</div></div><button class="button button-secondary button-small" data-action="choose-exercise">CHANGE</button></div>
      ${isExerciseDone ? `<div class="next-panel"><h3>That’s this one done. What’s next?</h3><div class="next-options">${workout.items.map((entry, index) => ({ entry, index })).filter(({ entry }) => !itemDone(entry)).slice(0, 4).map(({ entry, index }) => `<button class="next-option" data-action="select-next" data-index="${index}">${safeText(itemExercise(entry)?.name || 'Exercise')} →</button>`).join('')}${workout.items.every(itemDone) ? '<button class="next-option" data-action="finish-workout">Finish session ✓</button>' : ''}<button class="next-option" data-action="add-exercise-active">＋ Choose exercise</button></div></div>` : `<table class="set-table"><thead><tr><th>SET</th><th>WEIGHT</th><th>REPS</th><th>DONE</th></tr></thead><tbody>${Array.from({ length: itemSets(active) }, (_, index) => { const logged = active.completedSets?.[index]; const isNext = index === doneSets; return `<tr class="${isNext ? 'current-set' : ''}"><td class="set-index">${index + 1}</td><td>${logged ? `${logged.weight || 0} lb` : isNext ? `<input class="set-input" inputmode="decimal" type="number" min="0" step="2.5" value="${active.weight || 0}" data-set-field="weight">` : `${active.weight || 0} lb`}</td><td>${logged ? logged.reps : isNext ? `<input class="set-input reps-input" inputmode="numeric" type="number" min="1" value="${active.reps}" data-set-field="reps">` : active.reps}</td><td>${logged ? '<span class="set-done">✓</span>' : ''}</td></tr>`; }).join('')}</tbody></table>
      <div class="sets-adjust"><span>SETS</span><button data-action="change-sets" data-delta="-1" ${itemSets(active) <= doneSets + 1 ? 'disabled' : ''}>−</button><strong>${itemSets(active)}</strong><button data-action="change-sets" data-delta="1">＋</button><span>Adjust today’s plan</span></div>
      <div class="active-controls"><button class="button button-primary" data-action="complete-set" ${workout.pausedAt ? 'disabled' : ''}>COMPLETE SET <span>✓</span></button><button class="button button-secondary" data-action="skip-exercise">SKIP</button></div>
      <div class="next-panel"><h3>Choose what’s next</h3><div class="next-options">${workout.items.map((entry, index) => ({ entry, index })).filter(({ entry, index }) => index !== workout.currentIndex && !itemDone(entry)).slice(0, 3).map(({ entry, index }) => `<button class="next-option" data-action="select-next" data-index="${index}">${safeText(itemExercise(entry)?.name || 'Exercise')} →</button>`).join('')}<button class="next-option" data-action="add-exercise-active">＋ Add exercise</button></div></div>`}</article>
    <div class="remaining-list"><div class="section-head"><h2>Today’s lineup</h2><button class="text-button" data-action="add-exercise-active">＋ ADD</button></div>${workout.items.map((entry, index) => `<div class="remaining-row"><span>${String(index + 1).padStart(2, '0')}</span><strong>${safeText(itemExercise(entry)?.name || 'Exercise')}</strong><span>${entry.skipped ? 'Skipped' : `${entry.completedSets?.length || 0}/${itemSets(entry)} sets`}</span>${!itemDone(entry) ? `<button data-action="select-next" data-index="${index}">DO NEXT</button>` : ''}</div>`).join('')}</div>
    <div class="active-controls"><button class="button button-secondary" data-action="${workout.pausedAt ? 'resume-workout' : 'pause-workout'}">${workout.pausedAt ? 'RESUME' : 'PAUSE'}</button><button class="button button-plain" data-action="finish-workout">FINISH WORKOUT</button><button class="button button-plain" data-action="discard-workout">DISCARD</button></div>`;
}
function renderCompletion(workout) {
  const duration = workoutElapsed(workout), rests = workout.restIntervals || [], xp = workout.xpEarned || 0;
  const sets = completedSets(workout), exercises = workout.items.filter(entry => (entry.completedSets || []).length).length;
  const comparisons = workout.items.filter(entry => entry.completedSets?.length).map(entry => {
    const previous = latestExerciseHistory(entry.exerciseId);
    const currentVolume = entry.completedSets.reduce((sum, set) => sum + set.weight * set.reps, 0);
    const previousVolume = previous ? (previous.completedSets || []).reduce((sum, set) => sum + set.weight * set.reps, 0) : 0;
    const delta = previous ? currentVolume > previousVolume ? 'More volume than last time' : currentVolume === previousVolume ? 'Matched last time' : 'Logged today' : 'First time logged';
    return `<div class="performance-row"><strong>${safeText(itemExercise(entry)?.name || 'Exercise')}</strong><span>${entry.completedSets.length} sets · ${delta}</span></div>`;
  }).join('');
  return `<div class="eyebrow">NICE WORK</div><div class="completion-panel"><span class="completion-mark">✓</span><h2>Session complete.</h2><p>${safeText(workout.name)}</p><div class="completion-time">${formatDuration(duration)}<small>Actual workout time · estimated ${estimateWorkout(workout.items)} min</small></div><div class="completion-stats"><div><strong>${exercises}</strong><span>Exercises</span></div><div><strong>${sets}</strong><span>Sets</span></div><div><strong>${formatNumber(volumeFor(workout))}</strong><span>lb volume</span></div></div><div class="simple-metric"><span>Average rest between sets</span><strong>${formatDuration(averageRest(rests))}</strong></div><div class="section-head"><h2>Today’s work</h2></div>${comparisons || '<p class="modal-copy">No sets were logged this time.</p>'}<div class="completion-xp"><span>＋${xp} XP earned</span><span>LEVEL ${xpLevel(Store.data.user.xp + xp)}</span></div><button class="button button-primary button-full" data-action="save-completed">SAVE &amp; FINISH</button></div>`;
}
function renderOnboarding() {
  if ($('#onboarding-root')) return;
  const root = document.createElement('div'); root.id = 'onboarding-root'; document.body.append(root); renderOnboardingStep(0);
}
function renderOnboardingStep(step) {
  const root = $('#onboarding-root'); if (!root) return;
  const user = Store.data.user;
  const title = ['What do you have to train with?', 'What do you like doing?', 'How long do you usually want to work out?'][step];
  const subtitle = ['Choose everything you have access to. You can change this any time.', 'Pick at least 8 favorites to give Quick Start enough variety. It’ll mix these with other movements, too.', 'This becomes your default Quick Start duration.'][step];
  const onboardingCategories = ['All', ...new Set(EXERCISES.flatMap(item => item.categories))];
  let body = '';
  if (step === 0) body = `<div class="choice-grid">${EQUIPMENT.map(item => `<label class="choice-card"><input type="checkbox" name="onboard-equipment" value="${item}" ${user.equipment.includes(item) ? 'checked' : ''}>${item}</label>`).join('')}</div>`;
  if (step === 1) body = `<div class="filter-pills onboarding-category-filters">${onboardingCategories.map((category, index) => `<button type="button" class="filter-pill ${index === 0 ? 'selected' : ''}" data-onboarding-category="${safeText(category)}" aria-pressed="${index === 0}">${safeText(category)}</button>`).join('')}</div><div class="exercise-choice-list">${EXERCISES.map(item => { const detailId = `onboard-exercise-description-${item.id}`; return `<div class="onboard-exercise-option" data-categories="${safeText(item.categories.join('|'))}"><button type="button" class="onboard-exercise-card" data-action="toggle-onboard-description" data-detail-id="${detailId}" aria-controls="${detailId}" aria-expanded="false"><span>${safeText(item.name)}</span><span class="onboard-exercise-indicator" aria-hidden="true">＋</span></button><label class="onboard-favorite-toggle" title="Favorite ${safeText(item.name)}"><input type="checkbox" name="onboard-favorite" value="${item.id}" aria-label="Favorite ${safeText(item.name)}" ${user.favorites.includes(item.id) ? 'checked' : ''}></label><div class="onboard-exercise-copy" id="${detailId}" hidden><p>${safeText(item.description)}</p><strong>HOW TO</strong><p>${safeText(item.howTo)}</p></div></div>`; }).join('')}</div>`;
  if (step === 2) body = `<div class="duration-grid">${DURATIONS.map(duration => `<button class="duration-option ${user.duration === duration ? 'selected' : ''}" data-duration="${duration}">${duration} min</button>`).join('')}<button class="duration-option ${!DURATIONS.includes(user.duration) ? 'selected' : ''}" data-duration="custom">Custom</button></div><div id="custom-duration-wrap" style="margin-top:12px;${DURATIONS.includes(user.duration) ? 'display:none' : ''}"><label class="field-label" for="custom-duration">Minutes</label><input class="input" id="custom-duration" type="number" min="10" max="120" value="${user.duration}"></div><div class="field-group" style="margin-top:16px"><label class="field-label" for="user-name">What should we call you? <span style="text-transform:none">(optional)</span></label><input class="input" id="user-name" maxlength="28" placeholder="Your name" value="${safeText(user.name)}"></div>`;
  root.innerHTML = `<div class="onboarding-overlay"><section class="onboarding-panel"><div class="onboard-top"><div><div class="eyebrow">SETLIST · GETTING STARTED</div><h2>${title}</h2></div><button class="button-plain" data-action="skip-onboarding">Skip for now</button></div><p class="onboard-copy">${subtitle}</p>${body}<div class="step-dots">${[0, 1, 2].map(index => `<span class="${index === step ? 'active' : ''}"></span>`).join('')}</div><div class="onboard-footer">${step > 0 ? '<button class="button-plain" data-action="onboard-back">← BACK</button>' : '<span></span>'}<button class="button button-primary" data-action="onboard-next" data-step="${step}">${step === 2 ? 'LET’S GO' : 'CONTINUE'} <span>→</span></button></div></section></div>`;
}
function openModal(html, mode = null) {
  state.modalMode = mode; document.body.classList.add('modal-open'); $('#modal-root').innerHTML = `<div class="modal-backdrop"><section class="modal-panel">${html}</section></div>`;
  if (mode === 'builder') {
    renderBuilderSelection();
    const library = $('.builder-exercises'), headings = document.createElement('div');
    headings.className = 'builder-column-headings';
    headings.innerHTML = '<span></span><span>EXERCISE</span><span>SETS</span><span>REPS</span>';
    library?.prepend(headings);
    $('.modal-actions.spread .template-meta', $('.modal-panel'))?.remove();
    linkExerciseLabels(library, $$('[data-builder-select]', library).map(input => ({ exerciseId: input.dataset.builderSelect })), '.builder-exercise', 'span');
    linkExerciseLabels($('#builder-selection'), state.builderDraft.items, '.builder-selected-row');
  }
  if (mode === 'quick-add' || mode === 'add-exercise') {
    const action = mode === 'quick-add' ? 'add-to-quick' : 'add-active-item';
    const items = $$(`[data-action="${action}"]`, $('#modal-root')).map(button => ({ exerciseId: button.dataset.id }));
    linkExerciseLabels($('#modal-root'), items, '.exercise-row', '.exercise-details strong');
  }
  if (mode === 'template-detail') linkExerciseLabels($('#modal-root'), null, '.quick-summary-row');
  if (mode === 'settings') {
    $('.preferences-note')?.remove();
    const panel = $('.modal-panel'), actions = $('.modal-actions', panel);
    if (actions) actions.className = 'preferences-actions';
    const resetButton = document.createElement('button');
    resetButton.className = 'button button-danger button-full preferences-reset';
    resetButton.dataset.action = 'reset-data';
    resetButton.textContent = 'RESET ALL SETLIST DATA';
    (actions || panel).append(resetButton);
  }
}
function closeModal() { $('#modal-root').innerHTML = ''; state.modalMode = null; state.modalReturn = null; document.body.classList.remove('modal-open'); }
function linkExerciseLabels(root, items, rowSelector, labelSelector = 'strong') {
  $$(rowSelector, root).forEach((row, index) => {
    const label = $(labelSelector, row), item = items?.[index];
    const exercise = item ? itemExercise(item) : EXERCISES.find(candidate => candidate.name === label?.textContent.trim());
    if (!exercise || !label) return;
    const button = document.createElement('button');
    button.type = 'button'; button.className = 'exercise-name-button'; button.dataset.action = 'exercise-detail'; button.dataset.id = exercise.id;
    button.textContent = label.textContent; button.setAttribute('aria-label', `View details for ${exercise.name}`);
    label.replaceWith(button);
  });
}
function quickModal() {
  openModal(`<div class="modal-heading"><div><div class="eyebrow">QUICK START</div><h2>Shape today’s session.</h2></div><button class="modal-close" data-action="close-modal">×</button></div><p class="modal-copy">A starting point, not a prescription. Change anything before you begin.</p><div class="field-group"><span class="field-label">FOCUS</span><div class="option-row">${['Full Body', 'Upper Body', 'Lower Body', 'Core', 'Custom'].map((part, index) => `<button class="option-chip ${index === 0 ? 'selected' : ''}" data-quick-part="${part}">${part}</button>`).join('')}</div></div><div class="form-row"><div class="field-group"><label class="field-label" for="quick-duration">DURATION</label><select class="select" id="quick-duration">${[15,20,30,45,60].map(item => `<option value="${item}" ${item === Store.data.user.duration ? 'selected' : ''}>${item} minutes</option>`).join('')}<option value="custom">Custom</option></select><input class="input" id="quick-custom-duration" type="number" min="10" max="120" value="${Store.data.user.duration}" style="display:none;margin-top:7px"></div><div class="field-group"><label class="field-label" for="quick-equipment">EQUIPMENT</label><select class="select" id="quick-equipment"><option value="available">My available equipment</option><option value="bodyweight">Bodyweight only</option></select></div></div><div class="modal-actions"><button class="button button-primary" data-action="generate-quick">BUILD MY WORKOUT →</button></div>`, 'quick-config');
}
function availableForEquipment(exercise, mode) {
  if (mode === 'bodyweight') return exercise.equipment.includes('Bodyweight');
  const available = Store.data.user.equipment;
  return exercise.equipment.some(item => available.includes(item)) || (exercise.equipment.includes('Bodyweight') && available.includes('Bodyweight'));
}
function focusMatches(exercise, focus) {
  if (!focus || focus === 'Full Body' || focus === 'Custom') return true;
  if (focus === 'Upper Body') return exercise.parts.some(part => ['Chest', 'Back', 'Shoulders', 'Arms'].includes(part));
  if (focus === 'Lower Body') return exercise.parts.includes('Legs');
  return exercise.parts.includes(focus);
}
function generateQuickWorkout(focus, duration, equipmentMode) {
  const history = Store.data.history;
  const usage = new Map(), recent = new Map();
  history.forEach((workout, index) => (workout.items || []).forEach(item => {
    usage.set(item.exerciseId, (usage.get(item.exerciseId) || 0) + 1);
    if (!recent.has(item.exerciseId)) recent.set(item.exerciseId, index);
  }));
  const candidates = EXERCISES.filter(exercise => focusMatches(exercise, focus) && availableForEquipment(exercise, equipmentMode));
  const chosen = [], chosenParts = new Set();
  let estimated = 0;
  while (candidates.some(exercise => !chosen.some(item => item.exerciseId === exercise.id)) && (chosen.length < 10) && (estimated < duration * 1.07 || chosen.length < 3)) {
    const options = candidates.filter(exercise => !chosen.some(item => item.exerciseId === exercise.id)).map(exercise => {
      const favorite = Store.data.user.favorites.includes(exercise.id);
      const recentIndex = recent.get(exercise.id);
      const recencyScore = recentIndex === undefined ? 22 : Math.min(30, recentIndex * 7) - 24;
      const usageScore = -Math.min(24, (usage.get(exercise.id) || 0) * 7);
      const overlap = exercise.parts.filter(part => chosenParts.has(part)).length;
      const setItem = { exerciseId: exercise.id, sets: exercise.sets, reps: exercise.reps, weight: exercise.weight, completedSets: [] };
      const addedMinutes = (exercise.work + exercise.rest) * exercise.sets / 60;
      const fitScore = estimated + addedMinutes <= duration ? 12 : -Math.min(45, (estimated + addedMinutes - duration) * 6);
      const score = (favorite ? 34 : 0) + recencyScore + usageScore - overlap * 13 + fitScore + Math.random() * 10;
      return { exercise, setItem, score, addedMinutes };
    }).sort((a, b) => b.score - a.score);
    const next = options.find(option => estimated + option.addedMinutes <= duration * 1.07) || (chosen.length < 3 ? options[0] : null);
    if (!next) break;
    chosen.push(next.setItem); estimated += next.addedMinutes; next.exercise.parts.forEach(part => chosenParts.add(part));
  }
  return { id: `quick-${Date.now()}`, name: focus === 'Custom' ? 'Quick Workout' : focus, items: chosen, uses: 0, lastUsed: null, quick: true };
}
function seedStarterWorkouts() {
  if (Store.data.workouts.length) return;
  const focuses = [
    { name: 'Full Body', focus: 'Full Body' },
    { name: 'Upper Body', focus: 'Upper Body' },
    { name: 'Lower Body', focus: 'Lower Body' }
  ];
  Store.data.workouts = focuses.map(({ name, focus }, index) => {
    let generated = generateQuickWorkout(focus, Store.data.user.duration, 'available');
    if (!generated.items.length) generated = generateQuickWorkout(focus, Store.data.user.duration, 'bodyweight');
    return { id: `starter-${index + 1}`, name, items: generated.items, uses: 0, lastUsed: null };
  }).filter(workout => workout.items.length);
}
function migrateUntouchedStarterWorkouts() {
  const original = [
    ['starter-upper', 'Upper Body + Core', ['kb-row', 'kb-press', 'face-pull', 'push-up', 'dead-bug']],
    ['starter-full', 'Full Body', ['goblet-squat', 'db-row', 'push-up', 'kb-swing', 'plank']],
    ['starter-rugby', 'Rugby Maintenance', ['kb-swing', 'reverse-lunge', 'bird-dog', 'push-up', 'side-plank']]
  ];
  const untouched = Store.data.workouts.length === original.length && Store.data.history.length === 0 && !Store.data.active && Store.data.workouts.every((workout, index) => {
    const [id, name, exerciseIds] = original[index];
    return workout.id === id && workout.name === name && !(workout.uses || 0) && workout.items.map(item => item.exerciseId).join(',') === exerciseIds.join(',');
  });
  if (untouched && Store.data.user.onboarded) { Store.data.workouts = []; seedStarterWorkouts(); Store.save(); }
}
function showQuickPreview(draft) {
  state.quickDraft = draft;
  openModal(`<div class="modal-heading"><div><div class="eyebrow">YOUR QUICK WORKOUT</div><h2>${safeText(draft.name)}</h2></div><button class="modal-close" data-action="close-modal">×</button></div><p class="modal-copy">About ${estimateWorkout(draft.items)} minutes · ${draft.items.length} exercises. Adjust the lineup or build another.</p><div class="quick-summary-list">${draft.items.map((item, index) => `<div class="quick-summary-row"><span class="quick-star">${Store.data.user.favorites.includes(item.exerciseId) ? '★' : '↗'}</span><strong>${safeText(itemExercise(item)?.name)}</strong><span>${itemSets(item)} × ${itemReps(item)}</span><button class="button-plain" data-action="remove-quick-item" data-index="${index}">REMOVE</button></div>`).join('')}</div><div class="modal-actions spread"><button class="button button-secondary" data-action="regenerate-quick">↻ REGENERATE</button><div><button class="button button-plain" data-action="add-quick-exercise">＋ ADD</button><button class="button button-primary" data-action="start-quick">START WORKOUT →</button></div></div>`, 'quick-preview');
  $$('.quick-summary-row', $('#modal-root')).forEach((row, index) => { if (row.children[2]) row.children[2].textContent = `${itemSets(draft.items[index])} × ${itemMetric(draft.items[index])}`; });
  const actions = $('.modal-actions.spread');
  if (actions) {
    const start = $('[data-action="start-quick"]', actions), regenerate = $('[data-action="regenerate-quick"]', actions), add = $('[data-action="add-quick-exercise"]', actions);
    actions.className = 'quick-workout-actions'; actions.replaceChildren(start, regenerate, add);
    start.className = 'button button-primary button-full'; regenerate.className = 'button button-secondary'; add.className = 'button button-secondary'; add.textContent = '＋ ADD EXERCISE';
  }
  linkExerciseLabels($('#modal-root'), draft.items, '.quick-summary-row');
}
function openBuilder(workout = null) {
  state.builderDraft = workout ? JSON.parse(JSON.stringify(workout)) : { id: null, name: '', items: [] };
  state.builderDraft.items = (state.builderDraft.items || []).map(item => ({ ...item, completedSets: [] }));
  showBuilder();
}
function showBuilder() {
  const draft = state.builderDraft, selected = new Set(draft.items.map(item => item.exerciseId));
  const parts = ['Full Body', 'Chest', 'Back', 'Shoulders', 'Arms', 'Legs', 'Core'];
  const chosenParts = draft.parts || ['Full Body'];
  const exercises = [...draft.items.map(item => exerciseById(item.exerciseId)).filter(Boolean), ...EXERCISES.filter(exercise => !selected.has(exercise.id) && (chosenParts.includes('Full Body') || chosenParts.some(part => exercise.parts.includes(part))) )];
  openModal(`<div class="modal-heading"><div><div class="eyebrow">WORKOUT BUILDER</div><h2>${draft.id ? 'Edit workout' : 'Make it yours.'}</h2></div><button class="modal-close" data-action="close-modal">×</button></div><p class="modal-copy">Pick your focus, then build the lineup. You can fine-tune the details later.</p><div class="field-group"><label class="field-label" for="builder-name">WORKOUT NAME</label><input class="input" id="builder-name" placeholder="e.g. Upper Body + Core" maxlength="45" value="${safeText(draft.name)}"></div><div class="field-group"><span class="field-label">FOCUS</span><div class="option-row">${parts.map(part => `<button class="option-chip ${chosenParts.includes(part) ? 'selected' : ''}" data-builder-part="${part}">${part}</button>`).join('')}</div></div><div class="form-row"><div class="field-group"><label class="field-label" for="builder-duration">TARGET DURATION</label><select class="select" id="builder-duration">${[15,20,30,45,60].map(duration => `<option value="${duration}" ${duration === (draft.duration || Store.data.user.duration) ? 'selected' : ''}>${duration} min</option>`).join('')}</select></div><div class="field-group"><label class="field-label">LINEUP</label><div style="padding-top:11px;color:var(--muted);font-size:10px"><strong id="builder-count">${draft.items.length}</strong> selected · ~<span id="builder-estimate">${estimateWorkout(draft.items)}</span> min</div></div></div><div class="builder-exercises">${exercises.map(exercise => { const item = draft.items.find(entry => entry.exerciseId === exercise.id) || { exerciseId: exercise.id, sets: exercise.sets, reps: exercise.reps, weight: exercise.weight }; return `<div class="builder-exercise ${selected.has(exercise.id) ? 'selected' : ''}" data-builder-row="${exercise.id}"><input type="checkbox" data-builder-select="${exercise.id}" ${selected.has(exercise.id) ? 'checked' : ''}><span>${safeText(exercise.name)}</span><input aria-label="Sets for ${safeText(exercise.name)}" data-builder-sets="${exercise.id}" type="number" min="1" max="10" value="${itemSets(item)}" ${selected.has(exercise.id) ? '' : 'disabled'}><input aria-label="Reps for ${safeText(exercise.name)}" data-builder-reps="${exercise.id}" type="number" min="1" max="100" value="${itemReps(item)}" ${selected.has(exercise.id) ? '' : 'disabled'}></div>`; }).join('')}</div><div class="modal-actions spread"><span class="template-meta">SETS &nbsp;&nbsp;&nbsp; REPS</span><div><button class="button button-secondary" data-action="close-modal">CANCEL</button><button class="button button-primary" data-action="save-template">SAVE WORKOUT</button></div></div>`, 'builder');
}
function updateBuilderFromModal() {
  if (!state.builderDraft) return;
  const draft = state.builderDraft, name = $('#builder-name')?.value || '';
  draft.name = name;
  draft.items = $$('[data-builder-select]').filter(input => input.checked).map(input => {
    const id = input.dataset.builderSelect;
    return { exerciseId: id, sets: Number($(`[data-builder-sets="${id}"]`)?.value) || 3, reps: Number($(`[data-builder-reps="${id}"]`)?.value) || 10, weight: exerciseById(id)?.weight || 0, completedSets: [] };
  });
  const count = $('#builder-count'), estimate = $('#builder-estimate');
  if (count) count.textContent = draft.items.length;
  if (estimate) estimate.textContent = estimateWorkout(draft.items);
  renderBuilderSelection();
}
function renderBuilderSelection() {
  const library = $('.builder-exercises'), draft = state.builderDraft;
  if (!library || !draft) return;
  let panel = $('#builder-selection');
  if (!panel) {
    panel = document.createElement('section'); panel.id = 'builder-selection'; panel.className = 'builder-selection';
    library.before(panel);
  }
  panel.innerHTML = `<div class="builder-selection-heading"><strong>SELECTED EXERCISES</strong><span>${draft.items.length} selected</span></div>${draft.items.length ? draft.items.map((item, index) => `<div class="builder-selected-row"><span class="set-index">${String(index + 1).padStart(2, '0')}</span><strong>${safeText(itemExercise(item)?.name || 'Exercise')}</strong><span class="builder-selected-count">${itemSets(item)} × ${itemReps(item)}</span><div class="builder-row-controls"><button data-action="builder-move" data-index="${index}" data-delta="-1" aria-label="Move up" ${index === 0 ? 'disabled' : ''}>↑</button><button data-action="builder-move" data-index="${index}" data-delta="1" aria-label="Move down" ${index === draft.items.length - 1 ? 'disabled' : ''}>↓</button><button data-action="builder-remove" data-index="${index}" aria-label="Remove ${safeText(itemExercise(item)?.name || 'exercise')}">×</button></div></div>`).join('') : '<p class="builder-selection-empty">Select movements below to build your lineup.</p>'}`;
  $$('.builder-selected-row', panel).forEach((row, index) => { $('.builder-selected-count', row).textContent = `${itemSets(draft.items[index])} × ${itemMetric(draft.items[index])}`; });
  linkExerciseLabels(panel, draft.items, '.builder-selected-row');
}
function showExerciseDetail(id) {
  const exercise = exerciseById(id), history = Store.data.history.flatMap(workout => (workout.items || []).filter(item => item.exerciseId === id).map(item => ({ ...item, date: workout.endedAt }))).sort((a, b) => new Date(b.date) - new Date(a.date));
  const latest = history[0], best = history.reduce((winner, item) => !winner || volumeItem(item) > volumeItem(winner) ? item : winner, null);
  const returnModal = state.modalMode === 'exercise-detail' ? state.modalReturn : state.modalMode ? { html: $('#modal-root').innerHTML, mode: state.modalMode } : null;
  openModal(`<div class="modal-heading"><div><div class="eyebrow">${safeText(exercise.parts.join(' · '))}</div><h2>${safeText(exercise.name)}</h2></div><button class="modal-close" data-action="close-modal">×</button></div><p class="modal-copy">${safeText(exercise.equipment.join(' · '))} · Suggested ${exercise.weight ? `${exercise.weight} lb × ` : ''}${exercise.reps} × ${exercise.sets}</p><div class="simple-metric"><span>Last</span><strong>${latest ? `${latest.weight || 0} lb × ${latest.reps} × ${latest.completedSets.length} · ${dateLabel(latest.date)}` : 'No history yet'}</strong></div><div class="simple-metric"><span>Best logged volume</span><strong>${best ? `${formatNumber(volumeItem(best))} lb · ${dateLabel(best.date)}` : '—'}</strong></div><div class="modal-actions"><button class="button button-secondary" data-action="favorite" data-id="${id}">${Store.data.user.favorites.includes(id) ? '★ FAVORITE' : '☆ ADD FAVORITE'}</button>${currentWorkout() ? `<button class="button button-primary" data-action="add-active-item" data-id="${id}">ADD TO WORKOUT</button>` : '<button class="button button-primary" data-action="close-modal">DONE</button>'}</div>`, 'exercise-detail');
  if (returnModal) {
    state.modalReturn = returnModal;
    $$('[data-action="close-modal"]', $('#modal-root')).forEach(button => {
      button.className = 'button button-secondary button-small'; button.dataset.action = 'back-to-previous-modal'; button.textContent = '← BACK'; button.setAttribute('aria-label', 'Back to previous list');
    });
  }
  if (exercise.unit === 'sec') $('.modal-copy', $('#modal-root')).textContent = `${exercise.equipment.join(' · ')} · Suggested ${exercise.reps} sec hold × ${exercise.sets}`;
  const instructions = document.createElement('section');
  instructions.className = 'exercise-instructions';
  const description = document.createElement('p'); description.textContent = exercise.description;
  const heading = document.createElement('h3'); heading.textContent = 'HOW TO';
  const howTo = document.createElement('p'); howTo.textContent = exercise.howTo;
  instructions.append(description, heading, howTo);
  $('.modal-copy', $('#modal-root')).after(instructions);
}
function volumeItem(item) { return (item.completedSets || []).reduce((sum, set) => sum + set.weight * set.reps, 0); }
function startWorkout(source) {
  if (currentWorkout() && !currentWorkout().completed) { closeModal(); state.view = 'active'; render(); toast('Your current workout is still in progress.'); return; }
  const workout = JSON.parse(JSON.stringify(source));
  workout.items = workout.items.map(item => {
    const exercise = itemExercise(item), previous = latestExerciseHistory(item.exerciseId);
    return { ...item, sets: item.sets ?? exercise?.sets ?? 3, reps: item.reps ?? previous?.reps ?? exercise?.reps ?? 10, weight: item.weight ?? previous?.weight ?? exercise?.weight ?? 0, completedSets: [], skipped: false };
  });
  workout.startedAt = Date.now(); workout.pausedAt = null; workout.pausedSeconds = 0; workout.currentIndex = 0; workout.restIntervals = []; workout.lastSetAt = null; workout.completed = false; workout.state = 'active';
  Store.data.active = workout;
  const template = Store.data.workouts.find(item => item.id === workout.id);
  if (template) template.lastUsed = new Date().toISOString();
  Store.save(); state.view = 'active'; closeModal(); render(); toast('Workout started. Your progress is saved as you go.');
}
function completeWorkoutState(workout) {
  if (!workout || workout.completed) return;
  workout.elapsedSeconds = workoutElapsed(workout); workout.completed = true; workout.state = 'completed'; workout.endedAt = Date.now();
  workout.xpEarned = Math.max(20, completedSets(workout) * 5 + workoutDoneItems(workout) * 10 + (workout.quick ? 5 : 0));
}
function finishWorkout() {
  const workout = currentWorkout(); if (!workout) return;
  completeWorkoutState(workout);
  state.view = 'active'; saveAndRender();
}
function saveCompletedWorkout() {
  const workout = currentWorkout(); if (!workout?.completed) return;
  const elapsed = workoutElapsed(workout);
  Store.data.history.push({ id: `completed-${Date.now()}`, name: workout.name, endedAt: new Date(workout.endedAt || Date.now()).toISOString(), duration: Math.max(1, Math.round(elapsed / 60)), items: workout.items.filter(item => item.completedSets?.length).map(item => ({ exerciseId: item.exerciseId, weight: Math.max(0, ...item.completedSets.map(set => set.weight)), reps: Math.max(0, ...item.completedSets.map(set => set.reps)), sets: item.completedSets.length, completedSets: item.completedSets })), restIntervals: workout.restIntervals || [], volume: volumeFor(workout), xp: workout.xpEarned || 0 });
  const savedSession = Store.data.history.at(-1);
  savedSession.templateId = !workout.quick && Store.data.workouts.some(template => template.id === workout.id) ? workout.id : null;
  savedSession.quick = Boolean(workout.quick);
  Store.data.user.xp += workout.xpEarned || 0; Store.data.active = null; state.view = 'home'; saveAndRender(); toast(`Session saved · +${workout.xpEarned} XP`);
}
function addItemToActive(id) {
  const workout = currentWorkout(); if (!workout || workout.items.some(item => item.exerciseId === id && !itemDone(item))) { closeModal(); toast('That movement is already in today’s lineup.'); return; }
  const exercise = exerciseById(id), last = latestExerciseHistory(id);
  workout.items.push({ exerciseId: id, sets: exercise.sets, reps: last?.reps || exercise.reps, weight: last?.weight || exercise.weight, completedSets: [] });
  if (workout.items.filter(item => !itemDone(item)).length === 1) workout.currentIndex = workout.items.length - 1;
  closeModal(); saveAndRender(); toast(`${exercise.name} added to today’s lineup.`);
}
function removeActiveItem(index) {
  const workout = currentWorkout();
  if (!workout || index < 0 || index >= workout.items.length || itemDone(workout.items[index])) return;
  workout.items.splice(index, 1);
  if (index < workout.currentIndex) workout.currentIndex--;
  else if (index === workout.currentIndex) {
    const next = workout.items.findIndex((item, itemIndex) => itemIndex >= index && !itemDone(item));
    workout.currentIndex = next >= 0 ? next : workout.items.findIndex(item => !itemDone(item));
  }
  workout.currentIndex = Math.max(0, workout.currentIndex);
  saveAndRender(); toast('Movement removed from today’s workout.');
}
function renderAddExerciseModal() {
  const workouts = currentWorkout(), ids = new Set(workouts.items.filter(item => !itemDone(item)).map(item => item.exerciseId));
  openModal(`<div class="modal-heading"><div><div class="eyebrow">ACTIVE WORKOUT</div><h2>Add a movement</h2></div><button class="modal-close" data-action="close-modal">×</button></div><p class="modal-copy">This only changes today’s session, not your saved workout.</p><label class="search-wrap"><span>⌕</span><input class="search-input" id="add-exercise-search" placeholder="Search movements"></label><div class="exercise-list" id="add-exercise-results" style="margin-top:14px">${EXERCISES.filter(exercise => !ids.has(exercise.id)).slice(0, 12).map(exercise => `<div class="exercise-row"><div class="exercise-details"><strong>${safeText(exercise.name)}</strong><small>${exercise.parts.join(' · ')}</small></div><button class="button button-secondary button-small" data-action="add-active-item" data-id="${exercise.id}">ADD</button></div>`).join('')}</div>`, 'add-exercise');
}
function refreshAddExerciseResults() {
  const query = $('#add-exercise-search')?.value.toLowerCase() || '', active = currentWorkout(), ids = new Set(active.items.filter(item => !itemDone(item)).map(item => item.exerciseId));
  const matches = EXERCISES.filter(exercise => !ids.has(exercise.id) && exercise.name.toLowerCase().includes(query)).slice(0, 15);
  $('#add-exercise-results').innerHTML = matches.length ? matches.map(exercise => `<div class="exercise-row"><div class="exercise-details"><strong>${safeText(exercise.name)}</strong><small>${exercise.parts.join(' · ')}</small></div><button class="button button-secondary button-small" data-action="add-active-item" data-id="${exercise.id}">ADD</button></div>`).join('') : '<div class="empty-state">No movements found.</div>';
  linkExerciseLabels($('#add-exercise-results'), matches.map(exercise => ({ exerciseId: exercise.id })), '.exercise-row', '.exercise-details strong');
}
function pauseWorkout() { const workout = currentWorkout(); if (!workout || workout.pausedAt) return; workout.pausedAt = Date.now(); workout.state = 'paused'; saveAndRender(); }
function resumeWorkout() { const workout = currentWorkout(); if (!workout?.pausedAt) return; workout.pausedSeconds = (workout.pausedSeconds || 0) + Date.now() - workout.pausedAt; workout.pausedAt = null; workout.state = 'active'; saveAndRender(); }
function startTicker() {
  if (state.timerHandle) return;
  state.timerHandle = setInterval(() => {
    const workout = currentWorkout(); if (!workout || workout.pausedAt) return;
    const timer = $('#workout-timer'); if (timer) timer.textContent = formatDuration(workoutElapsed(workout));
    const dockTime = $('.dock-time'); if (dockTime) dockTime.textContent = formatDuration(workoutElapsed(workout));
    const dockTitle = $('.dock-info strong'); if (dockTitle) dockTitle.textContent = `WORKOUT ACTIVE · ${formatDuration(workoutElapsed(workout))}`;
  }, 1000);
}
function stopTicker() { clearInterval(state.timerHandle); state.timerHandle = null; }
function settingsModal() {
  openModal(`<div class="modal-heading"><div><div class="eyebrow">YOUR PREFERENCES</div><h2>Make it fit you.</h2></div><button class="modal-close" data-action="close-modal">×</button></div><p class="modal-copy">Quick Start uses these to shape a session. You can always change your choices.</p><div class="field-group"><label class="field-label" for="settings-name">YOUR NAME</label><input class="input" id="settings-name" maxlength="28" value="${safeText(Store.data.user.name)}" placeholder="Your name"></div><div class="field-group"><span class="field-label">AVAILABLE EQUIPMENT</span><div class="choice-grid">${EQUIPMENT.map(item => `<label class="choice-card"><input type="checkbox" name="settings-equipment" value="${item}" ${Store.data.user.equipment.includes(item) ? 'checked' : ''}>${item}</label>`).join('')}</div></div><div class="field-group" style="margin-top:15px"><label class="field-label" for="settings-duration">DEFAULT QUICK START DURATION</label><select class="select" id="settings-duration">${DURATIONS.map(duration => `<option value="${duration}" ${duration === Store.data.user.duration ? 'selected' : ''}>${duration} minutes</option>`).join('')}</select></div><div class="preferences-note">Your workout history and preferences stay in this browser. Nothing is sent to a server.</div><div class="modal-actions"><button class="button button-primary" data-action="save-settings">SAVE PREFERENCES</button></div>`, 'settings');
}
function handleAction(action, target) {
  const id = target.dataset.id, workout = currentWorkout();
  switch (action) {
    case 'quick-start': quickModal(); break;
    case 'create-workout': openBuilder(); break;
    case 'settings': settingsModal(); break;
    case 'close-modal': closeModal(); break;
    case 'back-to-previous-modal': {
      const previous = state.modalReturn;
      if (!previous) { closeModal(); break; }
      $('#modal-root').innerHTML = previous.html; state.modalMode = previous.mode; state.modalReturn = null;
      document.body.classList.add('modal-open'); break;
    }
    case 'toggle-onboard-description': {
      const description = $(`#${target.dataset.detailId}`);
      if (!description) break;
      description.hidden = !description.hidden;
      target.setAttribute('aria-expanded', String(!description.hidden));
      $('.onboard-exercise-indicator', target).textContent = description.hidden ? '＋' : '−';
      break;
    }
    case 'toggle-favorites': state.favoritesOnly = !state.favoritesOnly; render(); break;
    case 'favorite': {
      const favorites = Store.data.user.favorites; Store.data.user.favorites = favorites.includes(id) ? favorites.filter(item => item !== id) : [...favorites, id];
      Store.save(); if (state.modalMode === 'exercise-detail') showExerciseDetail(id); else render(); break;
    }
    case 'exercise-detail': showExerciseDetail(id); break;
    case 'start-template': case 'open-template': {
      const template = Store.data.workouts.find(item => item.id === id); if (!template) break;
      if (action === 'open-template') { openModal(`<div class="modal-heading"><div><div class="eyebrow">WORKOUT TEMPLATE</div><h2>${safeText(template.name)}</h2></div><button class="modal-close" data-action="close-modal">×</button></div><p class="modal-copy">${template.items.length} exercises · estimated ${estimateWorkout(template.items)} minutes</p><div class="quick-summary-list">${template.items.map(item => `<div class="quick-summary-row"><strong>${safeText(itemExercise(item)?.name || 'Exercise')}</strong><span>${itemSets(item)} × ${itemReps(item)}</span></div>`).join('')}</div><div class="modal-actions"><button class="button button-secondary" data-action="edit-template" data-id="${id}">EDIT</button><button class="button button-primary" data-action="start-template" data-id="${id}">START WORKOUT →</button></div>`, 'template-detail'); }
      else startWorkout(template); break;
    }
    case 'edit-template': { const template = Store.data.workouts.find(item => item.id === id); if (template) openBuilder(template); break; }
    case 'delete-template': {
      const template = Store.data.workouts.find(item => item.id === id);
      if (!template) break;
      openModal(`<div class="modal-heading"><div><div class="eyebrow">WORKOUT BANK</div><h2>Delete this workout?</h2></div><button class="modal-close" data-action="close-modal">×</button></div><p class="modal-copy">${safeText(template.name)} will be removed from your workout bank. Completed sessions in history will stay.</p><div class="modal-actions"><button class="button button-secondary" data-action="close-modal">CANCEL</button><button class="button button-danger" data-action="confirm-delete-template" data-id="${safeText(id)}">DELETE WORKOUT</button></div>`, 'delete-template');
      break;
    }
    case 'confirm-delete-template':
      Store.data.workouts = Store.data.workouts.filter(template => template.id !== id);
      closeModal(); state.view = 'workouts'; saveAndRender(); toast('Workout removed from your bank.'); break;
    case 'return-workout': state.view = 'active'; closeModal(); render(); break;
    case 'generate-quick': {
      const focus = $('.option-chip.selected')?.dataset.quickPart || 'Full Body';
      const durationSelect = $('#quick-duration'), duration = durationSelect.value === 'custom' ? Math.max(10, Number($('#quick-custom-duration').value) || Store.data.user.duration) : Number(durationSelect.value);
      const generated = generateQuickWorkout(focus, duration, $('#quick-equipment').value);
      if (!generated.items.length) { toast('No matching movements found. Check your equipment preferences.'); break; }
      state.quickFocus = focus; state.quickDuration = duration; state.quickEquipment = $('#quick-equipment').value; showQuickPreview(generated); break;
    }
    case 'regenerate-quick': showQuickPreview(generateQuickWorkout(state.quickFocus, state.quickDuration, state.quickEquipment)); break;
    case 'remove-quick-item': state.quickDraft.items.splice(Number(target.dataset.index), 1); showQuickPreview(state.quickDraft); break;
    case 'add-quick-exercise': renderQuickAdd(); break;
    case 'back-quick-preview': showQuickPreview(state.quickDraft); break;
    case 'add-to-quick': { const exercise = exerciseById(id); state.quickDraft.items.push({ exerciseId: id, sets: exercise.sets, reps: exercise.reps, weight: exercise.weight }); showQuickPreview(state.quickDraft); break; }
    case 'start-quick': if (state.quickDraft.items.length) startWorkout(state.quickDraft); else toast('Add at least one movement first.'); break;
    case 'save-template': {
      updateBuilderFromModal(); const draft = state.builderDraft;
      if (!draft.name.trim()) { $('#builder-name').focus(); toast('Give your workout a name first.'); break; }
      if (!draft.items.length) { toast('Choose at least one exercise.'); break; }
      if (draft.id) { const index = Store.data.workouts.findIndex(item => item.id === draft.id); Store.data.workouts[index] = { ...Store.data.workouts[index], name: draft.name.trim(), items: draft.items }; }
      else Store.data.workouts.push({ id: `workout-${Date.now()}`, name: draft.name.trim(), items: draft.items, uses: 0, lastUsed: null });
      closeModal(); state.view = 'workouts'; saveAndRender(); toast('Workout saved to your bank.'); break;
    }
    case 'complete-set': {
      if (!workout || workout.pausedAt) break;
      const item = activeItem(workout), weight = Math.max(0, Number($('[data-set-field="weight"]')?.value ?? item.weight) || 0), reps = Math.max(1, Number($('[data-set-field="reps"]')?.value ?? item.reps) || 1), now = Date.now();
      item.weight = weight; item.reps = reps; item.completedSets ||= [];
      if (workout.lastSetAt) workout.restIntervals.push(Math.max(0, Math.round((now - workout.lastSetAt) / 1000)));
      item.completedSets.push({ weight, reps, timestamp: now }); workout.lastSetAt = now;
      saveAndRender(); break;
    }
    case 'change-sets': {
      const item = activeItem(workout); item.sets = Math.max((item.completedSets?.length || 0) + 1, Math.min(10, itemSets(item) + Number(target.dataset.delta))); saveAndRender(); break;
    }
    case 'skip-exercise': { const item = activeItem(workout); item.skipped = true; const next = workout.items.findIndex(entry => !itemDone(entry)); if (next >= 0) workout.currentIndex = next; saveAndRender(); toast('Skipped for today. Your template is unchanged.'); break; }
    case 'select-next': workout.currentIndex = Number(target.dataset.index); saveAndRender(); break;
    case 'choose-exercise': renderAddExerciseModal(); break;
    case 'add-exercise-active': renderAddExerciseModal(); break;
    case 'add-active-item': addItemToActive(id); break;
    case 'remove-active-item': removeActiveItem(Number(target.dataset.index)); break;
    case 'builder-move': {
      updateBuilderFromModal();
      const index = Number(target.dataset.index), nextIndex = index + Number(target.dataset.delta);
      if (nextIndex >= 0 && nextIndex < state.builderDraft.items.length) [state.builderDraft.items[index], state.builderDraft.items[nextIndex]] = [state.builderDraft.items[nextIndex], state.builderDraft.items[index]];
      showBuilder(); break;
    }
    case 'builder-remove': updateBuilderFromModal(); state.builderDraft.items.splice(Number(target.dataset.index), 1); showBuilder(); break;
    case 'pause-workout': pauseWorkout(); break;
    case 'resume-workout': resumeWorkout(); break;
    case 'finish-workout': finishWorkout(); break;
    case 'discard-workout': openModal(`<div class="modal-heading"><div><div class="eyebrow">ACTIVE WORKOUT</div><h2>Discard this session?</h2></div><button class="modal-close" data-action="close-modal">×</button></div><p class="modal-copy">This removes today’s progress. Your saved workout template won’t be changed.</p><div class="modal-actions"><button class="button button-secondary" data-action="close-modal">KEEP WORKING OUT</button><button class="button button-danger" data-action="confirm-discard">DISCARD SESSION</button></div>`, 'confirm-discard'); break;
    case 'confirm-discard': closeModal(); Store.data.active = null; state.view = 'home'; saveAndRender(); toast('Session discarded.'); break;
    case 'save-completed': saveCompletedWorkout(); break;
    case 'finish-without-saving': Store.data.active = null; state.view = 'home'; saveAndRender(); toast('Workout finished without saving.'); break;
    case 'skip-onboarding': Store.data.user.onboarded = true; seedStarterWorkouts(); saveAndRender(); break;
    case 'onboard-next': {
      const step = Number(target.dataset.step);
      if (step === 0) { Store.data.user.equipment = $$('[name="onboard-equipment"]:checked').map(input => input.value); renderOnboardingStep(1); }
      else if (step === 1) { Store.data.user.favorites = $$('[name="onboard-favorite"]:checked').map(input => input.value); renderOnboardingStep(2); }
      else {
        if ($('.duration-option.selected')?.dataset.duration === 'custom') Store.data.user.duration = Number($('#custom-duration')?.value) || Store.data.user.duration;
        Store.data.user.name = $('#user-name')?.value.trim() || ''; Store.data.user.onboarded = true; seedStarterWorkouts(); saveAndRender(); toast('You’re all set.');
      }
      Store.save(); break;
    }
    case 'onboard-back': { const step = Number(target.dataset.step) || 1; renderOnboardingStep(Math.max(0, step - 1)); break; }
    case 'save-settings': Store.data.user.name = $('#settings-name').value.trim(); Store.data.user.equipment = $$('[name="settings-equipment"]:checked').map(input => input.value); Store.data.user.duration = Number($('#settings-duration').value); closeModal(); saveAndRender(); toast('Preferences updated.'); break;
    case 'remove-history': {
      const session = Store.data.history.find(item => item.id === id);
      if (!session) break;
      openModal(`<div class="modal-heading"><div><div class="eyebrow">WORKOUT HISTORY</div><h2>Remove this session?</h2></div><button class="modal-close" data-action="close-modal">×</button></div><p class="modal-copy">${safeText(session.name)} · ${dateLabel(session.endedAt)}. This removes the session from your stats and synced Setlist data.</p><div class="modal-actions"><button class="button button-secondary" data-action="close-modal">CANCEL</button><button class="button button-danger" data-action="confirm-remove-history" data-id="${safeText(id)}">REMOVE SESSION</button></div>`, 'remove-history');
      break;
    }
    case 'confirm-remove-history':
      Store.data.history = Store.data.history.filter(item => item.id !== id);
      closeModal(); state.view = 'stats'; saveAndRender(); toast('Session removed from history.'); break;
    case 'reset-data': openModal(`<div class="modal-heading"><div><div class="eyebrow">RESET SETLIST</div><h2>Start over?</h2></div><button class="modal-close" data-action="close-modal">×</button></div><p class="modal-copy">This deletes your active workout, templates, workout history, XP, and preferences on this device and replaces your synced Setlist data when connected. You’ll return to onboarding. This can’t be undone.</p><div class="modal-actions"><button class="button button-secondary" data-action="close-modal">CANCEL</button><button class="button button-danger" data-action="confirm-reset-data">RESET DATA</button></div>`, 'reset-confirmation'); break;
    case 'confirm-reset-data':
      Store.data = Store.createInitialData(); Store.save();
      state.view = 'home'; state.query = ''; state.equipmentFilter = 'All equipment'; state.partFilter = 'All body parts'; state.categoryFilter = 'All categories'; state.favoritesOnly = false; state.quickDraft = null; state.builderDraft = null;
      closeModal(); saveAndRender(); toast('Setlist data reset. Start with your equipment.'); break;
  }
}
function renderQuickAdd() {
  openModal(`<div class="modal-heading"><div><div class="eyebrow">QUICK WORKOUT</div><h2>Add a movement</h2></div><button class="modal-close" data-action="close-modal">×</button></div><button class="button-plain quick-back-button" data-action="back-quick-preview">← BACK TO QUICK WORKOUT</button><p class="modal-copy">Pick an extra from your library.</p><div class="exercise-list">${EXERCISES.filter(item => !state.quickDraft.items.some(selected => selected.exerciseId === item.id)).slice(0, 18).map(item => `<div class="exercise-row"><div class="exercise-details"><strong>${safeText(item.name)}</strong><small>${item.parts.join(' · ')}</small></div><button class="button button-secondary button-small" data-action="add-to-quick" data-id="${item.id}">ADD</button></div>`).join('')}</div>`, 'quick-add');
  const backButton = $('.modal-heading .modal-close');
  backButton.className = 'button button-secondary button-small'; backButton.dataset.action = 'back-quick-preview'; backButton.textContent = '← BACK'; backButton.setAttribute('aria-label', 'Back to quick workout');
  $('.quick-back-button')?.remove();
}

document.addEventListener('click', event => {
  const onboardingCategory = event.target.closest('[data-onboarding-category]');
  if (onboardingCategory) {
    const category = onboardingCategory.dataset.onboardingCategory;
    $$('.onboarding-category-filters [data-onboarding-category]', $('#onboarding-root')).forEach(button => {
      const selected = button === onboardingCategory;
      button.classList.toggle('selected', selected); button.setAttribute('aria-pressed', String(selected));
    });
    $$('.onboard-exercise-option', $('#onboarding-root')).forEach(option => {
      option.hidden = category !== 'All' && !option.dataset.categories.split('|').includes(category);
    });
    return;
  }
  const viewButton = event.target.closest('[data-view]');
  if (viewButton) { setView(viewButton.dataset.view); return; }
  const category = event.target.closest('[data-category]');
  if (category) { state.categoryFilter = category.dataset.category; render(); return; }
  const quickPart = event.target.closest('[data-quick-part]');
  if (quickPart) { $$('.option-chip[data-quick-part]').forEach(button => button.classList.toggle('selected', button === quickPart)); return; }
  const builderPart = event.target.closest('[data-builder-part]');
  if (builderPart) {
    updateBuilderFromModal();
    const part = builderPart.dataset.builderPart, draft = state.builderDraft;
    draft.parts ||= ['Full Body'];
    if (part === 'Full Body') draft.parts = ['Full Body'];
    else { draft.parts = draft.parts.filter(item => item !== 'Full Body'); draft.parts = draft.parts.includes(part) ? draft.parts.filter(item => item !== part) : [...draft.parts, part]; if (!draft.parts.length) draft.parts = ['Full Body']; }
    showBuilder(); return;
  }
  const duration = event.target.closest('[data-duration]');
  if (duration) {
    const value = duration.dataset.duration;
    $$('.duration-option').forEach(button => button.classList.toggle('selected', button === duration));
    $('#custom-duration-wrap').style.display = value === 'custom' ? '' : 'none';
    if (value !== 'custom') Store.data.user.duration = Number(value);
    return;
  }
  const actionButton = event.target.closest('[data-action]');
  if (actionButton) { handleAction(actionButton.dataset.action, actionButton); return; }
  const selectNext = event.target.closest('[data-index]');
  if (selectNext) return;
});
document.addEventListener('input', event => {
  if (event.target.id === 'exercise-search') { state.query = event.target.value; const position = event.target.selectionStart; render(); const input = $('#exercise-search'); input.focus(); input.setSelectionRange(position, position); }
  if (event.target.id === 'add-exercise-search') refreshAddExerciseResults();
  if (event.target.id === 'quick-duration' && event.target.value === 'custom') $('#quick-custom-duration').style.display = '';
  if (event.target.matches('[data-builder-select]')) {
    const id = event.target.dataset.builderSelect, row = $(`[data-builder-row="${id}"]`);
    row.classList.toggle('selected', event.target.checked); $$(`[data-builder-sets="${id}"], [data-builder-reps="${id}"]`).forEach(input => input.disabled = !event.target.checked); updateBuilderFromModal();
  }
  if (event.target.matches('[data-builder-sets], [data-builder-reps], #builder-name')) updateBuilderFromModal();
  const setField = event.target.closest('[data-set-field]');
  if (setField && currentWorkout()) { const item = activeItem(currentWorkout()); item[setField.dataset.setField] = Number(setField.value); Store.save(); }
});
document.addEventListener('change', event => {
  if (event.target.id === 'equipment-filter') { state.equipmentFilter = event.target.value; render(); }
  if (event.target.id === 'part-filter') { state.partFilter = event.target.value; render(); }
  if (event.target.id === 'quick-duration') $('#quick-custom-duration').style.display = event.target.value === 'custom' ? '' : 'none';
});
window.addEventListener('beforeunload', () => { if (Store.data.active) Store.save(); });
function initializeCloudSync() {
  firebaseSync = createFirebaseSync({
    getLocalData: () => Store.data,
    hasLocalData: () => Store.hasLocalData,
    onRemoteData: data => {
      if (!data || !data.user || !Array.isArray(data.workouts) || !Array.isArray(data.history)) return;
      Store.data = data; Store.persistLocal();
      state.cloudStatus = 'Synced · anonymous account';
      render();
    },
    onStatus: message => {
      state.cloudStatus = message;
      const status = $('#cloud-status');
      if (status) status.textContent = message;
    }
  });
  firebaseSync.start();
}

migrateUntouchedStarterWorkouts();
render();
initializeCloudSync();