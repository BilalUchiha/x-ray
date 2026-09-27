# X-Ray

**See how your codebase works.** X-Ray reads a local project folder and turns it into an
interactive map of its structure, dependencies and impact — with an optional AI layer that
answers questions using only the context X-Ray retrieves.

No Git. No GitHub. No accounts. No X-Ray server. Nothing is written into your project.

---

## Install and run

One command installs it, one command runs it. After that, `x-ray` is the only thing you need.

```bash
npm install -g github:BilalUchiha/x-ray     # once
x-ray                                        # every time after that
```

`x-ray` serves the app on loopback and **opens your browser at it**, so there is nothing to open
by hand:

```
  X-Ray is running
  ▸ http://127.0.0.1:4720/

  Open that address if the browser did not. Choose a folder there — X-Ray
  reads it, never writes to it, and nothing is uploaded.

  Ctrl+C to stop.
```

Then, in the page:

1. Click **Choose Folder** and pick any project on your machine — a Git repository is not
   required, there is no account and nothing to configure. The folder is opened read-only.
2. Watch it scan and parse, then explore the map: click a box to select it, use the `+`/`−`
   control to fold a subtree out of the way, search, and ask the AI panel a question if you have
   configured an endpoint.
3. **Explore sample project** maps a small C# service bundled with the app, if you would rather
   look around before pointing X-Ray at your own code.

Requirements are just **Node 18+** and a Chromium-based browser for the folder picker (see below),
on Windows, macOS or Linux. The first install compiles the app — `npm` runs the project's
`prepare` script — so it takes a minute; every run of `x-ray` after that starts instantly.

X-Ray is not published to the npm registry yet, so install it straight from GitHub as above.
The package name in `package.json` is `x-ray-codebase`.

<details>
<summary>Other ways to run it</summary>

```bash
# without installing anything
npx github:BilalUchiha/x-ray

# clone and run the dev server instead (hot reload)
git clone https://github.com/BilalUchiha/x-ray.git
cd x-ray
npm install
npm run dev            # http://localhost:5199
```

```bash
npm run build    # typecheck + production bundle into dist/
npm run preview  # serve the production build
```

</details>

### Command options

| Command | What it does |
|---|---|
| `x-ray` | Serve on the first free port from 4720 and open your browser |
| `x-ray --port 8080` | Serve on a specific port |
| `x-ray --no-open` | Serve without opening a browser |
| `x-ray --help` | Usage and options |
| `x-ray --version` | Installed version |

### Requirements

- **Node 18+**
- A **Chromium-based browser** (Chrome or Edge) for the native folder picker.
  - On Firefox and Safari, drag a folder onto the window instead — the drag-and-drop path uses
    `webkitGetAsEntry` and works everywhere.

### Why the command serves a local URL

Browsers only allow the folder picker (`showDirectoryPicker`) in a *secure context*, and
`http://localhost` counts as one while opening `index.html` from disk (`file://`) does not. That is
the only reason a server exists here: it serves static files, reads nothing, binds to `127.0.0.1`
so nothing else on your network can reach it, and stops when you press `Ctrl+C`.

---

## Why a web app instead of Tauri/Electron

The brief preferred Tauri. This build is a **browser application** instead, and the reason is
concrete rather than stylistic:

| | Tauri | Electron | This web app |
|---|---|---|---|
| Toolchain needed | Rust + C++ build tools | Node only | Node only |
| Buildable/verifiable in this environment | ❌ (no Rust, no MSVC) | ✅ | ✅ |
| Install footprint | ~10 MB | ~150 MB | 0 (static assets) |
| Folder access | Rust `std::fs` | Node `fs` | File System Access API |
| Credential storage | OS keychain (strong) | OS keychain via `safeStorage` | IndexedDB (weakest) |

Rust and the MSVC build tools were not installed on the target machine, so a Tauri build could
neither be compiled nor verified. Shipping an unverifiable desktop shell would have been worse
than a runnable app, so the same architecture was implemented against browser APIs:

- **Folder access** uses the File System Access API. X-Ray requests `mode: 'read'` only and
  *never* `'readwrite'`, so the browser itself guarantees the selected project cannot be modified.
- **Everything runs on the client.** There is no X-Ray backend at any point — Vite only serves
  the static assets.
