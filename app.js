(function () {
  'use strict';
  const E = window.WorkoutEngine;
  const $ = selector => document.querySelector(selector);
  const escape = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
  const clone = value => JSON.parse(JSON.stringify(value));
  const uid = () => 'ex-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6);
  const DEFAULT_PROGRAM = {
    name: 'Верх тела · силовая',
    exercises: [
      { id: 'floor-press', name: 'Жим гантелей на полу', equipment: 'Две гантели по 12,38 кг', reps: ['6–10', '6–10', '6–10'], rest: 150, note: 'Обе руки одновременно. Оставляй запас чистых повторов.' },
      { id: 'row', name: 'Тяга к поясу с опорой', equipment: 'Гиря 16 кг', reps: ['8–12', '8–12', '8–12'], rest: 150, sides: true, sideRest: 90, note: 'Устойчивая опора. Повторы указаны на каждую руку.' },
      { id: 'overhead', name: 'Жим гирь вверх', equipment: 'Две гири по 6 кг', reps: ['8–12', '8–12'], rest: 150, note: 'Обычный жим, без помощи ног. Обе руки одновременно.' },
      { id: 'curl', name: 'Сгибания на бицепс', equipment: 'Две гантели по 12,38 кг / гири по 6 кг', reps: ['до 6', '6–8'], rest: 150, note: 'Первый подход с 12,38 кг — оценочный, до 6 повторов с запасом. Если слишком тяжело, второй с гирями по 6 кг на 12–15. Измени план по результату.' },
      { id: 'lateral', name: 'Подъёмы рук в стороны', equipment: 'Два диска по 1,5 кг', reps: ['10–15', '10–15'], rest: 90, note: 'Обе руки одновременно, без раскачки.' },
      { id: 'rear', name: 'Разведения в наклоне сидя', equipment: 'Два диска по 1,5 кг / без веса', reps: ['10–15'], rest: 60, note: 'Если движение с дисками не контролируется — без веса.' },
      { id: 'dead-bug', name: 'Мёртвый жук', equipment: 'Собственный вес', reps: ['10–12/сторону', '10–12/сторону'], rest: 90, note: 'Чередуй стороны в одном подходе. 10–12 на сторону — 20–24 движения всего.' }
    ]
  };
  const DEFAULT_SETTINGS = { mode: 'rounds', sound: true, vibrate: true, auto: true, wake: true };
  const STORAGE_KEY = 'krug-workout-v1:' + new URL('.', location.href).pathname;
  let program = E.normalizeProgram(DEFAULT_PROGRAM), settings = clone(DEFAULT_SETTINGS), history = [], session = null;
  let screen = 'program', summarySource = 'program', editId = null, toastTimer = null, audio = null, wakeLock = null, wakePending = false, lastSaved = 0;
  let returnFromHidden = false, savedStatus = true, wakeMessage = '', foreignChange = false;

  function formatTime(ms, countdown = false) {
    const seconds = Math.max(0, countdown ? Math.ceil(ms / 1000) : Math.floor(ms / 1000));
    const h = Math.floor(seconds / 3600), m = Math.floor(seconds / 60) % 60, s = seconds % 60;
    return (h ? h + ':' : '') + String(h ? m : Math.floor(seconds / 60)).padStart(2, '0') + ':' + String(s).padStart(2, '0');
  }
  const dateText = timestamp => new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' }).format(new Date(timestamp));
  const plural = (n, one, few, many) => n % 10 === 1 && n % 100 !== 11 ? one : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 12 || n % 100 > 14) ? few : many;
  const restText = seconds => seconds % 60 === 0 ? seconds / 60 + ' мин' : Math.floor(seconds / 60) ? Math.floor(seconds / 60) + ':' + String(seconds % 60).padStart(2, '0') : seconds + ' сек';
  function toast(message) {
    clearTimeout(toastTimer); $('#toast').textContent = message; $('#toast').hidden = false;
    toastTimer = setTimeout(() => { $('#toast').hidden = true; }, 4500);
  }
  function announce(message) { $('#announcer').textContent = message; }
  function persist(now = Date.now()) {
    if (foreignChange) return;
    if (session) session.savedAt = now;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: 1, program, settings, history, session }));
      savedStatus = true;
    } catch (_) { savedStatus = false; }
    $('#storage-warning').hidden = savedStatus;
    lastSaved = now;
  }
  function normalizeSettings(value) {
    const clean = { ...DEFAULT_SETTINGS };
    if (value && typeof value === 'object') {
      clean.mode = value.mode === 'grouped' ? 'grouped' : 'rounds';
      ['sound', 'vibrate', 'auto', 'wake'].forEach(key => { if (typeof value[key] === 'boolean') clean[key] = value[key]; });
    }
    return clean;
  }
  function normalizeHistory(input) {
    if (!Array.isArray(input)) return [];
    return input.slice(0, 50).filter(item => item && typeof item.id === 'string' && Number.isFinite(item.startedAt) && Number.isFinite(item.elapsedMs) && Array.isArray(item.results)).map(item => {
      const clean = {
        id: item.id.slice(0, 100), name: String(item.name || 'Моя программа').slice(0, 80), startedAt: item.startedAt,
        finishedAt: Number.isFinite(item.finishedAt) ? item.finishedAt : item.startedAt,
        mode: item.mode === 'grouped' ? 'grouped' : 'rounds', stopped: !!item.stopped,
        planned: Math.min(480, Math.max(1, Number(item.planned) || 1)),
        elapsedMs: Math.max(0, item.elapsedMs), restMs: Math.max(0, Number(item.restMs) || 0), transitionMs: Math.max(0, Number(item.transitionMs) || 0),
        results: item.results.slice(0, 480).map(row => ({
          exerciseId: String(row.exerciseId || '').slice(0, 70), name: String(row.name || 'Упражнение').slice(0, 120), equipment: String(row.equipment || '').slice(0, 120),
          setIndex: Math.max(0, Math.min(7, Number(row.setIndex) || 0)), side: String(row.side || '').slice(0, 10),
          reps: String(row.reps || '').slice(0, 30), actualReps: String(row.actualReps || '').slice(0, 30),
          duration: Math.max(0, Number(row.duration) || 0), partial: !!row.partial,
          group: String(row.group || '').slice(0, 80), groupLabel: String(row.groupLabel || '').slice(0, 120)
        }))
      };
      clean.workMs = clean.results.reduce((sum, row) => sum + row.duration, 0);
      clean.groups = E.groupSummary(clean); return clean;
    });
  }
  function load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const data = JSON.parse(raw);
      if (data.version !== 1) throw new Error('Неизвестный формат сохранения.');
      program = E.normalizeProgram(data.program); settings = normalizeSettings(data.settings); history = normalizeHistory(data.history);
      if (data.session) {
        try { session = E.restore(data.session); }
        catch (error) { toast(error.message); }
      }
    } catch (_) { toast('Не удалось прочитать сохранение. Открыта исходная программа.'); }
  }
  function showScreen(name, scroll = true) {
    screen = name;
    ['program', 'workout', 'summary', 'history'].forEach(key => { $('#' + key + '-screen').hidden = key !== name; });
    $('#program-dock').hidden = name !== 'program'; $('#workout-dock').hidden = name !== 'workout';
    $('#main-tabs').hidden = name === 'workout' || name === 'summary';
    $('#session-sound').hidden = name !== 'workout'; $('#header-note').hidden = name === 'workout';
    document.querySelectorAll('.tab').forEach(tab => {
      const selected = tab.dataset.action === 'tab-' + name;
      tab.classList.toggle('active', selected);
      if (selected) tab.setAttribute('aria-current', 'page'); else tab.removeAttribute('aria-current');
    });
    if (scroll) window.scrollTo({ top: 0, behavior: 'instant' });
  }
  function renderProgram() {
    const logicalSets = program.exercises.reduce((sum, ex) => sum + ex.reps.length, 0);
    const intervals = E.makeQueue(program, settings.mode).length;
    $('#program-name').value = program.name;
    $('#program-metrics').innerHTML = '<span><strong>' + program.exercises.length + '</strong> ' + plural(program.exercises.length, 'упражнение', 'упражнения', 'упражнений') + '</span><span><strong>' + logicalSets + '</strong> ' + plural(logicalSets, 'подход', 'подхода', 'подходов') + '</span><span>' + intervals + ' ' + plural(intervals, 'таймер', 'таймера', 'таймеров') + ' с учётом сторон</span>';
    const rounds = settings.mode === 'rounds';
    $('[data-action="mode-rounds"]').setAttribute('aria-pressed', rounds);
    $('[data-action="mode-grouped"]').setAttribute('aria-pressed', !rounds);
    $('#mode-description').textContent = rounds
      ? 'Один подход каждого упражнения, затем следующий круг. Если подходы упражнения закончились, дальше оно пропускается.'
      : 'Сначала все подходы одного упражнения, затем следующее. Таймер отдельно для каждого подхода.';
    const roundCount = Math.max(...program.exercises.map(ex => ex.reps.length));
    $('#start-description').textContent = rounds ? roundCount + ' ' + plural(roundCount, 'круг', 'круга', 'кругов') + ' · отдых после каждого подхода' : logicalSets + ' ' + plural(logicalSets, 'подход', 'подхода', 'подходов') + ' · в порядке списка';
    $('#exercise-list').innerHTML = program.exercises.map((ex, i) => '<article class="exercise-card" data-id="' + escape(ex.id) + '">' +
      '<div class="exercise-main"><span class="exercise-number">' + String(i + 1).padStart(2, '0') + '</span><div class="exercise-info"><h3 class="exercise-name">' + escape(ex.name) + '</h3><p class="exercise-equipment">' + escape(ex.equipment || 'Без инвентаря') + (ex.sides ? ' · на каждую руку' : '') + '</p></div><button class="icon-button edit-button" data-action="edit-exercise" aria-label="Изменить: ' + escape(ex.name) + '">✎</button></div>' +
      '<div class="exercise-bottom"><div class="rep-chips">' + ex.reps.map((rep, index) => '<span class="chip"><small>' + (index + 1) + '</small>' + escape(rep) + '</span>').join('') + '</div><span class="rest-chip">◷ ' + restText(ex.rest) + '</span></div>' +
      '<div class="exercise-tools"><button data-action="move-up" aria-label="Выше: ' + escape(ex.name) + '"' + (i === 0 ? ' disabled' : '') + '>↑ Выше</button><button data-action="move-down" aria-label="Ниже: ' + escape(ex.name) + '"' + (i === program.exercises.length - 1 ? ' disabled' : '') + '>↓ Ниже</button><button class="delete-button" data-action="delete-exercise" aria-label="Удалить: ' + escape(ex.name) + '">Удалить</button></div></article>').join('');
    ['sound', 'vibrate', 'auto', 'wake'].forEach(key => { $('#setting-' + key).checked = settings[key]; });
    $('#history-count').textContent = history.length;
  }
  function openExercise(id) {
    if (!id && program.exercises.length >= 30) return toast('В одной программе можно сохранить до 30 упражнений.');
    editId = id || null;
    const ex = program.exercises.find(item => item.id === id) || { name: '', equipment: '', reps: ['10', '10', '10'], rest: 90, sides: false, sideRest: 60, note: '' };
    const form = $('#exercise-form'); form.reset();
    $('#exercise-dialog-title').textContent = id ? 'Изменить упражнение' : 'Новое упражнение';
    ['name', 'equipment', 'rest', 'sideRest', 'note'].forEach(key => { form.elements[key].value = ex[key]; });
    form.elements.sets.value = ex.reps.length; form.elements.sides.checked = ex.sides;
    $('#side-rest-field').hidden = !ex.sides;
    renderRepsFields(ex.reps);
    $('#exercise-dialog').showModal();
    // Prevent the mobile keyboard from covering the sheet when editing an existing item.
    if (id) $('#exercise-dialog [data-action="close-exercise"]').focus();
  }
  function renderRepsFields(values) {
    $('#reps-fields').innerHTML = values.map((value, i) => '<label>Подход ' + (i + 1) + '<input name="rep-' + i + '" aria-label="Повторы, подход ' + (i + 1) + '" required maxlength="30" value="' + escape(value) + '"></label>').join('');
  }
  function ask(title, description, yes = 'Подтвердить') {
    return new Promise(resolve => {
      const dialog = $('#confirm-dialog');
      $('#confirm-title').textContent = title; $('#confirm-description').textContent = description; $('#confirm-yes').textContent = yes;
      let settled = false;
      const done = value => { if (settled) return; settled = true; dialog.close(); resolve(value); };
      $('#confirm-yes').onclick = () => done(true); $('#confirm-no').onclick = () => done(false);
      dialog.oncancel = event => { event.preventDefault(); done(false); };
      dialog.showModal(); $('#confirm-no').focus();
    });
  }
  function unlockAudio() {
    try {
      const Audio = window.AudioContext || window.webkitAudioContext;
      if (!Audio) return false;
      if (!audio) audio = new Audio();
      if (audio.state === 'suspended') audio.resume().catch(() => {});
      return true;
    } catch (_) { return false; }
  }
  function signal(kind = 'rest', force = false) {
    if (settings.vibrate && navigator.vibrate) navigator.vibrate(kind === 'start' ? 80 : [130, 70, 130]);
    if ((!settings.sound && !force) || !unlockAudio()) return;
    try {
      const time = audio.currentTime;
      const notes = kind === 'start' ? [660] : kind === 'done' ? [523.25, 659.25, 783.99] : [660, 880];
      notes.forEach((frequency, i) => {
        const oscillator = audio.createOscillator(), gain = audio.createGain(), at = time + i * .19;
        oscillator.type = 'sine'; oscillator.frequency.value = frequency;
        gain.gain.setValueAtTime(0, at); gain.gain.linearRampToValueAtTime(.16, at + .015); gain.gain.exponentialRampToValueAtTime(.001, at + .24);
        oscillator.connect(gain); gain.connect(audio.destination); oscillator.start(at); oscillator.stop(at + .25);
      });
    } catch (_) { /* Timer operation does not depend on audio availability. */ }
  }
  async function requestWake() {
    if (!settings.wake || !session || session.paused || document.hidden || wakeLock || wakePending) return;
    if (!('wakeLock' in navigator)) { wakeMessage = 'Автовыключение экрана регулируется настройками телефона.'; return; }
    wakePending = true;
    try {
      const lock = await navigator.wakeLock.request('screen');
      if (!session || session.paused || document.hidden || !settings.wake) { await lock.release(); return; }
      wakeLock = lock;
      wakeMessage = 'Экран остаётся включённым';
      lock.addEventListener('release', () => { if (wakeLock === lock) { wakeLock = null; wakeMessage = 'Удержание экрана выключено'; } });
    } catch (_) { wakeMessage = 'Телефон не разрешил удерживать экран включённым.'; }
    finally { wakePending = false; if ($('#wake-status')) $('#wake-status').textContent = wakeMessage; }
  }
  async function releaseWake() {
    try { if (wakeLock) await wakeLock.release(); } catch (_) { /* Feature is optional. */ }
    wakeLock = null;
  }
  function renderWorkout() {
    if (!session) return;
    const now = Date.now(), work = session.phase === 'work';
    const shownIndex = work ? session.index : Math.min(session.index + 1, session.queue.length - 1);
    const item = session.queue[shownIndex];
    $('#workout-screen').dataset.phase = session.phase;
    $('#session-position').textContent = item.groupLabel + ' · подход ' + (item.setIndex + 1) + '/' + item.setCount;
    const completed = session.results.filter(row => !row.partial).length;
    $('#session-counter').textContent = completed + ' / ' + session.queue.length;
    const percent = Math.round(completed / session.queue.length * 100);
    $('#session-progress').setAttribute('aria-valuenow', percent); $('#progress-fill').style.width = percent + '%';
    $('#phase-label').textContent = session.paused ? 'ТРЕНИРОВКА НА ПАУЗЕ' : work ? 'ВЫПОЛНЯЙ ПОДХОД' : session.phase === 'rest' ? 'ОТДЫХ · ДАЛЕЕ' : 'ПРИГОТОВЬСЯ';
    $('#current-name').textContent = item.name;
    $('#current-tags').innerHTML = '<span class="target-tag">' + escape(item.reps) + ' повт.</span>' + (item.side ? '<span>' + escape(item.side) + ' рука</span>' : '') + (item.equipment ? '<span>' + escape(item.equipment) + '</span>' : '');
    $('#current-note').textContent = item.note; $('#current-note').hidden = !item.note;
    $('#actual-reps-label').hidden = !work; $('#actual-reps').value = session.actualReps;
    $('#actual-reps').disabled = session.paused;
    $('#extend-button').hidden = session.phase !== 'rest';
    $('#paused-label').hidden = !session.paused;
    $('#pause-button').textContent = session.paused ? '▶ Продолжить' : 'Ⅱ Пауза';
    $('#primary-workout').textContent = session.paused ? 'Продолжить тренировку' : work ? 'Закончить подход' : session.phase === 'rest' ? 'Закончить отдых →' : 'Начать подход →';
    $('#session-sound').textContent = settings.sound ? '♪' : '♪̸';
    $('#session-sound').setAttribute('aria-label', settings.sound ? 'Выключить звук' : 'Включить звук');
    $('#session-sound').setAttribute('aria-pressed', settings.sound);
    const current = session.queue[session.index], next = session.queue[shownIndex + 1];
    $('#next-label').textContent = work ? 'ДАЛЕЕ' : 'ЗАТЕМ';
    $('#next-name').textContent = next ? next.name + (next.side ? ' · ' + next.side.toLowerCase() + ' рука' : '') : 'Финиш тренировки';
    $('#next-detail').textContent = next ? next.reps + ' повт. · ' + next.groupLabel + ' · подход ' + (next.setIndex + 1) : 'Все результаты сохранятся в истории';
    const groupEnded = !work && current.group !== session.queue[session.index + 1]?.group;
    $('#round-complete').hidden = !groupEnded;
    if (groupEnded) {
      const total = E.groupSummary(session).find(group => group.id === current.group);
      $('#round-complete').innerHTML = escape(current.groupLabel) + ' завершён <strong>' + formatTime(total?.workMs || 0) + ' работы</strong>';
    }
    $('#stat-round-label').textContent = session.mode === 'rounds' ? current.groupLabel.toLowerCase() : 'упражнение';
    $('#wake-status').textContent = wakeMessage;
    updateClocks(now);
  }
  function updateClocks(now) {
    if (!session || screen !== 'workout') return;
    const work = session.phase === 'work', manual = session.phase === 'ready' && !session.auto;
    const time = work ? E.phaseElapsed(session, now) : E.remaining(session, now);
    $('#timer-value').textContent = manual ? 'Готов?' : formatTime(time, !work);
    $('#timer-caption').textContent = session.paused ? 'таймер на паузе' : work ? 'время выполнения' : session.phase === 'rest' ? 'до конца отдыха' : manual ? 'начни, когда будешь готов' : 'до автоматического старта';
    const fraction = work ? 1 : manual ? 1 : Math.min(1, time / session.phaseDuration);
    $('#timer-arc').style.strokeDashoffset = (741.42 * (1 - fraction)).toFixed(2);
    const previous = session.results.reduce((sum, row) => sum + row.duration, 0);
    const currentWork = work ? E.phaseElapsed(session, now) : 0;
    const group = session.queue[session.index].group;
    const groupTime = session.results.filter(row => row.group === group).reduce((sum, row) => sum + row.duration, 0) + currentWork;
    $('#stat-work').textContent = formatTime(previous + currentWork);
    $('#stat-round').textContent = formatTime(groupTime);
    $('#stat-total').textContent = formatTime(E.elapsed(session, now));
    document.title = (session.paused ? 'Пауза' : formatTime(time, !work)) + ' · ' + (work ? 'Подход' : session.phase === 'rest' ? 'Отдых' : 'Старт') + ' — Круг';
  }
  function syncSession(now = Date.now()) {
    if (!session) return;
    const oldPhase = session.phase, oldIndex = session.index;
    E.tick(session, now, !document.hidden);
    if (session.phase !== oldPhase || session.index !== oldIndex) {
      if (!document.hidden) {
        if (session.phase === 'ready') { signal('rest'); announce('Отдых завершён. ' + (session.auto ? 'Следующий подход через десять секунд.' : 'Можно начинать следующий подход.')); }
        if (session.phase === 'work') { signal('start'); announce(session.queue[session.index].name + '. Начало подхода.'); }
      }
      persist(now); renderWorkout();
    } else updateClocks(now);
    if (now - lastSaved >= 1000 && !document.hidden && !session.paused) persist(now);
  }
  function completeSession() {
    const record = E.toHistory(session, Date.now());
    history = [record, ...history.filter(row => row.id !== record.id)].slice(0, 50);
    session = null; persist(); releaseWake(); signal('done');
    renderProgram(); showSummary(record, 'program'); document.title = 'Тренировка завершена — Круг';
  }
  function startSession() {
    unlockAudio();
    session = E.create(program, settings, Date.now());
    persist(); showScreen('workout'); renderWorkout(); requestWake(); announce('Тренировка началась. ' + session.queue[0].name);
  }
  function primaryAction() {
    if (!session) return;
    const wasReady = session.phase === 'ready';
    unlockAudio(); syncSession();
    // A tap exactly at automatic start must not immediately finish the new set.
    if (wasReady && session.phase === 'work') return;
    if (session.paused) { foreignChange = false; E.resume(session, Date.now()); requestWake(); }
    else if (session.phase === 'work') {
      E.finishSet(session, Date.now(), $('#actual-reps').value);
      if (session.phase === 'done') return completeSession();
      announce(session.phase === 'rest' ? 'Подход завершён. Отдых.' : 'Приготовься к следующему подходу.');
      if (session.phase === 'ready') signal('rest');
    } else if (session.phase === 'rest') { E.skipRest(session, Date.now()); signal('rest'); }
    else { E.startNext(session, Date.now()); signal('start'); }
    persist(); renderWorkout();
  }
  function togglePause() {
    if (!session) return;
    unlockAudio(); syncSession();
    if (session.paused) { foreignChange = false; E.resume(session, Date.now()); requestWake(); announce('Тренировка продолжается.'); }
    else { E.pause(session, Date.now()); releaseWake(); announce('Тренировка на паузе.'); }
    persist(); renderWorkout();
  }
  async function stopSession() {
    if (!session) return;
    const wasPaused = session.paused;
    if (!wasPaused) E.pause(session, Date.now());
    releaseWake(); persist(); renderWorkout();
    if (await ask('Завершить тренировку?', 'Сделанное сохранится в истории. Текущий незаконченный подход будет отмечен отдельно.', 'Завершить')) {
      foreignChange = false;
      E.end(session, Date.now()); completeSession();
    } else if (!wasPaused) { E.resume(session, Date.now()); persist(); renderWorkout(); requestWake(); }
  }
  function showSummary(record, from) {
    summarySource = from;
    const completed = record.results.filter(row => !row.partial).length;
    $('#summary-eyebrow').textContent = record.stopped ? 'ТРЕНИРОВКА ОСТАНОВЛЕНА' : 'ТРЕНИРОВКА ЗАВЕРШЕНА';
    $('#summary-title').textContent = record.stopped ? 'Сделанное сохранено.' : 'Хорошая работа.';
    $('#summary-date').textContent = record.name + ' · ' + dateText(record.startedAt);
    $('#summary-metrics').innerHTML = [
      [formatTime(record.workMs), 'чистое время работы'], [formatTime(record.elapsedMs), 'занятие без пауз'],
      [completed + ' / ' + record.planned, 'таймеров выполнено'], [formatTime(record.restMs + record.transitionMs), 'отдых и подготовка']
    ].map(([value, label]) => '<div><strong>' + value + '</strong><span>' + label + '</span></div>').join('');
    $('#summary-groups-title').textContent = record.mode === 'rounds' ? 'Время работы по кругам' : 'Время работы по упражнениям';
    $('#summary-groups').innerHTML = record.groups.map(group => '<div class="group-row"><span>' + escape(group.label) + '</span><strong>' + formatTime(group.workMs) + '</strong></div>').join('') || '<p class="helper">Рабочие подходы ещё не выполнены.</p>';
    const exerciseIds = [...new Set(record.results.map(row => row.exerciseId))];
    $('#summary-results').innerHTML = exerciseIds.map(id => {
      const rows = record.results.filter(row => row.exerciseId === id);
      return '<div class="result-exercise"><h3>' + escape(rows[0].name) + '</h3>' + rows.map(row => '<div class="result-row"><span>' + (row.setIndex + 1) + '. ' + (row.side ? escape(row.side) + ' · ' : '') + (row.partial ? 'незавершённый · ' : '') + (row.actualReps ? escape(row.actualReps) + ' повт.' : 'план ' + escape(row.reps)) + '</span><strong>' + formatTime(row.duration) + '</strong></div>').join('') + '</div>';
    }).join('');
    $('[data-action="summary-back"]').textContent = from === 'history' ? 'К истории' : 'К программе';
    showScreen('summary');
  }
  function renderHistory() {
    $('#history-count').textContent = history.length;
    $('#history-list').innerHTML = history.length ? history.map(record => '<button class="history-card" data-action="open-history" data-record="' + escape(record.id) + '"><span class="eyebrow">' + escape(dateText(record.startedAt)) + (record.stopped ? ' · ОСТАНОВЛЕНА' : '') + '</span><h2>' + escape(record.name) + '</h2><div><span><strong>' + formatTime(record.workMs) + '</strong> работы</span><span>' + record.results.filter(row => !row.partial).length + ' / ' + record.planned + ' таймеров</span><span aria-hidden="true">↗</span></div></button>').join('') : '<div class="empty-state">Здесь появится первая тренировка.<br>Сначала — первый подход.</div>';
  }
  function downloadBackup() {
    const data = { app: 'krug-workout', version: 1, exportedAt: new Date().toISOString(), program, settings, history };
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = 'krug-backup-' + new Date().toISOString().slice(0, 10) + '.json';
    document.body.append(anchor); anchor.click(); anchor.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  async function importBackup(file) {
    if (!file) return;
    try {
      if (file.size > 5 * 1024 * 1024) throw new Error('Файл слишком большой. Нужна копия JSON до 5 МБ.');
      const data = JSON.parse(await file.text());
      if (data.app !== 'krug-workout' || data.version !== 1) throw new Error('Это не резервная копия приложения «Круг».');
      const newProgram = E.normalizeProgram(data.program), newSettings = normalizeSettings(data.settings), newHistory = normalizeHistory(data.history);
      if (await ask('Загрузить копию?', 'Текущие программа, настройки и история в этом браузере будут заменены данными из файла.', 'Загрузить')) {
        program = newProgram; settings = newSettings; history = newHistory; persist(); renderProgram(); toast('Программа и история загружены.');
      }
    } catch (error) { toast(error instanceof SyntaxError ? 'Не удалось прочитать JSON. Выбери скачанную резервную копию.' : error.message); }
    finally { $('#import-file').value = ''; }
  }

  document.addEventListener('click', async event => {
    const button = event.target.closest('[data-action]');
    if (!button || button.disabled) return;
    const action = button.dataset.action, id = button.closest('[data-id]')?.dataset.id;
    try {
      if (action === 'tab-program') { renderProgram(); showScreen('program'); document.title = 'Круг — твоя тренировка'; }
      else if (action === 'tab-history') { renderHistory(); showScreen('history'); document.title = 'История — Круг'; }
      else if (action.startsWith('mode-')) { settings.mode = action.slice(5); persist(); renderProgram(); }
      else if (action === 'add-exercise') openExercise();
      else if (action === 'edit-exercise') openExercise(id);
      else if (action === 'close-exercise') $('#exercise-dialog').close();
      else if (action === 'delete-exercise') {
        if (program.exercises.length === 1) return toast('Оставь хотя бы одно упражнение в программе.');
        if (await ask('Удалить упражнение?', program.exercises.find(ex => ex.id === id).name, 'Удалить')) {
          program.exercises = program.exercises.filter(ex => ex.id !== id); persist(); renderProgram();
        }
      } else if (action === 'move-up' || action === 'move-down') {
        const i = program.exercises.findIndex(ex => ex.id === id), j = i + (action === 'move-up' ? -1 : 1);
        if (j >= 0 && j < program.exercises.length) {
          [program.exercises[i], program.exercises[j]] = [program.exercises[j], program.exercises[i]];
          persist(); renderProgram();
          // Keep keyboard focus on the moved exercise.
          [...document.querySelectorAll('.exercise-card')].find(card => card.dataset.id === id)?.querySelector('[data-action="edit-exercise"]').focus({ preventScroll: true });
        }
      } else if (action === 'test-sound') { signal('rest', true); toast('Сигнал включён. Если тихо — проверь громкость и беззвучный режим.'); }
      else if (action === 'export') downloadBackup();
      else if (action === 'import') $('#import-file').click();
      else if (action === 'start') startSession();
      else if (action === 'workout-primary') primaryAction();
      else if (action === 'pause') togglePause();
      else if (action === 'end-workout') await stopSession();
      else if (action === 'extend-rest' && session) { E.extendRest(session, 30000); persist(); renderWorkout(); }
      else if (action === 'open-history') {
        const record = history.find(row => row.id === button.dataset.record); if (record) showSummary(record, 'history');
      } else if (action === 'summary-back') {
        renderProgram(); renderHistory(); showScreen(summarySource); document.title = 'Круг — твоя тренировка';
      }
    } catch (error) { console.error(error); toast('Не получилось выполнить действие. ' + error.message); }
  });
  $('#exercise-form').addEventListener('submit', event => {
    event.preventDefault(); const form = event.currentTarget;
    const count = Math.max(1, Math.min(8, Number(form.elements.sets.value) || 1));
    const exercise = {
      id: editId || uid(), name: form.elements.name.value.trim(), equipment: form.elements.equipment.value,
      reps: Array.from({ length: count }, (_, i) => form.elements['rep-' + i]?.value || '10'),
      rest: Number(form.elements.rest.value), sides: form.elements.sides.checked, sideRest: Number(form.elements.sideRest.value), note: form.elements.note.value
    };
    if (!exercise.name) { form.elements.name.focus(); return; }
    const index = program.exercises.findIndex(ex => ex.id === editId);
    if (index >= 0) program.exercises[index] = exercise; else program.exercises.push(exercise);
    program = E.normalizeProgram(program); persist(); renderProgram(); $('#exercise-dialog').close(); toast('Упражнение сохранено.');
  });
  $('#exercise-form').elements.sets.addEventListener('change', event => {
    const count = Math.max(1, Math.min(8, Number(event.target.value) || 1)); event.target.value = count;
    const values = [...$('#reps-fields').querySelectorAll('input')].map(input => input.value);
    renderRepsFields(Array.from({ length: count }, (_, i) => values[i] || values.at(-1) || '10'));
  });
  $('#exercise-form').elements.sides.addEventListener('change', event => { $('#side-rest-field').hidden = !event.target.checked; });
  $('#program-name').addEventListener('input', event => { program.name = event.target.value.trim() || 'Моя программа'; persist(); });
  $('#program-name').addEventListener('blur', () => { $('#program-name').value = program.name; });
  ['sound', 'vibrate', 'auto', 'wake'].forEach(key => $('#setting-' + key).addEventListener('change', event => { settings[key] = event.target.checked; persist(); }));
  $('#actual-reps').addEventListener('input', event => { if (session) { session.actualReps = event.target.value; persist(); } });
  $('#session-sound').addEventListener('click', () => { settings.sound = !settings.sound; unlockAudio(); persist(); renderWorkout(); });
  $('#import-file').addEventListener('change', event => importBackup(event.target.files[0]));
  $('#brand-link').addEventListener('click', event => {
    event.preventDefault();
    if (session) return toast('Тренировка идёт. Для остановки используй кнопку внизу.');
    renderProgram(); showScreen('program'); document.title = 'Круг — твоя тренировка';
  });
  document.addEventListener('visibilitychange', () => {
    const now = Date.now();
    if (document.hidden) { returnFromHidden = true; if (session) persist(now); }
    else if (session) {
      E.tick(session, now, false);
      if (returnFromHidden && session.phase === 'ready' && !session.paused) {
        session.transitionMs += E.phaseElapsed(session, now);
        session.phaseStartedAt = now; signal('rest');
        toast(session.auto ? 'До следующего подхода 10 секунд.' : 'Отдых завершён. Можно начинать.');
      }
      returnFromHidden = false; persist(now); renderWorkout(); requestWake();
    }
  });
  window.addEventListener('pagehide', () => { if (session) persist(); });
  // Protect against two tabs overwriting a running workout on the same device.
  window.addEventListener('storage', event => {
    if (event.key !== STORAGE_KEY) return;
    if (session) { foreignChange = true; E.pause(session, Date.now()); renderWorkout(); releaseWake(); toast('Данные изменились в другой вкладке. Продолжай тренировку только в одной.'); }
    else toast('Данные изменились в другой вкладке. Обнови страницу, чтобы их увидеть.');
  });
  load(); renderProgram();
  if (session) { showScreen('workout'); renderWorkout(); toast('Тренировка восстановлена на паузе. Время после закрытия не добавлено.'); }
  else showScreen('program', false);
  setInterval(() => { if (session) syncSession(); }, 200);
})();
