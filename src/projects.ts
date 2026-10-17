// Projects saved in this browser (IndexedDB). Nothing leaves the device.
export interface SavedProject { id: string; name: string; updated: number; thumb: string; data: unknown }
export type ProjectInfo = Omit<SavedProject, 'data'>;

const DB = 'layercraft', STORE = 'projects';
let dbp: Promise<IDBDatabase> | null = null;
function db(): Promise<IDBDatabase> {
  if (!dbp) dbp = new Promise((res, rej) => {
    try {
      const r = indexedDB.open(DB, 1);
      r.onupgradeneeded = () => { if (!r.result.objectStoreNames.contains(STORE)) r.result.createObjectStore(STORE, { keyPath: 'id' }); };
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    } catch (e) { rej(e); }
  });
  return dbp;
}
function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return db().then((d) => new Promise<T>((res, rej) => {
    const t = d.transaction(STORE, mode), req = fn(t.objectStore(STORE));
    req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error);
  }));
}
export const saveProject = (p: SavedProject) => tx('readwrite', (s) => s.put(p)).then(() => true, () => false);
export const getProject = (id: string) => tx<SavedProject | undefined>('readonly', (s) => s.get(id)).catch(() => undefined);
export const deleteProject = (id: string) => tx('readwrite', (s) => s.delete(id)).then(() => true, () => false);
export async function listProjects(): Promise<ProjectInfo[]> {
  try {
    const all = await tx<SavedProject[]>('readonly', (s) => s.getAll());
    return all.map(({ data: _d, ...info }) => info).sort((a, b) => b.updated - a.updated);
  } catch { return []; }
}
export const newId = () => (crypto.randomUUID ? crypto.randomUUID() : `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`);
