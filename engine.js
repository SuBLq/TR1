/* Pure timer state machine. No browser dependencies; also used by the tests. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.WorkoutEngine = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const copy = value => JSON.parse(JSON.stringify(value));
  const number = (value, min, max, fallback) => Number.isFinite(Number(value))
    ? Math.min(max, Math.max(min, Math.round(Number(value)))) : fallback;
  const str = (value, length = 120) => String(value ?? '').trim().slice(0, length);

  function normalizeProgram(input) {
    if (!input || !Array.isArray(input.exercises) || !input.exercises.length) throw new Error('В программе нет упражнений.');
    const seen = new Set();
    const exercises = input.exercises.slice(0, 30).map((item, index) => {
      if (!item || !str(item.name)) throw new Error('У каждого упражнения должно быть название.');
      const baseId = str(item.id, 60) || 'exercise-' + index;
      let id = baseId, suffix = 0;
      while (seen.has(id)) id = baseId + '-' + index + '-' + (++suffix);
      seen.add(id);
      if (!Array.isArray(item.reps) || !item.reps.length) throw new Error('Укажите повторы хотя бы для одного подхода.');
      return {
        id, name: str(item.name), equipment: str(item.equipment), note: str(item.note, 500),
        reps: item.reps.slice(0, 8).map(value => str(value, 30) || '10'),
        rest: number(item.rest, 0, 900, 90), sides: !!item.sides,
        sideRest: number(item.sideRest, 0, 900, 60)
      };
    });
    return { name: str(input.name, 80) || 'Моя программа', exercises };
  }

  function makeQueue(program, mode) {
    const queue = [];
    function add(ex, setIndex) {
      const sides = ex.sides ? ['Правая', 'Левая'] : [''];
      sides.forEach((side, sideIndex) => queue.push({
        exerciseId: ex.id, name: ex.name, equipment: ex.equipment, note: ex.note,
        setIndex, setCount: ex.reps.length, reps: ex.reps[setIndex], side,
        rest: ex.sides && sideIndex === 0 ? ex.sideRest : ex.rest,
        group: mode === 'rounds' ? 'round-' + setIndex : ex.id,
        groupLabel: mode === 'rounds' ? 'Круг ' + (setIndex + 1) : ex.name
      }));
    }
    if (mode === 'grouped') program.exercises.forEach(ex => ex.reps.forEach((_, i) => add(ex, i)));
    else for (let round = 0; round < Math.max(...program.exercises.map(ex => ex.reps.length)); round++) {
      program.exercises.forEach(ex => { if (ex.reps[round] !== undefined) add(ex, round); });
    }
    return queue;
  }

  function create(program, settings, now) {
    const clean = normalizeProgram(program);
    const mode = settings.mode === 'grouped' ? 'grouped' : 'rounds';
    return {
      version: 1, id: 'session-' + now + '-' + Math.random().toString(36).slice(2, 8),
      name: clean.name, mode, auto: settings.auto !== false,
      queue: makeQueue(clean, mode), index: 0, results: [],
      phase: 'work', phaseStartedAt: now, phaseDuration: 0,
      startedAt: now, finishedAt: null, paused: false, pausedAt: null, pauseMs: 0,
      restMs: 0, transitionMs: 0, actualReps: '', stopped: false, savedAt: now
    };
  }
  function phaseElapsed(state, now) {
    return Math.max(0, (state.paused ? state.pausedAt : now) - state.phaseStartedAt);
  }
  function elapsed(state, now) {
    return Math.max(0, (state.finishedAt ?? (state.paused ? state.pausedAt : now)) - state.startedAt - state.pauseMs);
  }
  function remaining(state, now) { return Math.max(0, state.phaseDuration - phaseElapsed(state, now)); }
  function phase(state, name, now, duration = 0) {
    state.phase = name; state.phaseStartedAt = now; state.phaseDuration = duration;
  }
  function startNext(state, now) {
    if (state.phase !== 'ready' || state.paused) return false;
    state.transitionMs += phaseElapsed(state, now);
    state.index++; state.actualReps = '';
    phase(state, 'work', now);
    return true;
  }
  function tick(state, now, allowAutoStart = true) {
    if (!state || state.paused || state.phase === 'done') return false;
    if (state.phase === 'rest' && remaining(state, now) === 0) {
      state.restMs += phaseElapsed(state, now);
      // Start the preparation window when the callback actually runs, so a
      // sleeping phone never invents work time for an exercise not yet started.
      phase(state, 'ready', now, 10000);
      return true;
    }
    if (state.phase === 'ready' && remaining(state, now) === 0 && state.auto && allowAutoStart) return startNext(state, now);
    return false;
  }
  function finishSet(state, now, actualReps = '') {
    if (state.phase !== 'work' || state.paused) return false;
    state.results.push({ ...copy(state.queue[state.index]), duration: phaseElapsed(state, now), actualReps: str(actualReps, 30), partial: false });
    state.actualReps = '';
    if (state.index === state.queue.length - 1) {
      state.finishedAt = now; phase(state, 'done', now);
    } else {
      const rest = state.queue[state.index].rest * 1000;
      phase(state, rest ? 'rest' : 'ready', now, rest || 10000);
    }
    return true;
  }
  function skipRest(state, now) {
    if (state.phase !== 'rest' || state.paused) return false;
    state.restMs += phaseElapsed(state, now);
    phase(state, 'ready', now, 10000);
    return true;
  }
  function extendRest(state, milliseconds) {
    if (state.phase !== 'rest') return false;
    state.phaseDuration += milliseconds; return true;
  }
  function pause(state, now) {
    if (state.paused || state.phase === 'done') return false;
    state.paused = true; state.pausedAt = now; return true;
  }
  function resume(state, now) {
    if (!state.paused || state.phase === 'done') return false;
    const duration = Math.max(0, now - state.pausedAt);
    state.phaseStartedAt += duration; state.pauseMs += duration;
    state.paused = false; state.pausedAt = null; return true;
  }
  function end(state, now) {
    if (state.phase === 'done') return false;
    const effective = state.paused ? state.pausedAt : now;
    if (state.phase === 'work' && phaseElapsed(state, now) > 0) {
      state.results.push({ ...copy(state.queue[state.index]), duration: phaseElapsed(state, now), actualReps: str(state.actualReps, 30), partial: true });
    } else if (state.phase === 'rest') state.restMs += phaseElapsed(state, now);
    else if (state.phase === 'ready') state.transitionMs += phaseElapsed(state, now);
    state.finishedAt = effective; state.paused = false; state.pausedAt = null;
    state.stopped = true; phase(state, 'done', effective); return true;
  }
  function groupSummary(state) {
    const groups = [];
    state.results.forEach(result => {
      let group = groups.find(item => item.id === result.group);
      if (!group) { group = { id: result.group, label: result.groupLabel, workMs: 0, completed: 0 }; groups.push(group); }
      group.workMs += result.duration;
      if (!result.partial) group.completed++;
    });
    return groups;
  }
  function toHistory(state, now) {
    return {
      id: state.id, name: state.name, startedAt: state.startedAt, finishedAt: state.finishedAt,
      mode: state.mode, stopped: state.stopped, planned: state.queue.length,
      elapsedMs: elapsed(state, now), workMs: state.results.reduce((total, row) => total + row.duration, 0),
      restMs: state.restMs, transitionMs: state.transitionMs,
      results: copy(state.results), groups: groupSummary(state)
    };
  }
  function restore(input) {
    if (!input || input.version !== 1 || !['work', 'rest', 'ready'].includes(input.phase)
      || !Array.isArray(input.queue) || !input.queue.length || input.queue.length > 480
      || !Array.isArray(input.results) || input.results.length > input.queue.length
      || !Number.isInteger(input.index) || input.index < 0 || input.index >= input.queue.length
      || ![input.startedAt, input.phaseStartedAt, input.savedAt, input.pauseMs, input.restMs, input.transitionMs, input.phaseDuration].every(Number.isFinite)
      || (input.paused && !Number.isFinite(input.pausedAt))) throw new Error('Не удалось восстановить таймер. Программа сохранена.');
    const state = copy(input);
    // A reload is a deliberate recovery on pause, never an unattended restart.
    if (!state.paused) pause(state, state.savedAt);
    return state;
  }
  return { normalizeProgram, makeQueue, create, phaseElapsed, elapsed, remaining, tick, finishSet, startNext, skipRest, extendRest, pause, resume, end, groupSummary, toHistory, restore };
});
