// The editable scene: one description, a selection, and an undo history of snapshots.
import type { SceneDescription, SceneObject } from './types';

export type Selection =
  | { type: 'none' }
  | { type: 'object'; id: string }
  | { type: 'aperture'; id: string }
  | { type: 'room' | 'daylight' | 'atmosphere' | 'camera' | 'finish' };

export type ChangeKind = 'structure' | 'values' | 'selection' | 'load';
type Listener = (kind: ChangeKind) => void;

const LIMIT = 120;

export class SceneDocument {
  scene: SceneDescription;
  selection: Selection = { type: 'none' };
  private undoStack: string[] = [];
  private redoStack: string[] = [];
  private pending: string | null = null;
  private pendingKey = '';
  private listeners = new Set<Listener>();

  constructor(scene: SceneDescription) { this.scene = scene; }

  on(fn: Listener) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  private emit(kind: ChangeKind) { for (const fn of this.listeners) fn(kind); }

  /**
   * Applies an edit. Edits that share a `key` and arrive without an intervening `commit()`
   * (a slider drag, a gizmo drag) collapse into one undo step.
   */
  edit(mutate: (s: SceneDescription) => void, kind: 'structure' | 'values' = 'values', key = '') {
    if (this.pending === null || key === '' || key !== this.pendingKey) {
      this.commit();
      this.pending = JSON.stringify(this.scene);
      this.pendingKey = key;
    }
    mutate(this.scene);
    if (key === '') this.commit();
    this.emit(kind);
  }

  /** Closes the current undo step. */
  commit() {
    if (this.pending !== null) {
      if (this.pending !== JSON.stringify(this.scene)) {
        this.undoStack.push(this.pending);
        if (this.undoStack.length > LIMIT) this.undoStack.shift();
        this.redoStack.length = 0;
      }
      this.pending = null;
      this.pendingKey = '';
    }
  }

  get canUndo() { return this.undoStack.length > 0 || this.pending !== null; }
  get canRedo() { return this.redoStack.length > 0; }

  undo() {
    this.commit();
    const prev = this.undoStack.pop();
    if (!prev) return;
    this.redoStack.push(JSON.stringify(this.scene));
    this.scene = JSON.parse(prev);
    this.fixSelection();
    this.emit('load');
  }

  redo() {
    this.commit();
    const next = this.redoStack.pop();
    if (!next) return;
    this.undoStack.push(JSON.stringify(this.scene));
    this.scene = JSON.parse(next);
    this.fixSelection();
    this.emit('load');
  }

  /** Replaces the whole scene (preset, import). Undoable. */
  load(scene: SceneDescription, undoable = true) {
    this.commit();
    if (undoable) this.undoStack.push(JSON.stringify(this.scene));
    this.redoStack.length = 0;
    this.scene = scene;
    this.selection = { type: 'none' };
    this.emit('load');
  }

  select(sel: Selection) {
    this.commit();
    this.selection = sel;
    this.emit('selection');
  }

  private fixSelection() {
    const s = this.selection;
    if (s.type === 'object' && !this.object(s.id)) this.selection = { type: 'none' };
    if (s.type === 'aperture' && !this.scene.room.apertures.some((a) => a.id === s.id)) this.selection = { type: 'none' };
  }

  object(id: string): SceneObject | undefined { return this.scene.objects.find((o) => o.id === id); }
  get selectedObject(): SceneObject | undefined { return this.selection.type === 'object' ? this.object(this.selection.id) : undefined; }
  get selectedAperture() { const s = this.selection; return s.type === 'aperture' ? this.scene.room.apertures.find((a) => a.id === s.id) : undefined; }
}