- **The credential tradeoff is real and is surfaced in the UI.** Browsers expose no OS keychain
  to web pages, so API keys are stored unencrypted in this origin's IndexedDB. The Settings screen
  states this plainly rather than implying security it does not have.

The engine (`src/core`) is pure TypeScript with no DOM dependencies, so it ports cleanly to a
Rust backend behind Tauri later — only the `src/core/fs` folder-access layer would change.

## Running from a checkout

```bash
npm install
npm run dev      # http://localhost:5199, hot reload
npm run build    # typecheck + production bundle into dist/
npm start        # serve the built app exactly as the installed CLI does
```

Click **Explore sample project** to try X-Ray immediately — it analyses a small C# service
bundled with the app using the exact same engine as a real folder.

## What works

| Area | Status |
|---|---|
| Select any local folder (picker or drag & drop) | ✅ read-only |
| Recursive scan with ignore rules for `bin/ obj/ node_modules/ .git/ dist/ build/ …` | ✅ |
| C# parsing: namespaces, classes, interfaces, structs, enums, records, methods, constructors, properties, fields | ✅ real tokenizer + structural parser |
| TypeScript/JavaScript parsing: imports, classes, interfaces, functions, arrow functions | ✅ |
| Python parsing: classes, bases, methods, properties, module-level functions, f-string references | ✅ indentation-aware tokenizer + parser |
| Django projects: `apps/<name>/` packages detected as apps, so views/services/serializers do not collapse into one bucket | ✅ |
| Multi-project repositories: `.sln` + `.csproj`, `package.json`, `go.mod`, … become real projects on the map | ✅ |
| Relationships: contains, inherits, implements, references, calls, instantiates, imports | ✅ only when actually visible in the syntax |
| Interactive map: pan, zoom, hover, click, drag, search, highlighting | ✅ canvas org chart |
| Fold/unfold any box: the `+`/`−` control hides or reveals its whole subtree | ✅ |
| Drill-down from architectural layers → types → members + dependencies | ✅ |
| Codebase overview with real statistics | ✅ |
| Global search across files, classes, interfaces, methods and file contents | ✅ |
| Impact analysis ("what depends on this?") with depth 1/2/3/All | ✅ |
| OpenAI / Anthropic / OpenAI-compatible configuration + connection test | ✅ base URLs completed for you |
| Context retrieval, per-answer context disclosure with token estimate, answer → map highlighting | ✅ |
| Streaming answers with stall detection, cancellable, transcript that keeps its space | ✅ |
| Rescan, analysis warnings, per-folder stored workspaces | ✅ |

## How X-Ray decides what a project is

An "X-ray" is only useful if it shows the codebase you actually have, so structure detection is
part of the engine and its output is visible in the UI:

1. **Projects** are found from build manifests — `.csproj`/`.fsproj`/`.vbproj`, `package.json`,
   `manage.py`, `pyproject.toml`, `requirements.txt`, `go.mod`, `Cargo.toml`, `pom.xml`,
   `build.gradle`, `composer.json`, `Gemfile` — plus Django app packages (`models.py` next to
   `views.py`/`urls.py`/`serializers.py`/…). A `.sln` is treated as a container, not a project.
2. Files bind to the **innermost** project that contains them, so a solution's `src/Api/` and
   `src/Domain/` are two projects rather than one blob.
3. Where a repository holds several units of code, files no project claims bind to their top-level
   folder instead — which is what keeps a marker-less `backend/` separate from `frontend/`.
4. A folder becomes a visible node when it holds types of its own or groups two or more other
   nodes. A folder wrapping a single project is skipped, so the map never shows a redundant level.
5. Layers are computed **inside** each project. "Services" under `backend` and "Services" under
   `frontend` are different buckets, and the UI names the project each one belongs to.

The bundled fixtures under `scripts/make-fixtures.ts` (a .NET solution, a Django project, a
fullstack monorepo, and a marker-less two-sided repo) exist so all of this stays verifiable.

## Architecture

