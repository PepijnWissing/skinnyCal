# skinnycal

A lightweight Plotly Dash wrapper around **[@fullcalendar/react](https://fullcalendar.io/docs/react)**, with the FullCalendar **Premium (Scheduler)** plugins statically bundled so resource views work out of the box.

Forked from [`dash-fullcalendar`](https://github.com/ScottTpirate/dash-fullcalendar). See [`PREMIUM_FORK_CHANGES.md`](PREMIUM_FORK_CHANGES.md) for the full rationale and diff notes.

---

## Installation

```bash
pip install skinnycal
```

PyPI distribution and Python import name are both `skinnycal`.

---

## Quick start

```python
from dash import Dash, html
import skinnycal as dcal

app = Dash(__name__)

app.layout = html.Div([
    dcal.FullCalendar(
        id="cal",
        initialView="dayGridMonth",
        editable=True,
        selectable=True,
        events=[
            {"title": "Audit", "date": "2025-08-01"},
            {"title": "Go-Live", "date": "2025-08-10"},
        ],
    )
])

if __name__ == "__main__":
    app.run(debug=True)
```

Open <http://127.0.0.1:8050> in your browser.

### Premium (Scheduler) views

Pass a valid `schedulerLicenseKey` and request a resource view — the premium plugins are already in the bundle, no async chunk fetch:

```python
dcal.FullCalendar(
    id="cal",
    schedulerLicenseKey="GPL-My-Project-Is-Open-Source",  # or your commercial key
    plugins=["resourceTimeline", "interaction"],
    initialView="resourceTimelineWeek",
    resources=[{"id": "a", "title": "Room A"}, {"id": "b", "title": "Room B"}],
    events=[{"resourceId": "a", "title": "Kickoff", "start": "2025-08-01"}],
)
```

---

## Repository layout

| Path | Purpose |
|------|---------|
| `skinnycal/` | Python package published to PyPI. Contains generated Dash component classes and pre-compiled JS assets (`_js_dist`). |
| `src/` | Raw React source for the wrapper. |
| `package.json`, `webpack.config.js` | JS build pipeline (`npm run build`). |
| `usage.py` | Minimal Dash demo. |
| `tests/` | Integration tests with `dash[testing]` & `pytest`. |
| `.github/workflows/` | CI workflow that builds and publishes to PyPI on push to `main`. |

---

## Development

1. **Clone** and install dependencies

   ```bash
   git clone https://github.com/PepijnWissing/skinnyCal.git
   cd skinnyCal
   npm install
   python -m venv .venv && . .venv/Scripts/activate   # POSIX: source .venv/bin/activate
   pip install -r requirements.txt
   ```

2. **Build** and run the example

   ```bash
   npm run build        # webpack + dash-generate-components
   pip install -e .
   python usage.py      # open http://localhost:8050
   ```

3. **Run tests**

   ```bash
   pytest -q
   ```

---

## Releasing

Publishing is automated: any push to `main` triggers `.github/workflows/publish.yml`, which builds an sdist + wheel and uploads to PyPI via [Trusted Publishing (OIDC)](https://docs.pypi.org/trusted-publishers/). Pushes that don't bump the version are no-ops (`skip-existing: true`).

To cut a release, bump the version in **all three** places (they must stay in sync — `__version__` is read from `package-info.json` at import time):

- `pyproject.toml` → `[project].version`
- `skinnycal/package-info.json` → `version`
- `package.json` → `version`

Then commit and push to `main`.

---

## License

MIT © Scott Kilgore (upstream wrapper). Bundled `@fullcalendar` premium plugin code is governed by [FullCalendar's own license](https://fullcalendar.io/license) — commercial production use requires a purchased Scheduler license.
