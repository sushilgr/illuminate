// Local persistence: the working scene and the quality settings.
import { SCENE_VERSION, type Quality, type SceneDescription } from '../scene/types';

const SCENE_KEY = 'illuminate.scene.v1';
const QUALITY_KEY = 'illuminate.quality.v1';
const HINT_KEY = 'illuminate.hint.v1';

/** Brings a scene from an older file version up to date; returns null if it cannot be used. */
export function migrate(raw: unknown): SceneDescription | null {
  const s = raw as Partial<SceneDescription> | null;
  if (!s || typeof s !== 'object' || !s.room || !Array.isArray(s.objects) || !s.daylight || !s.camera) return null;
  if (typeof s.version !== 'number' || s.version > SCENE_VERSION) return null;
  // Version 1 is the first published format; later versions add their steps here.
  s.version = SCENE_VERSION;
  for (const o of s.objects) { o.motions ??= []; o.visible ??= true; }
  for (const a of s.room.apertures ?? []) { a.motions ??= []; a.shutter ??= 0; }
  s.daylight.motions ??= [];
  s.loop ??= 30;
  return s as SceneDescription;
}

export function loadScene(): SceneDescription | null {
  try {
    const text = localStorage.getItem(SCENE_KEY);
    return text ? migrate(JSON.parse(text)) : null;
  } catch { return null; }
}

export function saveScene(json: string) {
  try { localStorage.setItem(SCENE_KEY, json); } catch { /* storage may be unavailable or full */ }
}

export function loadQuality(): Partial<Quality> {
  try { return JSON.parse(localStorage.getItem(QUALITY_KEY) ?? '{}'); } catch { return {}; }
}

export function saveQuality(q: Quality) {
  try { localStorage.setItem(QUALITY_KEY, JSON.stringify(q)); } catch { /* ignore */ }
}

export function hintSeen(): boolean {
  try { return localStorage.getItem(HINT_KEY) === '1'; } catch { return false; }
}
export function markHintSeen() {
  try { localStorage.setItem(HINT_KEY, '1'); } catch { /* ignore */ }
}