```
src/
├── core/                    # framework-free engine (portable to a Rust/Tauri backend)
│   ├── fs/                  # folder access: picker, drag & drop, bundled sample
│   ├── scanner/             # recursive walk, ignore rules, language detection
│   ├── parser/
│   │   ├── csharp/          # lexer.ts (real tokenizer) + parser.ts (structural parser)
│   │   ├── python/          # indentation-aware lexer + structural parser
│   │   └── tsjs/            # TypeScript/JavaScript parser
│   ├── analysis/            # pipeline orchestration, impact analysis
│   ├── graph/               # apps.ts (project detection), build.ts, groups.ts (layers)
│   ├── search/              # name / path / content search
│   ├── ai/                  # providers, HTTP client, context builder, chat
│   ├── settings/            # AI provider configuration
│   └── storage/             # IndexedDB: workspaces + settings
├── graph/                   # canvas renderer, hierarchical layout engine, view composition
├── state/                   # app store + actions
├── components/              # chrome, node details, markdown
└── views/                   # welcome, analysis, dashboard, panels, settings
```

**Key design points**

- **The visualization never parses source.** It consumes the `CodeGraph` built in
  `core/graph/build.ts`. Layers, drill-down and highlighting are pure view composition.
- **Call resolution is strict.** A `calls` edge is only created when the receiver can be typed
  from the syntax — a type name (`Foo.Bar()`) or a field/property with a declared type
  (`_repo.Find()`). When the receiver's type is unknown, the call is omitted rather than guessed,
  because a wrong dependency edge is worse than a missing one in an architecture tool.
- **Symbol resolution is conservative.** Ambiguous simple names resolve inside the file's own
  project first, then by nearest directory, then by namespace overlap. If nothing disambiguates
  them, no edge is created — a `User` in the backend browser never binds to the frontend's `User`.
- **The map is an org chart, read top-down.** The project sits at the top, the projects and layers
  it contains hang beneath it, and each type sits under the layer it belongs to. Every node is a
  small labelled box. Containment alone decides position, so a tangled set of dependencies can never
  scramble the shape of the codebase; relationships are drawn over the structure, not into it.
- **Children wrap into compact rows.** A layer with thirty types breaks into several short rows
  instead of one unreadable strip. A parent is always centred over its team, and the layout is
  verified collision-free (see `npm run check:fixtures`).
- **The map opens on the real code.** Detected projects and their layers are expanded on load, so
  the first thing on screen is the actual types and their dependencies. Every layer keeps its most
  connected types (a per-layer budget), and a view that would still exceed 340 nodes keeps the most
  connected ones and says so, and the initial view keeps a legibility floor — `fit` zooms out to
  the whole chart when you want it.
- **Every box can be folded away.** A `+`/`−` control on the right of any box with contents hides
  or reveals everything beneath it: fold a project or a single app in a monorepo to cut that whole
  subtree out of the map, fold one layer to get it off the screen, or open a type to see its
  members. Folding is pure view state — nothing is thrown away, so unfolding restores exactly what
  was there, including which layers and types you had already opened. "Collapse" folds the whole
  chart to the project box and "Show all layers" opens everything back up; both are verified by
  `npm run check:fixtures`, which checks that a fold hides a subtree and nothing else.
- **AI context is retrieved, never dumped.** A question becomes search terms → graph matches →
  a one-hop neighbourhood → the relevant *line ranges* of those files. The answer carries its own
  disclosure — files, components, token estimate, how much was left out — closed by default, so the
  transcript keeps the panel and nothing is hidden either.
- **The endpoint you type is completed, not sent as-is.** Provider docs show a *base* URL
  (`https://api.openai.com/v1`, `http://localhost:11434`), and posting to a base returns 404 with no
  CORS headers, which a browser can only report as “unreachable”. X-Ray appends the provider's chat
  path (`/v1/chat/completions`, `/v1/messages`), adds `http://` for local hosts, and Settings shows
  the URL the next request will actually use. `npm run check:ai` pins all 23 cases.
- **Failures say what to do.** A blocked request, a rejected preflight, a wrong port and a server
  that never answers are indistinguishable to a browser page, so the error reports the URL that was
  called and the fix for each cause — including the per-server CORS settings with your own origin
  filled in. A stream that stalls (120s to the first answer, 90s between tokens) is aborted with an
  explanation instead of hanging forever.
