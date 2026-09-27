// Folder access layer.
//
// X-Ray reads folders through the browser's File System Access API using
// mode: 'read' ONLY. X-Ray never requests 'readwrite', so the browser itself
// enforces that the selected project cannot be modified. Nothing is written
// back into the project — all X-Ray data lives in IndexedDB.
//
// A drag-and-drop fallback (webkitGetAsEntry) is provided for browsers that do
// not expose showDirectoryPicker, plus a bundled sample project so the app can
// be explored without touching any folder at all.

export interface SourceFile {
  path: string;
  name: string;
  size?: number;
  readText: () => Promise<string>;
}

export interface SourceDir {
  name: string;
  path: string;
  list: () => Promise<SourceEntry[]>;
}

export type SourceEntry =
  | { kind: 'file'; file: SourceFile }
  | { kind: 'dir'; dir: SourceDir };

export interface FolderSource {
  /** How the folder was obtained. */
  origin: 'picker' | 'drop' | 'sample';
  /** Root directory name, used as the workspace label. */
  name: string;
  root: SourceDir;
  handle?: unknown;
}

function join(parent: string, name: string): string {
  return parent ? `${parent}/${name}` : name;
}

// --- File System Access API ------------------------------------------------

interface FsDirectoryHandle {
  kind: 'directory';
  name: string;
  values: () => AsyncIterableIterator<FsFileHandle | FsDirectoryHandle>;
}

interface FsFileHandle {
  kind: 'file';
  name: string;
  getFile: () => Promise<File>;
}

type DirectoryPicker = (options?: {
  mode?: 'read' | 'readwrite';
  id?: string;
  startIn?: string;
}) => Promise<FsDirectoryHandle>;

export function supportsDirectoryPicker(): boolean {
  return typeof (window as unknown as { showDirectoryPicker?: unknown }).showDirectoryPicker === 'function';
}

/** Opens the native folder picker. Read-only: the project can never be modified. */
export async function pickFolder(): Promise<FolderSource | null> {
  const picker = (window as unknown as { showDirectoryPicker?: DirectoryPicker }).showDirectoryPicker;
  if (!picker) throw new Error('This browser cannot open a folder picker.');
  let handle: FsDirectoryHandle;
  try {
    handle = await picker({ mode: 'read', id: 'xray-project' });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') return null;
    throw err;
  }
  return {
    origin: 'picker',
    name: handle.name,
    root: dirFromHandle(handle, ''),
    handle,
  };
}

function dirFromHandle(handle: FsDirectoryHandle, path: string): SourceDir {
  return {
    name: handle.name,
    path,
    list: async () => {
      const entries: SourceEntry[] = [];
      for await (const child of handle.values()) {
        const childPath = join(path, child.name);
        if (child.kind === 'directory') {
          entries.push({ kind: 'dir', dir: dirFromHandle(child, childPath) });
        } else {
          entries.push({ kind: 'file', file: fileFromHandle(child, childPath) });
        }
      }
      return entries;
    },
  };
}

function fileFromHandle(handle: FsFileHandle, path: string): SourceFile {
  return {
    path,
    name: handle.name,
    readText: async () => {
      const file = await handle.getFile();
      return file.text();
    },
  };
}

// --- Drag and drop fallback ------------------------------------------------

interface LegacyEntry {
  isFile: boolean;
  isDirectory: boolean;
  name: string;
  fullPath: string;
  file: (cb: (f: File) => void, err: (e: unknown) => void) => void;
  createReader: () => {
    readEntries: (cb: (entries: LegacyEntry[]) => void, err: (e: unknown) => void) => void;
  };
}

export function folderFromDataTransfer(dt: DataTransfer): FolderSource | null {
  const items = Array.from(dt.items ?? []);
  for (const item of items) {
    if (item.kind !== 'file') continue;
    const getEntry = (item as unknown as { webkitGetAsEntry?: () => LegacyEntry | null }).webkitGetAsEntry;
    const entry = getEntry?.call(item);
    if (entry && entry.isDirectory) {
      const rootPath = '';
      return {
        origin: 'drop',
        name: entry.name,
        root: dirFromEntry(entry, rootPath),
      };
    }
  }
  return null;
}

function dirFromEntry(entry: LegacyEntry, path: string): SourceDir {
  return {
    name: entry.name,
    path,
    list: async () => {
      const reader = entry.createReader();
      const all: LegacyEntry[] = [];
      // readEntries returns at most 100 entries per call and must be drained.
      for (;;) {
        const batch = await new Promise<LegacyEntry[]>((resolve, reject) => {
          reader.readEntries(resolve, reject);
        });
        if (batch.length === 0) break;
        all.push(...batch);
      }
      return all.map((child) => {
        const childPath = join(path, child.name);
        if (child.isDirectory) return { kind: 'dir', dir: dirFromEntry(child, childPath) } as SourceEntry;
        return { kind: 'file', file: fileFromEntry(child, childPath) } as SourceEntry;
      });
    },
  };
}

function fileFromEntry(entry: LegacyEntry, path: string): SourceFile {
  return {
    path,
    name: entry.name,
    readText: () =>
      new Promise<string>((resolve, reject) => {
        entry.file((file) => {
          file.text().then(resolve, reject);
        }, reject);
      }),
  };
}

// --- Bundled sample project ------------------------------------------------

/** Builds a source tree from a manifest of files bundled with the app. */
export function folderFromManifest(name: string, files: string[]): FolderSource {
  const root: SourceDir = {
    name,
    path: '',
    list: async () => buildEntries(name, files, ''),
  };
  return { origin: 'sample', name, root };
}

function buildEntries(rootName: string, files: string[], prefix: string): SourceEntry[] {
  const dirs = new Map<string, string[]>();
  const here: SourceEntry[] = [];
  for (const file of files) {
    if (!file.startsWith(prefix)) continue;
    const rest = file.slice(prefix.length);
    const slash = rest.indexOf('/');
    if (slash === -1) {
      here.push({
        kind: 'file',
        file: {
          path: file,
          name: rest,
          readText: async () => {
            const res = await fetch(`sample-project/${file}`);
            if (!res.ok) throw new Error(`Cannot read ${file}`);
            return res.text();
          },
        },
      });
    } else {
      const dir = rest.slice(0, slash);
      const key = `${prefix}${dir}/`;
      const list = dirs.get(key) ?? [];
      list.push(file);
      dirs.set(key, list);
    }
  }
  for (const [key, list] of dirs) {
    here.push({
      kind: 'dir',
      dir: {
        name: key.slice(prefix.length, -1),
        path: `${prefix}${key.slice(prefix.length, -1)}`,
        list: async () => buildEntries(rootName, list, key),
      },
    });
  }
  here.sort((a, b) => {
    const an = a.kind === 'file' ? a.file.name : a.dir.name;
    const bn = b.kind === 'file' ? b.file.name : b.dir.name;
    if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1;
    return an.localeCompare(bn);
  });
  return here;
}
