# dash-fullcalendar — Premium-enabled fork

This is a patched fork of [`dash-fullcalendar`](https://github.com/ScottTpirate/dash-fullcalendar)
(PyPI `dash-fullcalendar` 0.1.3). It exists for one reason: to make FullCalendar
**Premium** (Scheduler) resource views actually work in Plotly Dash.

Fork version: **`0.1.3+premium`**.

## The problem with upstream 0.1.3

Upstream advertises premium support via "dynamic lazy-loading of premium
plugins when a license key is provided." In practice the published 0.1.3 wheel
**cannot render any premium view**:

- The shipped `dash_fullcalendar/dash_fullcalendar.min.js` bundles only the
  **free** plugins (`daygrid`, `timegrid`, `list`, `multimonth`, `interaction`).
- The premium plugins (`resource-timeline`, `resource-timegrid`, `resource`,
  `scrollgrid`) were loaded with a webpack lazy `import()`. Webpack splits those
  into separate **async chunk files** that are **never included** in the
  published package (and `_js_dist` only registers the main bundle).
- At runtime the dynamic import therefore fails and the wrapper's `catch`
  swallows the error. The premium view initialises with no matching plugin and
  renders **nothing** — silently.

This was verified empirically: a free `dayGridMonth` calendar renders, while a
`resourceTimelineWeek` calendar (correct `schedulerLicenseKey` + correct
`plugins` strings) produces an empty container, and no resource-timeline chunk
is ever requested from the server.

## The fix

Bundle the premium plugins **statically** so they ship inside the single
`dash_fullcalendar.min.js` that the package actually serves.

File: `src/lib/components/FullCalendar.react.js`

**Added static imports:**

```js
import resourceTimelinePlugin from "@fullcalendar/resource-timeline";
import resourceTimeGridPlugin from "@fullcalendar/resource-timegrid";
import resourcePlugin from "@fullcalendar/resource";
import scrollGridPlugin from "@fullcalendar/scrollgrid";
```

**Replaced** the asynchronous dynamic-`import()` block (a `useState` +
`useEffect` that fetched the now-missing chunks) **with** a synchronous
`useMemo` that resolves the requested plugin name-strings against the
statically-imported plugin objects:

```js
const premiumPlugins = useMemo(() => {
    if (!schedulerLicenseKey || !Array.isArray(userPlugins)) {
        return [];
    }
    const nameToPlugin = {
        scrollgrid: scrollGridPlugin,
        resourcetimeline: resourceTimelinePlugin,
        resourcetimegrid: resourceTimeGridPlugin,
        resource: resourcePlugin
    };
    const resolved = userPlugins
        .filter((p) => typeof p === 'string')
        .map((s) => String(s).replace(/[-_\s]/g, '').toLowerCase())
        .map((n) => nameToPlugin[n])
        .filter(Boolean);
    return [...new Set(resolved)];
}, [userPlugins, schedulerLicenseKey]);
```

The public API is unchanged: premium activates only when a
`schedulerLicenseKey` is supplied, and plugins are still requested by the same
name-strings (`"resourceTimeline"`, `"resourceTimeGrid"`, `"resource"`,
`"scrollgrid"`). The only behavioural change is that the plugins are now present
in the bundle instead of being fetched from non-existent chunks.

Version was bumped to `0.1.3+premium` in `package.json` and
`dash_fullcalendar/package-info.json`.

### `eventDrop` resource info

`handleEventDrop` was extended to include the resource (e.g. trainer) an event
was dragged between, which the upstream payload omitted. Without this, a Dash
callback cannot tell whether a dragged event changed resource:

```js
eventDrop: {
    event: serializeEvent(info.event),
    oldEvent: serializeEvent(info.oldEvent),
    delta: serializeDuration(info.delta),
    relatedEvents: info.relatedEvents.map(serializeEvent),
    oldResource: info.oldResource ? info.oldResource.id : null,
    newResource: info.newResource ? info.newResource.id : null
}
```

`oldResource` / `newResource` are the resource ids and are only populated by
FullCalendar when the resource actually changed (null otherwise).

## Interactive additions (`0.1.4+premium`)

Added for a calendar PoC (drag-to-reschedule with confirm/revert, plus
hover tooltips). All in `src/lib/components/FullCalendar.react.js`.

**New `command` types** (the imperative bridge; previously only
`next`/`prev`/`today`/`changeView`):

- `{type: "updateEvent", id, resourceId?, start?, end?}` — move/reschedule an
  existing event by id. `resourceId` moves it between resources (e.g. trainers)
  via `event.setResource()`; `start`/`end` (ISO strings) reschedule it via
  `event.setDates()`. Either part may be omitted.
- `{type: "revert"}` — undo the most recent drag/resize. `handleEventDrop` and
  `handleEventResize` stash FullCalendar's own `info.revert` callback in a
  `useRef`; this command invokes it (one-shot). This is the native way to bounce
  an event back after a rejected move — no need to re-feed the `events` prop.

> Dash only re-runs the command effect when the `command` object changes by
> reference, so callers should include a nonce/counter to make repeated commands
> (e.g. two reverts in a row) distinct.

**New Dash callback props** `eventMouseEnter` / `eventMouseLeave` (for hover
tooltips). These already existed in `propTypes` as `PropTypes.func` but a raw
`func` prop is **dropped** by `dash-generate-components` (functions can't cross
the Python↔JS boundary), so they never reached Dash callbacks. They are now
typed `PropTypes.any` and backed by handlers that `setProps` a serialized
payload (`eventMouseEnter` includes `extendedProps` and `jsEvent.pageX/pageY`
for positioning; `eventMouseLeave` sends `{id}`). The two props are also
destructured out of the forwarded `calendarProps` so the stale data value is not
passed to FullCalendar as an option.

## Command API correction (`0.1.5+premium`)

The `0.1.4+premium` `updateEvent` command called **`event.setResource(id)`**,
which is **not a FullCalendar method** — `EventApi` has no `setResource`. The
resource plugin provides **`setResources(resourceIds[])`** (plural, array). The
broken call threw at runtime, so resource moves/redirects via `command` silently
did nothing (the event only appeared to move because of FullCalendar's
optimistic drag).

Rather than patch `updateEvent`, the umbrella command was **split into commands
named 1:1 after the real `EventApi` methods** (it was a fork-only command with no
external consumers, so there was no compatibility cost):

- `{type: "setResources", id, resourceIds: ['<id>', ...]}` → `event.setResources(resourceIds)`
- `{type: "setDates", id, start, end?}` → `event.setDates(start, end)`

`{type: "revert"}` (→ `info.revert()`) is unchanged. Every command type now maps
to a genuine FullCalendar API method; no invented methods remain. An audit of
the other command calls (`next`/`prev`/`today`/`changeView`/`getEventById`/
`getApi`/`setDates`/`info.revert`) confirmed they are all valid — `setResource`
was the only non-existent call.

## Per-event decoration seam (`0.2.0`)

Consumers that want to decorate an *individual* calendar block (a conflict badge,
a colored outline on one event) had no supported hook for it. The only way to find
a specific block's DOM element was `el.fcSeg.eventRange.def.publicId` — a
FullCalendar **internal**. And the only per-event styling channel was whatever the
consumer had encoded into the event `title`, which means a full rebuild of the
`events` prop (and a full calendar re-render) for every state change.

Three additions close that gap **declaratively**, so nothing has to cross the
Python↔JS boundary as a function:

- **`data-event-id` on every block.** An internal `eventDidMount` stamps
  `data-event-id="<event.id>"` on the `.fc-event` root, so wrapper JS can use
  `document.querySelector('[data-event-id="…"]')` instead of `el.fcSeg`. Events
  with an empty id are skipped, so `[data-event-id]` stays a meaningful selector.
- **`extendedProps.classNames`.** An internal `eventClassNames` reads that array
  off each event and applies it as classes on the block. FullCalendar
  re-evaluates `eventClassNames` when an event's data changes, so state can be
  toggled by updating only the affected events. (FullCalendar's native
  *top-level* `classNames` key on an event object keeps working and is merged in
  by FullCalendar itself; this adds `extendedProps` as a second, equivalent
  channel so decoration state can live with the rest of a payload.)
- **`eventDataAttributes`** (new prop) — a list of `extendedProps` keys to mirror
  onto the block root as `data-*`. Keys are kebab-cased so `courseCode` becomes
  `data-course-code` / `el.dataset.courseCode`; `None`/missing values are
  skipped and objects are JSON-encoded. This is what lets consumer JS read event
  data off the DOM rather than out of FullCalendar internals.

Both hooks follow the wrapper's existing convention for options it implements
itself: the incoming prop is destructured out of the forwarded `calendarProps`
under a `user*` alias, and the internal handler **composes** that value in rather
than clobbering it — a caller-supplied `eventClassNames` (string, array, or
function) is concatenated ahead of the `extendedProps` classes, and a
caller-supplied `eventDidMount` runs after the attributes are stamped. `plugins`
is destructured the same way for the premium resolution above; treat that as the
pattern for any future option skinnycal needs to own.

> ⚠️ `eventDataAttributes` mirrors at **mount**. Replacing the `events` prop
> re-parses the source, so blocks remount and the attributes refresh — that is
> the normal Dash path. In-place `EventApi` mutations (the `setDates` /
> `setResources` commands, drag, resize) reuse the existing element and do *not*
> re-run the mount hook. They also do not change `extendedProps`, so the mirrors
> can't go stale in practice, but don't mirror a key you intend to mutate that
> way.

`eventDidMount` itself remains `PropTypes.func`, i.e. invisible to Dash — which
is correct, since a Dash caller could never supply a function anyway. It is only
reachable from the React demo in `src/demo`.

## Building

Requires Node.js (built with Node 24 LTS / npm 11).

```bash
npm install
npm run build      # build:js (webpack) + build:backends (dash-generate-components)
```

**`build:backends` IS required whenever props change** (it regenerates
`FullCalendar.py` / `metadata.json` so new props land in `_prop_names`). The
earlier premium-only patch could skip it because no props changed; the
`0.1.4+premium` additions changed props, so the full `build` is needed.

> ⚠️ **Spaces-in-path gotcha (Windows).** `dash-generate-components` shells out
> to `node <extract-meta.js>` with the path to `extract-meta.js` **unquoted**
> (dash `component_generator.py`). When that path (inside the consuming venv's
> `site-packages/dash/`) contains spaces — as some consumer checkouts do — `node`
> receives a truncated path and fails with `Cannot find module`. Work around it
> without editing dash by running the backend step through a **space-free NTFS
> junction** to the venv-bearing repo, e.g.:
>
> ```powershell
> New-Item -ItemType Junction -Path C:\appwf   -Target "<...>\git"
> New-Item -ItemType Junction -Path C:\dfcfork  -Target "<...>\dash-fullcalendar-fork"
> ```
> ```bash
> cd /c/dfcfork
> MODULES_PATH="$(pwd)/node_modules" NODE_PATH=node_modules \
>   /c/appwf/.venv/Scripts/python.exe -m dash.development.component_generator \
>   ./src/lib/components dash_fullcalendar -p package-info.json \
>   --r-prefix '' --jl-prefix '' --ignore '\.test\.'
> ```
> Invoking the junctioned `python.exe` makes `importlib.resources.files("dash")`
> resolve to the no-space `C:\appwf\...` path, so `extract-meta.js` runs.

Build the Python wheel. The consumer venv used during development is uv-managed and ships **no `pip` or PyPA
`build` frontend**, and `import build` from this directory would shadow-import
the local `build/` folder — so use the legacy setuptools path with `wheel`
installed via `uv pip` (which works on this Windows machine where `uv build` /
`uv run` subprocess spawning does not):

```bash
uv pip install --python <venv>/Scripts/python.exe wheel
<venv>/Scripts/python.exe setup.py bdist_wheel --dist-dir dist
# -> dist/dash_fullcalendar-0.1.4+premium-py3-none-any.whl
```

After the build the bundle contains the premium symbols
(`resourceTimeline`, `fc-datagrid`, `resourceAreaColumns`, `schedulerLicenseKey`)
plus the new `updateEvent` / `revert` / `eventMouseEnter` symbols, and emits a
single `.min.js` with no async chunk files.

## How a consumer project consumes this

The built wheel can be vendored into a consuming repo at
`vendor/wheels/dash_fullcalendar-0.1.3+premium-py3-none-any.whl` and referenced
from the root `pyproject.toml`:

```toml
[tool.uv.sources]
dash-fullcalendar = {path = "vendor/wheels/dash_fullcalendar-0.1.3+premium-py3-none-any.whl"}
```

To ship a new build: rebuild the wheel here, copy it into the consumer's
`vendor/wheels/`, update the source path if the filename changes, and
`uv sync`.

## Licensing note

This wrapper is MIT (© Scott Kilgore, upstream). The **bundled** `@fullcalendar`
premium plugin code is governed by FullCalendar's own license. The
`GPL-My-Project-Is-Open-Source` and `CC-Attribution-NonCommercial-NoDerivatives`
keys are valid only for open-source / non-commercial evaluation. **Commercial or
internal-business production use requires a purchased FullCalendar
Scheduler commercial license.**