- **Nothing to configure to try it.** `npm run mock:ai` starts a tiny OpenAI-compatible endpoint that
  answers from the context it received, so the whole AI path — retrieval, streaming, referenced
  components, the map highlight — runs offline with no key.

## Honest limitations

- **Folder identity is name-based.** Browsers do not expose absolute paths, so a stored workspace
  is keyed by folder name and how it was opened. Two folders with the same name share a slot.
- **A stored workspace has no source.** Browser security prevents silently re-opening a folder, so
  a previously analysed project can be browsed structurally but needs the folder re-selected before
  AI answers or rescanning will work. The UI states this.
- **AI keys are not encrypted at rest.** See the credential note above; this is a browser
  limitation, not an oversight.
- **CORS.** Some providers reject direct browser requests, and no web page can work around that —
  it needs a proxy that sends CORS headers. Anthropic's Messages API needs the
  `anthropic-dangerous-direct-browser-access` header, which X-Ray sends; local servers must allow
  the origin (the error message names the exact setting for Ollama, LM Studio, vLLM and llama.cpp).
  There is no X-Ray backend, so a provider that refuses browser origins simply cannot be used.
- **Static analysis.** Impact is described as *directly / indirectly dependent* and *potentially
  affected* — reflection, DI container wiring, dynamic dispatch and callers outside the analysed
  folder cannot be known statically.
- **Layer grouping is heuristic.** Layers are inferred from naming conventions and folder names and
  are labelled as inferred, not authoritative. Layers are always scoped inside one project, so the
  same bucket name appearing twice means two projects, never one merged bucket.
- **Project detection is manifest-based.** A project is recognised by a build file
  (`.csproj`, `package.json`, `manage.py`, `pyproject.toml`, `go.mod`, `Cargo.toml`, `pom.xml`, …)
  or, for Django, by a package holding `models.py` plus a companion module. A folder with no build
  file at all is only split when its top-level folders are clearly units rather than layers.
- **Line counts are measured on the files X-Ray reads**, so unsupported and binary files are absent
  from language percentages while still being counted in the file totals.
- **Token estimates are character-based** (≈4 characters per token), not a real tokenizer.

## Privacy

- **LOCAL ANALYSIS** — your project files stay on this computer.
- AI requests are sent only to the endpoint you configure, and only when you ask a question.
- API keys are never written into the project, never stored in the graph, never logged, and never
  included in the AI context.
- The project folder is opened read-only; X-Ray creates nothing inside it.
- X-Ray makes no claims about what your chosen AI provider does with requests once they reach it.

## Development scripts

```bash
# the unit is always the same three: typecheck, build, audit
npm run typecheck && npm run build && npm run check:fixtures && npm run check:ai
```

```bash
# Inspect parser output for representative C#/TypeScript snippets
npx esbuild scripts/parser-check.ts --bundle --platform=node --format=esm --outfile=/tmp/pc.mjs && node /tmp/pc.mjs

# Run the full engine (scan → parse → graph → context → impact) over the sample project
npx esbuild scripts/engine-check.ts --bundle --platform=node --format=esm --external:node:* --outfile=/tmp/ec.mjs && node /tmp/ec.mjs

# Check how an endpoint typed into Settings is completed before a request
npm run check:ai

# A throwaway OpenAI-compatible endpoint (http://localhost:8787) for testing the AI
# layer with no provider, no key and no network — it answers from the context it received
npm run mock:ai

# Write realistic fixtures (.NET solution, Django, fullstack monorepo, marker-less) and audit
# what the map would show for each of them — stats, detected projects, layers, the default view,
# the layout invariants, and that folding a box hides exactly its own subtree
npm run check:fixtures
```

In a development build the map exposes itself to the console as `__xray` (`__xray.layout()` returns
box geometry, `__xray.transform()` the camera), because a canvas cannot be inspected the way a DOM
can. It is compiled out of production builds.

## Explicitly out of scope

Git of any kind (including reading `.git`; it is skipped only because it is irrelevant to reading
source), hosted repositories, commits/branches/PRs, uploading code anywhere, modifying the analysed
project, generating or applying code changes, autonomous agents, cloud sync, user accounts, an
X-Ray backend, and X-Ray-hosted models.

## License

MIT — see [LICENSE](LICENSE).
